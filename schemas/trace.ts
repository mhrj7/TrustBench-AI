import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(), z.number().finite(), z.boolean(), z.null(),
    z.array(jsonValue), z.record(z.string(), jsonValue),
  ]),
);

const common = z.object({
  schema_version: z.literal("1.0.0"),
  run_id: id,
  task_id: id,
  sequence: z.number().int().nonnegative(),
  timestamp,
}).strict();

const runStarted = z.object({
  event_type: z.literal("run_started"),
  model: z.object({ provider: id, name: id, revision: z.string().min(1).max(256) }).strict(),
  prompt_sha256: sha256,
  seed: z.number().int().nullable(),
  evaluator_version: id,
  limits: z.object({
    max_model_calls: z.number().int().positive(),
    max_tool_calls: z.number().int().nonnegative(),
    max_elapsed_ms: z.number().int().positive(),
    max_retries: z.number().int().nonnegative(),
    max_input_tokens: z.number().int().positive(),
    max_output_tokens: z.number().int().positive(),
    max_cost_microusd: z.number().int().nonnegative(),
  }).strict(),
  configuration_sha256: sha256,
}).strict();

const modelUsage = z.object({
  event_type: z.literal("model_usage"),
  model_call_id: id,
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  latency_ms: z.number().int().nonnegative(),
  cost_microusd: z.number().int().nonnegative().nullable(),
  finish_reason: z.enum(["stop", "tool_call", "length", "content_filter", "error", "other"]),
}).strict();

const toolCallProposed = z.object({
  event_type: z.literal("tool_call_proposed"),
  call_id: id,
  tool_name: id,
  arguments: jsonValue,
  arguments_sha256: sha256,
  provenance: z.array(z.object({
    source_id: id,
    trust: z.enum(["trusted_control", "trusted_metadata", "untrusted_content", "untrusted_model_output"]),
  }).strict()).max(100),
}).strict();

const policyDecision = z.object({
  event_type: z.literal("policy_decision"),
  call_id: id,
  arguments_sha256: sha256,
  decision: z.enum(["allow", "deny", "require_approval"]),
  reason_code: id,
  rule_ids: z.array(id).min(1),
  policy_version: id,
}).strict();

const toolCallStarted = z.object({
  event_type: z.literal("tool_call_started"),
  call_id: id,
  span_id: id,
  tool_name: id,
  arguments: jsonValue,
  arguments_sha256: sha256,
}).strict();

const toolCallFinished = z.object({
  event_type: z.literal("tool_call_finished"),
  call_id: id,
  span_id: id,
  status: z.enum(["succeeded", "failed", "cancelled"]),
  duration_ms: z.number().int().nonnegative(),
  result_summary: z.string().max(1000),
  state_change_ids: z.array(id).max(100),
  error_code: id.nullable(),
}).strict();

const evaluatorResult = z.object({
  event_type: z.literal("evaluator_result"),
  evaluator_version: id,
  utility_pass: z.boolean(),
  security_pass: z.boolean(),
  evidence_complete: z.boolean(),
  reason_codes: z.array(id),
}).strict();

const runFinished = z.object({
  event_type: z.literal("run_finished"),
  outcome: z.enum(["success", "task_failure", "policy_block", "tool_failure", "timeout", "cancelled", "budget_exhausted", "evaluation_error"]),
  elapsed_ms: z.number().int().nonnegative(),
  model_calls: z.number().int().nonnegative(),
  tool_calls_executed: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost_microusd: z.number().int().nonnegative().nullable(),
}).strict();

export const TraceEventSchema = z.discriminatedUnion("event_type", [
  common.extend(runStarted.shape).strict(),
  common.extend(modelUsage.shape).strict(),
  common.extend(toolCallProposed.shape).strict(),
  common.extend(policyDecision.shape).strict(),
  common.extend(toolCallStarted.shape).strict(),
  common.extend(toolCallFinished.shape).strict(),
  common.extend(evaluatorResult.shape).strict(),
  common.extend(runFinished.shape).strict(),
]);

export type TraceEvent = z.infer<typeof TraceEventSchema>;
type Proposed = Extract<TraceEvent, { event_type: "tool_call_proposed" }>;
type Decision = Extract<TraceEvent, { event_type: "policy_decision" }>;
type Started = Extract<TraceEvent, { event_type: "tool_call_started" }>;
type Finished = Extract<TraceEvent, { event_type: "tool_call_finished" }>;

export interface ExecutedToolCall {
  call_id: string;
  span_id: string;
  tool_name: string;
  arguments: unknown;
  arguments_sha256: string;
  status: Finished["status"];
  duration_ms: number;
  result_summary: string;
  state_change_ids: string[];
  error_code: string | null;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string { return JSON.stringify(sortJson(value)); }
export function sha256Hex(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
export function argumentsSha256(value: unknown): string { return sha256Hex(canonicalJson(value)); }

const forbiddenKey = /^(?:api[_-]?key|authorization|cookie|password|private[_-]?key|secret|access[_-]?token|refresh[_-]?token)$/i;
const secretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function assertNoSecrets(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    if (value !== "[REDACTED]" && secretPatterns.some((pattern) => pattern.test(value))) throw new Error(`Potential secret material at ${path}`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((child, index) => assertNoSecrets(child, `${path}[${index}]`)); return; }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (forbiddenKey.test(key)) throw new Error(`Forbidden secret-bearing field at ${path}.${key}`);
      assertNoSecrets(child, `${path}.${key}`);
    }
  }
}

export function validateTrace(input: unknown[]): TraceEvent[] {
  assertNoSecrets(input);
  const events = input.map((event, index) => {
    const result = TraceEventSchema.safeParse(event);
    if (!result.success) throw new Error(`Invalid trace event at index ${index}: ${result.error.message}`);
    return result.data;
  });
  if (events.length < 2) throw new Error("A trace requires run_started and run_finished events");
  if (events[0].event_type !== "run_started") throw new Error("The first event must be run_started");
  if (events.at(-1)?.event_type !== "run_finished") throw new Error("The last event must be run_finished");

  const runId = events[0].run_id;
  const taskId = events[0].task_id;
  let previousTimestamp = "";
  const proposals = new Map<string, Proposed>();
  const decisions = new Map<string, Decision>();
  const starts = new Map<string, Started>();
  const finishes = new Map<string, Finished>();

  for (const [index, event] of events.entries()) {
    if (event.sequence !== index) throw new Error(`Non-contiguous sequence at index ${index}`);
    if (event.run_id !== runId || event.task_id !== taskId) throw new Error(`Run/task identity changed at sequence ${index}`);
    if (previousTimestamp && event.timestamp < previousTimestamp) throw new Error(`Timestamp moved backwards at sequence ${index}`);
    previousTimestamp = event.timestamp;
    if (event.event_type === "tool_call_proposed") {
      if (proposals.has(event.call_id)) throw new Error(`Duplicate proposal for ${event.call_id}`);
      if (argumentsSha256(event.arguments) !== event.arguments_sha256) throw new Error(`Argument hash mismatch for ${event.call_id}`);
      proposals.set(event.call_id, event);
    } else if (event.event_type === "policy_decision") {
      const proposal = proposals.get(event.call_id);
      if (!proposal) throw new Error(`Policy decision precedes proposal for ${event.call_id}`);
      if (proposal.arguments_sha256 !== event.arguments_sha256) throw new Error(`Policy decision hash mismatch for ${event.call_id}`);
      if (decisions.has(event.call_id)) throw new Error(`Duplicate policy decision for ${event.call_id}`);
      decisions.set(event.call_id, event);
    } else if (event.event_type === "tool_call_started") {
      const proposal = proposals.get(event.call_id);
      const decision = decisions.get(event.call_id);
      if (!proposal || !decision) throw new Error(`Executed call lacks proposal or policy decision: ${event.call_id}`);
      if (decision.decision !== "allow") throw new Error(`Executed call was not allowed: ${event.call_id}`);
      if (proposal.tool_name !== event.tool_name || proposal.arguments_sha256 !== event.arguments_sha256) throw new Error(`Executed call differs from authorized proposal: ${event.call_id}`);
      if (argumentsSha256(event.arguments) !== event.arguments_sha256) throw new Error(`Started-call argument hash mismatch for ${event.call_id}`);
      if (starts.has(event.call_id)) throw new Error(`Duplicate start for ${event.call_id}`);
      starts.set(event.call_id, event);
    } else if (event.event_type === "tool_call_finished") {
      if (event.status === "succeeded" && event.error_code !== null) throw new Error(`Succeeded call has error_code: ${event.call_id}`);
      if (event.status !== "succeeded" && event.error_code === null) throw new Error(`Failed or cancelled call lacks error_code: ${event.call_id}`);
      const started = starts.get(event.call_id);
      if (!started) throw new Error(`Tool finish lacks start: ${event.call_id}`);
      if (started.span_id !== event.span_id) throw new Error(`Span mismatch for ${event.call_id}`);
      if (finishes.has(event.call_id)) throw new Error(`Duplicate finish for ${event.call_id}`);
      finishes.set(event.call_id, event);
    }
  }
  for (const callId of starts.keys()) if (!finishes.has(callId)) throw new Error(`Executed call lacks finish: ${callId}`);
  const finished = events.at(-1);
  if (finished?.event_type === "run_finished" && finished.tool_calls_executed !== starts.size) throw new Error("run_finished tool_calls_executed does not match reconstructed calls");
  return events;
}

export function parseTraceJsonl(jsonl: string): TraceEvent[] {
  const lines = jsonl.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsed = lines.map((line, index) => {
    try { return JSON.parse(line) as unknown; }
    catch (error) { throw new Error(`Invalid JSON on trace line ${index + 1}: ${String(error)}`); }
  });
  return validateTrace(parsed);
}

export function serializeTraceJsonl(events: TraceEvent[]): string {
  const valid = validateTrace(events);
  return `${valid.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export function reconstructExecutedToolCalls(events: TraceEvent[]): ExecutedToolCall[] {
  const valid = validateTrace(events);
  const starts = new Map<string, Started>();
  const reconstructed: ExecutedToolCall[] = [];
  for (const event of valid) {
    if (event.event_type === "tool_call_started") starts.set(event.call_id, event);
    if (event.event_type === "tool_call_finished") {
      const started = starts.get(event.call_id);
      if (!started) throw new Error(`Missing start for ${event.call_id}`);
      reconstructed.push({ call_id: event.call_id, span_id: event.span_id, tool_name: started.tool_name, arguments: started.arguments, arguments_sha256: started.arguments_sha256, status: event.status, duration_ms: event.duration_ms, result_summary: event.result_summary, state_change_ids: event.state_change_ids, error_code: event.error_code });
    }
  }
  return reconstructed;
}
