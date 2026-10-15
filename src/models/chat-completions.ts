import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ModelRequestSchema, ModelResponseSchema, NormalizedProviderError, type ModelAdapter, type ModelRequest, type ModelResponse,
} from "./contracts.ts";

/**
 * Adapter for OpenAI-compatible /chat/completions endpoints (Ollama, NVIDIA NIM, Gemini compat, OpenRouter).
 * The transport is injected so contract tests need no network.
 */
const toolCallSchema = z.object({
  id: z.string().optional().nullable(),
  type: z.literal("function").optional(),
  function: z.object({ name: z.string().min(1), arguments: z.union([z.string(), z.record(z.string(), z.unknown())]) }).passthrough(),
}).passthrough();
const responseSchema = z.object({
  id: z.string().min(1).optional(),
  model: z.string().min(1),
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({
      role: z.string().optional(),
      content: z.string().nullable().optional(),
      tool_calls: z.array(toolCallSchema).nullable().optional(),
    }).passthrough(),
  }).passthrough()).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative().optional(),
  }).passthrough(),
}).passthrough();

export interface ChatCompletionsTransport {
  create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface ChatCompletionsOptions {
  /** Provider label recorded in every response, e.g. "ollama", "google", "nvidia". */
  provider: string;
  /** Strip JSON Schema keywords some providers reject (title, additionalProperties, $defs, pattern). */
  reducedSchemas?: boolean;
  /** Send settings.reasoning_effort as reasoning_effort (only for providers that accept it). */
  sendReasoningEffort?: boolean;
  /** Settings the endpoint rejects; they are omitted from the request (record this in run metadata). */
  omitSettings?: Array<"seed" | "top_p" | "temperature">;
}

const UNSUPPORTED_KEYS = new Set(["title", "additionalProperties", "$defs", "$schema", "pattern", "default"]);
export function reduceSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reduceSchema);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !UNSUPPORTED_KEYS.has(key)).map(([key, inner]) => [key, reduceSchema(inner)]));
  }
  return value;
}

function normalizeError(provider: string, error: unknown): NormalizedProviderError {
  if (error instanceof NormalizedProviderError) return error;
  const value = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof value.status === "number" ? value.status : null;
  const nativeCode = typeof value.code === "string" ? value.code : "";
  const message = error instanceof Error ? error.message : "Unknown provider failure";
  if (status === 401 || status === 403) return new NormalizedProviderError(provider, "authentication", false, message, status);
  if (status === 429) return new NormalizedProviderError(provider, "rate_limit", true, message, status);
  if (status === 408 || value.name === "AbortError" || nativeCode === "timeout") return new NormalizedProviderError(provider, "timeout", true, message, status);
  if (status !== null && status >= 400 && status < 500) return new NormalizedProviderError(provider, "invalid_request", false, message, status);
  if (status !== null && status >= 500) return new NormalizedProviderError(provider, "server", true, message, status);
  if (["ECONNRESET", "ENOTFOUND", "ECONNREFUSED"].includes(nativeCode)) return new NormalizedProviderError(provider, "network", true, message, status);
  return new NormalizedProviderError(provider, "unknown", false, message, status);
}

function finishReason(raw: string | null | undefined, hasToolCalls: boolean): ModelResponse["finish_reason"] {
  if (hasToolCalls) return "tool_call";
  if (raw === "stop" || raw === "end_turn") return "stop";
  if (raw === "length") return "length";
  if (raw === "content_filter") return "content_filter";
  return "other";
}

export class ChatCompletionsAdapter implements ModelAdapter {
  readonly provider: string;
  readonly modelId: string;
  private readonly transport: ChatCompletionsTransport;
  private readonly options: ChatCompletionsOptions;

  constructor(modelId: string, transport: ChatCompletionsTransport, options: ChatCompletionsOptions) {
    if (!modelId.trim()) throw new Error("Model ID must be exact and non-empty");
    this.modelId = modelId;
    this.transport = transport;
    this.options = options;
    this.provider = options.provider;
  }

  async generate(input: ModelRequest, options?: { signal?: AbortSignal }): Promise<ModelResponse> {
    const request = ModelRequestSchema.parse(input);
    const settings = request.settings;
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
      max_tokens: settings.max_output_tokens,
      stream: false,
    };
    if (request.tools.length) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name, description: tool.description,
          parameters: this.options.reducedSchemas ? reduceSchema(tool.parameters) : tool.parameters,
        },
      }));
    }
    const omit = new Set(this.options.omitSettings ?? []);
    if (settings.temperature !== null && !omit.has("temperature")) body.temperature = settings.temperature;
    if (settings.top_p !== null && !omit.has("top_p")) body.top_p = settings.top_p;
    if (settings.seed !== null && !omit.has("seed")) body.seed = settings.seed;
    if (settings.reasoning_effort !== null && this.options.sendReasoningEffort) body.reasoning_effort = settings.reasoning_effort;

    let raw: unknown;
    try { raw = await this.transport.create(body, { signal: options?.signal }); }
    catch (error) { throw normalizeError(this.provider, error); }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new NormalizedProviderError(this.provider, "invalid_response", false, `Malformed ${this.provider} response: ${parsed.error.message}`);
    const response = parsed.data;
    const choice = response.choices[0]!;
    const responseId = response.id ?? `${this.provider}-${request.request_id}`;
    const toolCalls = (choice.message.tool_calls ?? []).map((call, index) => {
      const callId = call.id && call.id.length > 0 ? call.id : `${responseId}-call-${index + 1}`;
      let args: unknown = call.function.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args.trim() === "" ? "{}" : args); }
        catch { throw new NormalizedProviderError(this.provider, "invalid_response", false, `Tool call ${callId} has invalid JSON arguments`); }
      }
      if (args === null || Array.isArray(args) || typeof args !== "object") {
        throw new NormalizedProviderError(this.provider, "invalid_response", false, `Tool call ${callId} arguments must be an object`);
      }
      return { call_id: callId, tool_name: call.function.name, arguments: args as Record<string, unknown> };
    });
    const ids = toolCalls.map((call) => call.call_id);
    if (new Set(ids).size !== ids.length) throw new NormalizedProviderError(this.provider, "invalid_response", false, "Duplicate tool call IDs in one response");
    const total = response.usage.total_tokens ?? response.usage.prompt_tokens + response.usage.completion_tokens;
    if (total < response.usage.prompt_tokens + response.usage.completion_tokens) {
      throw new NormalizedProviderError(this.provider, "invalid_response", false, "Total token count is smaller than input plus output tokens");
    }
    return ModelResponseSchema.parse({
      response_id: responseId,
      provider: this.provider,
      requested_model: this.modelId,
      response_model: response.model,
      generation_settings: settings,
      output_text: choice.message.content ?? "",
      tool_calls: toolCalls,
      usage: { input_tokens: response.usage.prompt_tokens, output_tokens: response.usage.completion_tokens, total_tokens: total },
      finish_reason: finishReason(choice.finish_reason, toolCalls.length > 0),
    });
  }
}

/** fetch-based transport. Pass apiKey only for hosted providers; never log or persist it. */
export function fetchChatCompletionsTransport(config: {
  baseUrl: string; apiKey?: string; fetchImpl?: typeof fetch; extraHeaders?: Record<string, string>;
}): ChatCompletionsTransport {
  const base = config.baseUrl.replace(/\/$/, "");
  const doFetch = config.fetchImpl ?? fetch;
  return {
    async create(body, options) {
      const response = await doFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          ...config.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      if (!response.ok) {
        const text = (await response.text()).slice(0, 500);
        throw Object.assign(new Error(`Provider HTTP ${response.status}: ${text}`), { status: response.status });
      }
      return await response.json();
    },
  };
}

export interface ProviderSpec {
  provider_label?: string; base_url: string; loopback_only: boolean; api_key_env: string | null;
  reduced_schemas: boolean; omit_settings: Array<"seed" | "top_p" | "temperature">; send_reasoning_effort: boolean;
}

/** Builds an adapter from a provider entry registered in configs/providers.yaml. Keys come from the environment only. */
export function createAdapterFromSpec(name: string, spec: ProviderSpec, modelId: string, env: Record<string, string | undefined>, fetchImpl?: typeof fetch): ChatCompletionsAdapter {
  const url = new URL(spec.base_url);
  if (spec.loopback_only && (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname))) {
    throw new Error(`${name} endpoint must be loopback HTTP`);
  }
  const apiKey = spec.api_key_env ? env[spec.api_key_env] ?? "" : undefined;
  if (spec.api_key_env && !apiKey!.trim()) throw new Error(`${name.toLowerCase()}_api_key_required (${spec.api_key_env})`);
  return new ChatCompletionsAdapter(modelId, fetchChatCompletionsTransport({ baseUrl: spec.base_url, apiKey, fetchImpl }), {
    provider: spec.provider_label ?? name, reducedSchemas: spec.reduced_schemas, omitSettings: spec.omit_settings, sendReasoningEffort: spec.send_reasoning_effort,
  });
}

const providersPath = new URL("../../configs/providers.yaml", import.meta.url);
const registeredProvider = (name: string): ProviderSpec => {
  const spec = JSON.parse(readFileSync(providersPath, "utf8")).providers[name];
  if (!spec) throw new Error(`provider ${name} is not registered in configs/providers.yaml`);
  return spec;
};

/** Local Ollama through its OpenAI-compatible endpoint (registered spec; loopback only). */
export function createOllamaAdapter(modelId: string, baseUrl?: string, fetchImpl?: typeof fetch): ChatCompletionsAdapter {
  const spec = registeredProvider("ollama");
  return createAdapterFromSpec("ollama", baseUrl ? { ...spec, base_url: baseUrl } : spec, modelId, {}, fetchImpl);
}

/** Gemini through Google's OpenAI-compatible endpoint (registered spec). */
export function createGeminiAdapter(modelId: string, apiKey: string, fetchImpl?: typeof fetch): ChatCompletionsAdapter {
  const spec = registeredProvider("gemini");
  return createAdapterFromSpec("gemini", spec, modelId, { [spec.api_key_env!]: apiKey }, fetchImpl);
}

/** NVIDIA NIM hosted API (registered spec). */
export function createNvidiaAdapter(modelId: string, apiKey: string, fetchImpl?: typeof fetch): ChatCompletionsAdapter {
  const spec = registeredProvider("nvidia");
  return createAdapterFromSpec("nvidia", spec, modelId, { [spec.api_key_env!]: apiKey }, fetchImpl);
}
