import { z } from "zod";

const identifier = z.string().min(1).max(256);
const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue),
]));

export const ModelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
}).strict();

export const ModelToolSchema = z.object({
  name: identifier,
  description: z.string().min(1),
  parameters: z.record(z.string(), jsonValue),
}).strict();

export const GenerationSettingsSchema = z.object({
  max_output_tokens: z.number().int().positive(),
  temperature: z.number().finite().min(0).max(2).nullable(),
  top_p: z.number().finite().gt(0).lte(1).nullable(),
  seed: z.number().int().nullable(),
  reasoning_effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).nullable(),
}).strict();

export const ModelRequestSchema = z.object({
  request_id: identifier,
  messages: z.array(ModelMessageSchema).min(1),
  tools: z.array(ModelToolSchema),
  settings: GenerationSettingsSchema,
}).strict();

export const NormalizedToolCallSchema = z.object({
  call_id: identifier,
  tool_name: identifier,
  arguments: z.record(z.string(), jsonValue),
}).strict();

export const ModelResponseSchema = z.object({
  response_id: identifier,
  provider: identifier,
  requested_model: identifier,
  response_model: identifier,
  generation_settings: GenerationSettingsSchema,
  output_text: z.string(),
  tool_calls: z.array(NormalizedToolCallSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }).strict(),
  finish_reason: z.enum(["stop", "tool_call", "length", "content_filter", "error", "other"]),
}).strict();

export const ProviderErrorCodeSchema = z.enum([
  "authentication", "rate_limit", "timeout", "invalid_request", "invalid_response", "server", "network", "unknown",
]);

export type ModelRequest = z.infer<typeof ModelRequestSchema>;
export type ModelResponse = z.infer<typeof ModelResponseSchema>;
export type GenerationSettings = z.infer<typeof GenerationSettingsSchema>;
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;

export class NormalizedProviderError extends Error {
  readonly provider: string;
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    provider: string,
    code: ProviderErrorCode,
    retryable: boolean,
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = "NormalizedProviderError";
    this.provider = provider;
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export interface ModelAdapter {
  readonly provider: string;
  readonly modelId: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}
