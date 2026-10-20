// TB-004 trace for external-agent runs (docs/external/integration-contract.md, "Trace"). The adapter and the model proxy
// append events as they happen; finish() validates the whole trace against schemas/trace.ts and writes it as JSONL.
import { appendFileSync, writeFileSync } from "node:fs";
import { argumentsSha256, validateTrace, type TraceEvent } from "../../schemas/trace.ts";

type Body = Record<string, unknown> & { event_type: TraceEvent["event_type"] };

export class TraceRecorder {
  readonly events: TraceEvent[] = [];
  private lastTs = "";
  private failed: Error | null = null;
  private readonly runId: string;
  private readonly taskId: string;
  private readonly file: string | null;
  constructor(runId: string, taskId: string, file: string | null) {
    this.runId = runId; this.taskId = taskId; this.file = file;
    if (file) { try { writeFileSync(file, ""); } catch (error) { this.failed = error instanceof Error ? error : new Error(String(error)); } }
  }

  /** Throws (and keeps failing) once any write has failed, so the adapter can fail closed. */
  append(body: Body): void {
    if (this.failed) throw this.failed;
    let ts = new Date().toISOString();
    if (ts < this.lastTs) ts = this.lastTs;
    this.lastTs = ts;
    const event = { schema_version: "1.0.0", run_id: this.runId, task_id: this.taskId, sequence: this.events.length, timestamp: ts, ...body } as unknown as TraceEvent;
    try {
      if (this.file) appendFileSync(this.file, JSON.stringify(event) + "\n");
    } catch (error) {
      this.failed = error instanceof Error ? error : new Error(String(error));
      throw this.failed;
    }
    this.events.push(event);
  }

  get broken(): boolean { return this.failed !== null; }

  proposed(callId: string, tool: string, args: unknown): void {
    this.append({ event_type: "tool_call_proposed", call_id: callId, tool_name: tool, arguments: args, arguments_sha256: argumentsSha256(args), provenance: [{ source_id: "external-agent", trust: "untrusted_model_output" }] });
  }

  decision(callId: string, args: unknown, decision: "allow" | "deny" | "require_approval", reason: string, rule: string, policyVersion: string): void {
    this.append({ event_type: "policy_decision", call_id: callId, arguments_sha256: argumentsSha256(args), decision, reason_code: reason, rule_ids: [rule], policy_version: policyVersion });
  }

  started(callId: string, tool: string, args: unknown): void {
    this.append({ event_type: "tool_call_started", call_id: callId, span_id: `span-${callId}`, tool_name: tool, arguments: args, arguments_sha256: argumentsSha256(args) });
  }

  finished(callId: string, ok: boolean, durationMs: number, summary: string, errorCode: string | null, stateChangeIds: string[] = []): void {
    this.append({ event_type: "tool_call_finished", call_id: callId, span_id: `span-${callId}`, status: ok ? "succeeded" : "failed", duration_ms: Math.max(0, Math.round(durationMs)), result_summary: summary.slice(0, 1000), state_change_ids: stateChangeIds, error_code: ok ? null : errorCode ?? "tool_error" });
  }

  /** Validates the complete trace; returns the validation error instead of throwing, so a bad trace is reported, not lost. */
  validate(): string | null {
    try { validateTrace(this.events as unknown[]); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
  }
}
