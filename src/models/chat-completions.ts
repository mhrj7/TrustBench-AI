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
    if (settings.temperature !== null) body.temperature = settings.temperature;
    if (settings.top_p !== null) body.top_p = settings.top_p;
    if (settings.seed !== null) body.seed = settings.seed;
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

/** Local Ollama through its OpenAI-compatible endpoint. Loopback only. */
export function createOllamaAdapter(modelId: string, baseUrl = "http://127.0.0.1:11434/v1", fetchImpl?: typeof fetch): ChatCompletionsAdapter {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("Ollama endpoint must be loopback HTTP");
  }
  return new ChatCompletionsAdapter(modelId, fetchChatCompletionsTransport({ baseUrl, fetchImpl }), { provider: "ollama", sendReasoningEffort: true });
}

/** Gemini through Google's OpenAI-compatible endpoint. The key comes from the environment, never from prompts. */
export function createGeminiAdapter(modelId: string, apiKey: string, fetchImpl?: typeof fetch): ChatCompletionsAdapter {
  if (!apiKey.trim()) throw new Error("gemini_api_key_required");
  return new ChatCompletionsAdapter(modelId, fetchChatCompletionsTransport({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey, fetchImpl,
  }), { provider: "google", reducedSchemas: true });
}
