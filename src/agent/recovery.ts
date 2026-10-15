import { readFile } from "node:fs/promises";
import { z } from "zod";
import { BudgetController, BudgetExhaustedError } from "../../runtime/budget.ts";
import { NormalizedProviderError } from "../models/contracts.ts";
import { canonicalJson } from "../../schemas/trace.ts";

/** Bounded recovery (TB-025): retry transient reads and model calls inside the run's retry budget; never auto-retry writes. */
export const RecoveryPolicySchema = z.object({
  schema_version: z.literal("1.0.0"),
  note: z.string().optional(),
  tool_classes: z.object({
    read: z.array(z.string().min(1)),
    write: z.array(z.string().min(1)),
    classification_notes: z.record(z.string(), z.string()).optional(),
  }).strict(),
  retry: z.object({
    attempt_timeout_ms: z.number().int().positive(),
    max_attempts_per_call: z.number().int().min(1).max(10),
    backoff: z.object({ base_ms: z.number().nonnegative(), factor: z.number().min(1), max_ms: z.number().nonnegative(), jitter: z.enum(["full", "none"]) }).strict(),
    transient_http_status: z.array(z.number().int()),
    non_transient_details: z.array(z.string()),
    transient_error_names: z.array(z.string()),
    transient_error_codes: z.array(z.string()),
  }).strict(),
  writes: z.object({
    auto_retry: z.literal(false), // not configurable: a non-idempotent write must never be repeated automatically
    suppress_exact_duplicates: z.boolean(),
    definite_not_executed_http_status: z.object({ min: z.number().int(), max: z.number().int() }).strict(),
    unknown_outcome_error_code: z.string().min(1),
  }).strict(),
  model: z.object({ retry_provider_codes: z.array(z.string()) }).strict(),
}).strict();
export type RecoveryPolicy = z.infer<typeof RecoveryPolicySchema>;

export async function loadRecoveryPolicy(path: string, registeredToolNames?: readonly string[]): Promise<RecoveryPolicy> {
  const policy = RecoveryPolicySchema.parse(JSON.parse(await readFile(path, "utf8")));
  const read = new Set(policy.tool_classes.read), write = new Set(policy.tool_classes.write);
  for (const name of read) if (write.has(name)) throw new Error(`tool ${name} is classified as both read and write`);
  if (registeredToolNames) {
    const unclassified = registeredToolNames.filter((n) => !read.has(n) && !write.has(n));
    if (unclassified.length) throw new Error(`tools without a recovery class: ${unclassified.join(", ")}`);
    const unknown = [...read, ...write].filter((n) => !registeredToolNames.includes(n));
    if (unknown.length) throw new Error(`recovery policy names unregistered tools: ${unknown.join(", ")}`);
  }
  return policy;
}

export interface RecoveryEvent {
  kind: "model" | "tool";
  name: string;
  call_id: string | null;
  attempt: number;
  event: "retry" | "retry_budget_exhausted" | "attempts_exhausted" | "not_retryable" | "write_not_retried" | "duplicate_write_suppressed";
  reason: string;
  delay_ms: number;
}

export interface RecoverySummary {
  enabled: true;
  model_retries: number;
  tool_retries: number;
  retry_budget: number;
  suppressed_write_retries: number;
  suppressed_duplicate_writes: number;
  unknown_outcome_writes: number;
  backoff_ms_total: number;
  events: RecoveryEvent[];
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;
const defaultSleep: Sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", onAbort, { once: true });
});

function mulberry32(seed: number): () => number {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hashText = (text: string) => [...text].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);

export interface AttemptOutcome<T> { value: T; attempts: number; replayed?: boolean }
export class AttemptsError extends Error {
  attempts: number; outcome_unknown: boolean; code: string; cause_error: unknown;
  constructor(cause: unknown, attempts: number, outcomeUnknown: boolean, code: string) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = cause instanceof Error ? cause.name : "Error";
    this.attempts = attempts; this.outcome_unknown = outcomeUnknown; this.code = code; this.cause_error = cause;
  }
}

export class RecoveryManager {
  readonly events: RecoveryEvent[] = [];
  private readonly policy: RecoveryPolicy;
  private readonly budget: BudgetController;
  private readonly runSignal: AbortSignal;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly read: Set<string>;
  private readonly write: Set<string>;
  private readonly ledger = new Map<string, { status: "succeeded" | "unknown"; value: unknown }>();
  private modelRetries = 0; private toolRetries = 0; private backoffTotal = 0;
  private suppressedWriteRetries = 0; private suppressedDuplicates = 0; private unknownWrites = 0;

  constructor(options: { policy: RecoveryPolicy; budget: BudgetController; signal: AbortSignal; runId: string; seed: number; sleep?: Sleep }) {
    this.policy = options.policy; this.budget = options.budget; this.runSignal = options.signal;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = mulberry32(options.seed ^ hashText(options.runId));
    this.read = new Set(options.policy.tool_classes.read); this.write = new Set(options.policy.tool_classes.write);
  }

  /** Decides whether an error is transient. 'definite' means the request is known not to have executed. */
  classifyToolError(error: unknown): { transient: boolean; definiteNotExecuted: boolean; reason: string } {
    const r = this.policy.retry, w = this.policy.writes.definite_not_executed_http_status;
    const value = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
    const status = typeof value.status === "number" ? value.status : null;
    const detail = typeof value.code === "string" ? value.code : "";
    if (status !== null) {
      const definite = status >= w.min && status <= w.max;
      if (r.non_transient_details.includes(detail)) return { transient: false, definiteNotExecuted: definite, reason: `non_transient:${detail}` };
      return { transient: r.transient_http_status.includes(status), definiteNotExecuted: definite, reason: `http_${status}` };
    }
    const name = typeof value.name === "string" ? value.name : "";
    const causeCode = value.cause !== null && typeof value.cause === "object" && typeof (value.cause as Record<string, unknown>).code === "string" ? (value.cause as Record<string, string>).code : "";
    const code = typeof value.code === "string" ? value.code : causeCode;
    const transient = r.transient_error_names.includes(name) || r.transient_error_codes.includes(code);
    return { transient, definiteNotExecuted: false, reason: transient ? `network:${code || name}` : `error:${name || "unknown"}` };
  }

  private delayFor(retryNumber: number): number {
    const b = this.policy.retry.backoff;
    const ceiling = Math.min(b.max_ms, b.base_ms * b.factor ** (retryNumber - 1));
    return Math.round(b.jitter === "full" ? this.random() * ceiling : ceiling);
  }

  /** True only when the retry budget, the elapsed budget and the per-call attempt cap all allow another attempt. */
  private async mayRetry(kind: "model" | "tool", name: string, callId: string | null, attempt: number, reason: string): Promise<number | null> {
    if (this.runSignal.aborted) return null;
    if (attempt >= this.policy.retry.max_attempts_per_call) { this.events.push({ kind, name, call_id: callId, attempt, event: "attempts_exhausted", reason, delay_ms: 0 }); return null; }
    const snapshot = this.budget.snapshot();
    if (snapshot.retries >= this.budget.config.limits.max_retries) { this.events.push({ kind, name, call_id: callId, attempt, event: "retry_budget_exhausted", reason, delay_ms: 0 }); return null; }
    const delay = this.delayFor(attempt);
    const remaining = this.budget.config.limits.max_elapsed_ms - (Date.now() - this.budget.startedAtMs);
    if (delay >= remaining) { this.events.push({ kind, name, call_id: callId, attempt, event: "retry_budget_exhausted", reason: `${reason};insufficient_elapsed_budget`, delay_ms: delay }); return null; }
    this.budget.recordRetry(); // cannot exceed the limit: checked above
    if (kind === "model") this.modelRetries++; else this.toolRetries++;
    this.backoffTotal += delay;
    this.events.push({ kind, name, call_id: callId, attempt, event: "retry", reason, delay_ms: delay });
    await this.sleep(delay, this.runSignal);
    return delay;
  }

  async callModel<T>(name: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(this.runSignal); }
      catch (error) {
        if (error instanceof BudgetExhaustedError || this.runSignal.aborted) throw error;
        const retryable = error instanceof NormalizedProviderError && error.retryable && this.policy.model.retry_provider_codes.includes(error.code);
        if (!retryable) { this.events.push({ kind: "model", name, call_id: null, attempt, event: "not_retryable", reason: error instanceof NormalizedProviderError ? error.code : "error", delay_ms: 0 }); throw error; }
        const delay = await this.mayRetry("model", name, null, attempt, (error as NormalizedProviderError).code);
        if (delay === null) throw error;
      }
    }
  }

  /** Runs one logical tool call. Reads may be retried; writes get exactly one attempt. */
  async callTool<T>(toolName: string, args: Record<string, unknown>, callId: string, exec: (signal: AbortSignal, attempt: number) => Promise<T>): Promise<AttemptOutcome<T>> {
    const isWrite = this.write.has(toolName);
    const isRead = this.read.has(toolName);
    const key = isWrite ? `${toolName}:${canonicalJson(args)}` : "";
    if (isWrite && this.policy.writes.suppress_exact_duplicates) {
      const prior = this.ledger.get(key);
      if (prior) {
        this.suppressedDuplicates++;
        this.events.push({ kind: "tool", name: toolName, call_id: callId, attempt: 0, event: "duplicate_write_suppressed", reason: prior.status, delay_ms: 0 });
        if (prior.status === "succeeded") return { value: prior.value as T, attempts: 0, replayed: true };
        throw new AttemptsError(new Error("An identical write already ran and its outcome is unknown; it was not repeated. Verify with a read."), 0, true, this.policy.writes.unknown_outcome_error_code);
      }
    }
    const maxAttempts = isRead ? this.policy.retry.max_attempts_per_call : 1;
    for (let attempt = 1; ; attempt++) {
      const attemptController = new AbortController();
      const onRun = () => attemptController.abort(this.runSignal.reason);
      this.runSignal.addEventListener("abort", onRun, { once: true });
      const timer = setTimeout(() => attemptController.abort(Object.assign(new Error("tool attempt timed out"), { name: "TimeoutError" })), this.policy.retry.attempt_timeout_ms);
      try {
        const value = await exec(attemptController.signal, attempt);
        if (isWrite) this.ledger.set(key, { status: "succeeded", value });
        return { value, attempts: attempt };
      } catch (error) {
        if (error instanceof BudgetExhaustedError || this.runSignal.aborted) throw error;
        const attemptTimedOut = attemptController.signal.aborted && !this.runSignal.aborted;
        const effective = attemptTimedOut ? Object.assign(new Error("tool attempt timed out"), { name: "TimeoutError" }) : error;
        const c = this.classifyToolError(effective);
        if (isWrite) {
          const unknown = !c.definiteNotExecuted;
          if (unknown) { this.unknownWrites++; if (this.policy.writes.suppress_exact_duplicates) this.ledger.set(key, { status: "unknown", value: null }); }
          if (c.transient) { this.suppressedWriteRetries++; this.events.push({ kind: "tool", name: toolName, call_id: callId, attempt, event: "write_not_retried", reason: c.reason, delay_ms: 0 }); }
          throw new AttemptsError(effective, attempt, unknown, unknown && c.transient ? this.policy.writes.unknown_outcome_error_code : codeOf(effective));
        }
        if (!isRead || !c.transient || attempt >= maxAttempts) {
          this.events.push({ kind: "tool", name: toolName, call_id: callId, attempt, event: !isRead || !c.transient ? "not_retryable" : "attempts_exhausted", reason: c.reason, delay_ms: 0 });
          throw new AttemptsError(effective, attempt, false, codeOf(effective));
        }
        const delay = await this.mayRetry("tool", toolName, callId, attempt, c.reason);
        if (delay === null) throw new AttemptsError(effective, attempt, false, codeOf(effective));
      } finally {
        clearTimeout(timer);
        this.runSignal.removeEventListener("abort", onRun);
      }
    }
  }

  summary(): RecoverySummary {
    return {
      enabled: true, model_retries: this.modelRetries, tool_retries: this.toolRetries,
      retry_budget: this.budget.config.limits.max_retries,
      suppressed_write_retries: this.suppressedWriteRetries, suppressed_duplicate_writes: this.suppressedDuplicates,
      unknown_outcome_writes: this.unknownWrites, backoff_ms_total: this.backoffTotal, events: structuredClone(this.events),
    };
  }
}

function codeOf(error: unknown): string {
  const value = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  return typeof value.code === "string" ? value.code : error instanceof Error ? error.name : "unknown_error";
}
