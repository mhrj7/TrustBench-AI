import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { HrTime } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";

/**
 * TB-027 tracing: OpenTelemetry spans for model calls, tool calls (retrieval-class tools tagged), gateway policy decisions
 * and the run root, exported as JSON lines. Export is the redaction point: only allowlisted attributes leave the process,
 * and registered sensitive fixture values are replaced in every remaining string (configs/observability.yaml).
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const observabilityConfig = () => JSON.parse(readFileSync(path.join(root, "configs/observability.yaml"), "utf8"));

/** Sensitive values seeded into fixtures, read from the data files named in the config. */
export function sensitiveValues(cfg = observabilityConfig()): string[] {
  const s = cfg.sensitive_values, out = new Set<string>();
  const walk = (v: unknown, key = "") => {
    if (typeof v === "string") { if (!s.attack_seed_skip_keys.includes(key) && !v.includes("{") && v.length >= s.min_length) out.add(v); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  // Sealed holdout fixtures are never read for development purposes, redaction included (protocol/preregister.md).
  const holdout = new Set<string>(JSON.parse(readFileSync(path.join(root, "data/splits.json"), "utf8")).holdout_manifest.fixture_ids);
  const seeds = JSON.parse(readFileSync(path.join(root, s.attack_seed_file), "utf8")).attacks;
  for (const [attackId, add] of Object.entries(seeds)) if (!holdout.has(attackId)) walk(add);
  for (const line of readFileSync(path.join(root, s.benign_file), "utf8").trim().split("\n")) {
    const fixture = JSON.parse(line);
    if (holdout.has(fixture.fixture_id)) continue;
    const state = fixture.initial_state ?? {};
    for (const [collection, fields] of Object.entries(s.benign_fields as Record<string, string[]>))
      for (const row of state[collection] ?? []) for (const f of fields) if (typeof row[f] === "string" && row[f].length >= s.min_length) out.add(row[f]);
  }
  return [...out].sort((a, b) => b.length - a.length); // longest first, so overlapping values are fully replaced
}

export class Redactor {
  readonly dropped = new Map<string, number>();
  replaced = 0;
  private readonly allow: Set<string>;
  private readonly secrets: string[];
  private readonly placeholder: string;
  constructor(allow: Set<string>, secrets: string[], placeholder: string) { this.allow = allow; this.secrets = secrets; this.placeholder = placeholder; }
  static fromConfig(cfg = observabilityConfig()) { return new Redactor(new Set(cfg.span_attribute_allowlist), sensitiveValues(cfg), cfg.redaction_placeholder); }
  scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets) if (out.includes(secret)) { out = out.split(secret).join(this.placeholder); this.replaced++; }
    return out;
  }
  attributes(attrs: Record<string, unknown>): Record<string, unknown> {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (!this.allow.has(k)) { this.dropped.set(k, (this.dropped.get(k) ?? 0) + 1); continue; }
      kept[k] = typeof v === "string" ? this.scrub(v) : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? this.scrub(x) : x)) : v;
    }
    return kept;
  }
}

const ms = (t: HrTime) => t[0] * 1000 + t[1] / 1e6;

/** One JSON object per span; the file is the JSON log the acceptance check reads. */
export class JsonlSpanExporter implements SpanExporter {
  private readonly file: string;
  private readonly redactor: Redactor;
  constructor(file: string, redactor: Redactor) { this.file = file; this.redactor = redactor; mkdirSync(path.dirname(file), { recursive: true }); }
  export(spans: ReadableSpan[], done: (r: ExportResult) => void): void {
    try {
      for (const s of spans) {
        const ctx = s.spanContext();
        const record = {
          trace_id: ctx.traceId, span_id: ctx.spanId, parent_span_id: s.parentSpanContext?.spanId ?? null, name: s.name,
          start_ms: Number(ms(s.startTime).toFixed(3)), end_ms: Number(ms(s.endTime).toFixed(3)), duration_ms: Number(ms(s.duration).toFixed(3)),
          status: s.status.code === 2 ? "error" : "ok", attributes: this.redactor.attributes(s.attributes as Record<string, unknown>),
          events: s.events.map((e) => ({ name: this.redactor.scrub(e.name), at_ms: Number(ms(e.time).toFixed(3)), attributes: this.redactor.attributes((e.attributes ?? {}) as Record<string, unknown>) })),
        };
        appendFileSync(this.file, JSON.stringify(record) + "\n");
      }
      done({ code: ExportResultCode.SUCCESS });
    } catch (error) { done({ code: ExportResultCode.FAILED, error: error as Error }); }
  }
  async shutdown(): Promise<void> {}
}

export function createTracing(file: string, serviceName: string) {
  const redactor = Redactor.fromConfig();
  const provider = new BasicTracerProvider({ resource: resourceFromAttributes({ "service.name": serviceName }), spanProcessors: [new SimpleSpanProcessor(new JsonlSpanExporter(file, redactor))] });
  return { tracer: provider.getTracer("trustbench"), provider, redactor };
}
