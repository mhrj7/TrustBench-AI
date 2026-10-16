import { observabilityConfig, sensitiveValues } from "./tracing.ts";

interface SpanRecord { trace_id: string; span_id: string; parent_span_id: string | null; name: string; attributes: Record<string, any> }
/** TB-027 acceptance check over one JSON-lines span export: run linkage, allowlisted attributes, queue timing, no sensitive values. */
export function checkSpans(text: string, cfg = observabilityConfig()) {
  const allow = new Set<string>(cfg.span_attribute_allowlist);
  const secrets = sensitiveValues(cfg);
  const problems: string[] = [];
  const spans: SpanRecord[] = text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l)) : [];
  const byTrace = new Map<string, SpanRecord[]>();
  for (const s of spans) byTrace.set(s.trace_id, [...(byTrace.get(s.trace_id) ?? []), s]);
  for (const [traceId, list] of byTrace) {
    const roots = list.filter((s) => s.parent_span_id === null);
    if (roots.length !== 1 || roots[0].name !== "agent.run") { problems.push(`trace ${traceId}: ${roots.length} root spans (need exactly one agent.run)`); continue; }
    const runId = roots[0].attributes["run.id"];
    if (!runId) problems.push(`trace ${traceId}: root has no run.id`);
    const ids = new Set(list.map((s) => s.span_id));
    for (const s of list) {
      if (s.attributes["run.id"] !== runId) problems.push(`span ${s.span_id} (${s.name}) has run.id ${s.attributes["run.id"]}, its run is ${runId}`);
      if (s.parent_span_id !== null && !ids.has(s.parent_span_id)) problems.push(`span ${s.span_id} (${s.name}) has a parent outside its trace`);
      if (s.name === "model.call" && typeof s.attributes["queue.ms"] !== "number") problems.push(`model span ${s.span_id} has no queue timing`);
    }
  }
  for (const s of spans) for (const k of Object.keys(s.attributes)) if (!allow.has(k)) problems.push(`span ${s.span_id} exports non-allowlisted attribute ${k}`);
  for (const secret of secrets) if (text.includes(secret)) problems.push(`sensitive fixture value found: ${secret.slice(0, 12)}…`);
  const count = (n: string) => spans.filter((s) => s.name === n).length;
  return { problems, stats: { spans: spans.length, runs: byTrace.size, model_spans: count("model.call"), tool_spans: count("tool.call"), retrieval_spans: spans.filter((s) => s.attributes["tool.class"] === "retrieval").length,
    policy_spans: count("policy.decision"), runs_with_queueing: [...byTrace.values()].filter((l) => l.some((s) => (s.attributes["queue.ms"] ?? 0) >= 1)).length } };
}

