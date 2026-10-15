import { readFile } from "node:fs/promises";
import { z } from "zod";

export const BudgetConfigSchema = z.object({
  schema_version: z.literal("1.0.0"),
  pricing: z.object({
    provider: z.enum(["openai", "ollama", "google"]),
    runtime_model_alias: z.string().min(1),
    pricing_model_id: z.string().min(1),
    service_tier: z.enum(["fast", "free", "local"]),
    context_band: z.literal("short"),
    input_usd_per_million_tokens: z.number().nonnegative(),
    output_usd_per_million_tokens: z.number().nonnegative(),
    verified_at: z.string().datetime({ offset: true }),
    source_url: z.string().url(),
    max_age_hours_at_provider_run: z.number().positive(),
  }).strict(),
  limits: z.object({
    max_model_calls: z.number().int().positive(),
    max_tool_calls: z.number().int().nonnegative(),
    max_input_tokens: z.number().int().positive(),
    max_output_tokens: z.number().int().positive(),
    max_retries: z.number().int().nonnegative(),
    max_elapsed_ms: z.number().int().positive(),
    max_cost_microusd: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
export type BudgetDimension = "model_calls" | "tool_calls" | "input_tokens" | "output_tokens" | "retries" | "elapsed_ms" | "cost_microusd";

export interface BudgetTerminalRecord {
  outcome: "active" | "budget_exhausted";
  exhausted_dimension: BudgetDimension | null;
  reason: string | null;
  model_calls: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  retries: number;
  elapsed_ms: number;
  cost_microusd: number;
  pending_work_cancelled: boolean;
}

export class BudgetExhaustedError extends Error {
  readonly dimension: BudgetDimension;

  constructor(dimension: BudgetDimension, message: string) {
    super(message);
    this.dimension = dimension;
    this.name = "BudgetExhaustedError";
  }
}

export async function loadBudgetConfig(path: string): Promise<BudgetConfig> {
  const raw = await readFile(path, "utf8");
  try {
    return BudgetConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Invalid budget configuration ${path}: ${String(error)}`);
  }
}

export function assertPricingFresh(config: BudgetConfig, now = new Date()): void {
  const verifiedAt = new Date(config.pricing.verified_at);
  const ageMs = now.getTime() - verifiedAt.getTime();
  const maxAgeMs = config.pricing.max_age_hours_at_provider_run * 60 * 60 * 1000;
  if (ageMs < 0 || ageMs > maxAgeMs) {
    throw new Error(`Pricing snapshot is not valid at execution time; age_ms=${ageMs}`);
  }
}

export function estimateCostMicrousd(config: BudgetConfig, inputTokens: number, outputTokens: number): number {
  if (!Number.isInteger(inputTokens) || inputTokens < 0 || !Number.isInteger(outputTokens) || outputTokens < 0) {
    throw new Error("Token counts must be non-negative integers");
  }
  return Math.ceil(
    inputTokens * config.pricing.input_usd_per_million_tokens
      + outputTokens * config.pricing.output_usd_per_million_tokens,
  );
}

export class BudgetController {
  readonly abortController = new AbortController();
  readonly startedAtMs: number;
  readonly config: BudgetConfig;
  private state: BudgetTerminalRecord = {
    outcome: "active", exhausted_dimension: null, reason: null,
    model_calls: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0,
    retries: 0, elapsed_ms: 0, cost_microusd: 0, pending_work_cancelled: false,
  };

  constructor(config: BudgetConfig, startedAtMs = Date.now()) {
    this.config = config;
    this.startedAtMs = startedAtMs;
  }

  get signal(): AbortSignal { return this.abortController.signal; }
  snapshot(): BudgetTerminalRecord { return structuredClone(this.state); }

  private ensureActive(): void {
    if (this.state.outcome === "budget_exhausted") {
      throw new BudgetExhaustedError(this.state.exhausted_dimension!, this.state.reason!);
    }
  }

  private exhaust(dimension: BudgetDimension, reason: string): never {
    this.state.outcome = "budget_exhausted";
    this.state.exhausted_dimension = dimension;
    this.state.reason = reason;
    this.state.pending_work_cancelled = true;
    const error = new BudgetExhaustedError(dimension, reason);
    this.abortController.abort(error);
    throw error;
  }

  checkElapsed(nowMs = Date.now()): void {
    this.ensureActive();
    this.state.elapsed_ms = Math.max(0, nowMs - this.startedAtMs);
    if (this.state.elapsed_ms > this.config.limits.max_elapsed_ms) {
      this.exhaust("elapsed_ms", `Elapsed time ${this.state.elapsed_ms} exceeded ${this.config.limits.max_elapsed_ms}`);
    }
  }

  beginModelCall(plannedMaxInputTokens: number, plannedMaxOutputTokens: number, nowMs = Date.now()): void {
    this.checkElapsed(nowMs);
    if (this.state.model_calls + 1 > this.config.limits.max_model_calls) this.exhaust("model_calls", "Maximum model calls reached");
    if (this.state.input_tokens + plannedMaxInputTokens > this.config.limits.max_input_tokens) this.exhaust("input_tokens", "Planned input exceeds token budget");
    if (this.state.output_tokens + plannedMaxOutputTokens > this.config.limits.max_output_tokens) this.exhaust("output_tokens", "Planned output exceeds token budget");
    const projectedCost = this.state.cost_microusd + estimateCostMicrousd(this.config, plannedMaxInputTokens, plannedMaxOutputTokens);
    if (projectedCost > this.config.limits.max_cost_microusd) this.exhaust("cost_microusd", "Planned call exceeds currency budget");
    this.state.model_calls += 1;
  }

  recordModelUsage(inputTokens: number, outputTokens: number): void {
    this.ensureActive();
    this.state.input_tokens += inputTokens;
    this.state.output_tokens += outputTokens;
    this.state.cost_microusd += estimateCostMicrousd(this.config, inputTokens, outputTokens);
    if (this.state.input_tokens > this.config.limits.max_input_tokens) this.exhaust("input_tokens", "Observed input exceeded token budget");
    if (this.state.output_tokens > this.config.limits.max_output_tokens) this.exhaust("output_tokens", "Observed output exceeded token budget");
    if (this.state.cost_microusd > this.config.limits.max_cost_microusd) this.exhaust("cost_microusd", "Observed usage exceeded currency budget");
  }

  recordToolCall(): void {
    this.ensureActive();
    this.state.tool_calls += 1;
    if (this.state.tool_calls > this.config.limits.max_tool_calls) this.exhaust("tool_calls", "Maximum tool calls reached");
  }

  recordRetry(): void {
    this.ensureActive();
    this.state.retries += 1;
    if (this.state.retries > this.config.limits.max_retries) this.exhaust("retries", "Maximum retries reached");
  }
}
