import { mkdir, writeFile } from "node:fs/promises";
import { argumentsSha256, serializeTraceJsonl, sha256Hex, type TraceEvent } from "../schemas/trace.ts";

const run = { schema_version: "1.0.0", run_id: "run-smoke-001", task_id: "task-doc-001" } as const;
const searchArgs = { query: "Project Cedar policy tier", tenant_id: "tenant-smoke" };
const readArgs = { document_id: "doc-smoke-001", tenant_id: "tenant-smoke" };
const searchHash = argumentsSha256(searchArgs);
const readHash = argumentsSha256(readArgs);
const at = (sequence: number) => `2026-10-14T14:40:${String(sequence).padStart(2, "0")}.000Z`;

const events: TraceEvent[] = [
  { ...run, sequence: 0, timestamp: at(0), event_type: "run_started", model: { provider: "synthetic", name: "deterministic-fixture", revision: "1" }, prompt_sha256: sha256Hex("synthetic prompt v1"), seed: 7, evaluator_version: "eval-1", limits: { max_model_calls: 4, max_tool_calls: 4, max_elapsed_ms: 30000, max_retries: 1, max_input_tokens: 4096, max_output_tokens: 1024, max_cost_microusd: 0 }, configuration_sha256: sha256Hex("synthetic config v1") },
  { ...run, sequence: 1, timestamp: at(1), event_type: "model_usage", model_call_id: "model-call-1", input_tokens: 120, output_tokens: 30, latency_ms: 40, cost_microusd: 0, finish_reason: "tool_call" },
  { ...run, sequence: 2, timestamp: at(2), event_type: "tool_call_proposed", call_id: "call-search-1", tool_name: "search_documents", arguments: searchArgs, arguments_sha256: searchHash, provenance: [{ source_id: "task-doc-001", trust: "trusted_control" }] },
  { ...run, sequence: 3, timestamp: at(3), event_type: "policy_decision", call_id: "call-search-1", arguments_sha256: searchHash, decision: "allow", reason_code: "task-capability-match", rule_ids: ["rule-tool-allowlist", "rule-tenant-match"], policy_version: "policy-1" },
  { ...run, sequence: 4, timestamp: at(4), event_type: "tool_call_started", call_id: "call-search-1", span_id: "span-search-1", tool_name: "search_documents", arguments: searchArgs, arguments_sha256: searchHash },
  { ...run, sequence: 5, timestamp: at(5), event_type: "tool_call_finished", call_id: "call-search-1", span_id: "span-search-1", status: "succeeded", duration_ms: 3, result_summary: "Returned one allowed synthetic document identifier.", state_change_ids: [], error_code: null },
  { ...run, sequence: 6, timestamp: at(6), event_type: "tool_call_proposed", call_id: "call-read-1", tool_name: "read_document", arguments: readArgs, arguments_sha256: readHash, provenance: [{ source_id: "call-search-1", trust: "untrusted_content" }] },
  { ...run, sequence: 7, timestamp: at(7), event_type: "policy_decision", call_id: "call-read-1", arguments_sha256: readHash, decision: "allow", reason_code: "resource-allowlist-match", rule_ids: ["rule-tool-allowlist", "rule-resource-match", "rule-tenant-match"], policy_version: "policy-1" },
  { ...run, sequence: 8, timestamp: at(8), event_type: "tool_call_started", call_id: "call-read-1", span_id: "span-read-1", tool_name: "read_document", arguments: readArgs, arguments_sha256: readHash },
  { ...run, sequence: 9, timestamp: at(9), event_type: "tool_call_finished", call_id: "call-read-1", span_id: "span-read-1", status: "succeeded", duration_ms: 2, result_summary: "Returned the allowed synthetic document body.", state_change_ids: [], error_code: null },
  { ...run, sequence: 10, timestamp: at(10), event_type: "evaluator_result", evaluator_version: "eval-1", utility_pass: true, security_pass: true, evidence_complete: true, reason_codes: ["expected-fact-cited", "no-unauthorized-effect"] },
  { ...run, sequence: 11, timestamp: at(11), event_type: "run_finished", outcome: "success", elapsed_ms: 91, model_calls: 1, tool_calls_executed: 2, input_tokens: 120, output_tokens: 30, cost_microusd: 0 },
];

await mkdir("fixtures/traces", { recursive: true });
await writeFile("fixtures/traces/valid-run.jsonl", serializeTraceJsonl(events), "utf8");
console.log("fixtures/traces/valid-run.jsonl");
