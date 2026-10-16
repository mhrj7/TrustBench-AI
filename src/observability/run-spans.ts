import { createHash } from "node:crypto";
import { context, trace, SpanStatusCode, type Context, type Span, type Tracer } from "@opentelemetry/api";
import { canonicalJson } from "../../schemas/trace.ts";
import type { AgentToolRegistry } from "../agent/contracts.ts";

/**
 * Spans for one agent run (TB-027). One trace per run: a root `agent.run` span, with `model.call`, `tool.call` and
 * `policy.decision` children. Every span carries `run.id`. Model spans separate queueing (pacing waits) from service
 * time, so reported latency includes the queue. Attribute values are metadata only; the exporter redacts at export.
 */
const round = (x: number) => Number(x.toFixed(3));
const codeOf = (error: unknown) => (typeof (error as any)?.code === "string" ? (error as any).code : (error as Error)?.name ?? "unknown_error");

export class RunSpans {
  readonly runId: string;
  private readonly tracer: Tracer;
  private readonly root: Span;
  private readonly ctx: Context;
  queueMs = 0;
  modelCalls = 0;
  toolAttempts = 0;

  constructor(tracer: Tracer, attributes: Record<string, string | number>) {
    this.tracer = tracer;
    this.runId = String(attributes["run.id"]);
    this.root = tracer.startSpan("agent.run", { attributes }, context.active());
    this.ctx = trace.setSpan(context.active(), this.root);
  }

  private child(name: string, attributes: Record<string, unknown>, startTime?: number): Span {
    return this.tracer.startSpan(name, { attributes: { "run.id": this.runId, ...attributes } as any, ...(startTime !== undefined ? { startTime } : {}) }, this.ctx);
  }

  /** Wraps one model request: `wait` is the pacing that precedes it (queueing), `call` the provider request. */
  async model<T extends { usage: { input_tokens: number; output_tokens: number }; finish_reason: string; tool_calls: unknown[] }>(
    role: string, requestId: string, wait: () => Promise<void>, call: () => Promise<T>): Promise<T> {
    const span = this.child("model.call", { "model.role": role, "model.request_id": requestId });
    const queued = performance.now();
    await wait();
    const queue = performance.now() - queued;
    this.queueMs += queue;
    this.modelCalls++;
    span.setAttribute("queue.ms", round(queue));
    if (queue >= 1) span.setAttribute("queue.reason", "provider_pacing"); // waited at least 1 ms for rate pacing
    span.addEvent("dequeued");
    try {
      const response = await call();
      span.setAttributes({ "model.input_tokens": response.usage.input_tokens, "model.output_tokens": response.usage.output_tokens, "model.finish_reason": response.finish_reason, "model.tool_calls": response.tool_calls.length });
      return response;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute("error.code", codeOf(error));
      throw error;
    } finally { span.end(); }
  }

  /** Every tool execution attempt (retries included) becomes a span; retrieval-class tools are tagged. */
  tools(registry: AgentToolRegistry, classes: { read: string[]; write: string[] }): AgentToolRegistry {
    const cls = (name: string) => (classes.read.includes(name) ? "retrieval" : classes.write.includes(name) ? "write" : "other");
    return Object.fromEntries(Object.entries(registry).map(([name, tool]) => [name, {
      execute: async (args: Record<string, unknown>, ctx: any) => {
        this.toolAttempts++;
        const span = this.child("tool.call", { "tool.name": name, "tool.class": cls(name), "tool.call_id": ctx.callId, "tool.attempt": ctx.attempt ?? 1,
          "tool.arguments_sha256": createHash("sha256").update(canonicalJson(args)).digest("hex") });
        try {
          const result = await tool.execute(args, ctx);
          span.setAttributes({ "tool.status": "succeeded", "tool.output_bytes": Buffer.byteLength(JSON.stringify(result.output ?? null)) });
          return result;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttributes({ "tool.status": "failed", "tool.error_code": codeOf(error) });
          throw error;
        } finally { span.end(); }
      },
    }])) as AgentToolRegistry;
  }

  /** Gateway policy decisions, from the gateway's timed audit records (started_at_ms, policy_ms, backend_ms). */
  policy(decisions: Array<Record<string, any>>): void {
    for (const d of decisions) {
      if (typeof d.started_at_ms !== "number") continue;
      const span = this.child("policy.decision", { "tool.name": d.tool, "policy.decision": d.decision, "policy.reason": d.reason ?? "", "policy.seq": d.seq,
        "policy.executed": Boolean(d.executed), "policy.ms": d.policy_ms ?? 0, ...(typeof d.backend_ms === "number" ? { "policy.backend_ms": d.backend_ms } : {}) }, d.started_at_ms);
      span.end(d.started_at_ms + (d.policy_ms ?? 0));
    }
  }

  end(attributes: Record<string, string | number | boolean>, retryBackoffMs: number): void {
    this.root.setAttributes({ ...attributes, "run.queue_ms_total": round(this.queueMs), "run.retry_backoff_ms": retryBackoffMs, "run.model_calls": this.modelCalls, "run.attempts_total": this.toolAttempts });
    this.root.end();
  }
}
