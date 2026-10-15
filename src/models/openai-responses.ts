import { z } from "zod";
import {
  ModelRequestSchema, ModelResponseSchema, NormalizedProviderError, type ModelAdapter, type ModelRequest, type ModelResponse,
} from "./contracts.ts";

const outputText = z.object({ type: z.literal("output_text"), text: z.string() }).passthrough();
const messageItem = z.object({ type: z.literal("message"), content: z.array(outputText) }).passthrough();
const functionCallItem = z.object({
  type: z.literal("function_call"), call_id: z.string().min(1), name: z.string().min(1), arguments: z.string(),
}).passthrough();
const responseSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  status: z.enum(["completed", "incomplete", "failed"]),
  output: z.array(z.discriminatedUnion("type", [messageItem, functionCallItem])),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }).passthrough(),
  incomplete_details: z.object({ reason: z.string().nullable() }).passthrough().nullable().optional(),
}).passthrough();

export interface OpenAIResponsesTransport {
  create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

function normalizeError(error: unknown): NormalizedProviderError {
  if (error instanceof NormalizedProviderError) return error;
  const value = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof value.status === "number" ? value.status : null;
  const nativeCode = typeof value.code === "string" ? value.code : "";
  const message = error instanceof Error ? error.message : "Unknown OpenAI provider failure";
  if (status === 401 || status === 403) return new NormalizedProviderError("openai", "authentication", false, message, status);
  if (status === 429 || nativeCode === "rate_limit_exceeded") return new NormalizedProviderError("openai", "rate_limit", true, message, status);
  if (status === 408 || nativeCode === "timeout" || value.name === "AbortError") return new NormalizedProviderError("openai", "timeout", true, message, status);
  if (status !== null && status >= 400 && status < 500) return new NormalizedProviderError("openai", "invalid_request", false, message, status);
  if (status !== null && status >= 500) return new NormalizedProviderError("openai", "server", true, message, status);
  if (nativeCode === "ECONNRESET" || nativeCode === "ENOTFOUND") return new NormalizedProviderError("openai", "network", true, message, status);
  return new NormalizedProviderError("openai", "unknown", false, message, status);
}

function finishReason(response: z.infer<typeof responseSchema>, hasToolCalls: boolean): ModelResponse["finish_reason"] {
  if (response.status === "failed") return "error";
  if (response.status === "completed") return hasToolCalls ? "tool_call" : "stop";
  const reason = response.incomplete_details?.reason;
  if (reason === "max_output_tokens") return "length";
  if (reason === "content_filter") return "content_filter";
  return "other";
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  readonly provider = "openai";
  readonly modelId: string;
  private readonly transport: OpenAIResponsesTransport;

  constructor(modelId: string, transport: OpenAIResponsesTransport) {
    if (!modelId.trim()) throw new Error("OpenAI model ID must be exact and non-empty");
    this.modelId = modelId;
    this.transport = transport;
  }

  async generate(input: ModelRequest, options?: { signal?: AbortSignal }): Promise<ModelResponse> {
    const request = ModelRequestSchema.parse(input);
    const settings = request.settings;
    const body: Record<string, unknown> = {
      model: this.modelId,
      input: request.messages.map((message) => ({ role: message.role, content: message.content })),
      tools: request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: true })),
      max_output_tokens: settings.max_output_tokens,
    };
    if (settings.temperature !== null) body.temperature = settings.temperature;
    if (settings.top_p !== null) body.top_p = settings.top_p;
    if (settings.seed !== null) body.seed = settings.seed;
    if (settings.reasoning_effort !== null) body.reasoning = { effort: settings.reasoning_effort };

    let raw: unknown;
    try { raw = await this.transport.create(body, { signal: options?.signal }); }
    catch (error) { throw normalizeError(error); }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new NormalizedProviderError(this.provider, "invalid_response", false, `Malformed OpenAI response: ${parsed.error.message}`);
    const response = parsed.data;
    if (response.usage.total_tokens < response.usage.input_tokens + response.usage.output_tokens) {
      throw new NormalizedProviderError(this.provider, "invalid_response", false, "OpenAI total token count is smaller than input plus output tokens");
    }
    const text = response.output.filter((item) => item.type === "message").flatMap((item) => item.content.map((part) => part.text)).join("");
    const toolCalls = response.output.filter((item) => item.type === "function_call").map((item) => {
      let args: unknown;
      try { args = JSON.parse(item.arguments); }
      catch { throw new NormalizedProviderError(this.provider, "invalid_response", false, `Tool call ${item.call_id} has invalid JSON arguments`); }
      if (args === null || Array.isArray(args) || typeof args !== "object") {
        throw new NormalizedProviderError(this.provider, "invalid_response", false, `Tool call ${item.call_id} arguments must be an object`);
      }
      return { call_id: item.call_id, tool_name: item.name, arguments: args };
    });
    return ModelResponseSchema.parse({
      response_id: response.id,
      provider: this.provider,
      requested_model: this.modelId,
      response_model: response.model,
      generation_settings: settings,
      output_text: text,
      tool_calls: toolCalls,
      usage: response.usage,
      finish_reason: finishReason(response, toolCalls.length > 0),
    });
  }
}
