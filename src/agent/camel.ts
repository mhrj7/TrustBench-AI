import { readFileSync } from "node:fs";
import path from "node:path";
import { BudgetController, BudgetExhaustedError, type BudgetConfig } from "../../runtime/budget.ts";
import { canonicalJson } from "../../schemas/trace.ts";
import { RecoveryManager, type RecoveryPolicy } from "./recovery.ts";
import type { DefenseStats } from "./defenses.ts";
import type { ModelAdapter, ModelRequest } from "../models/contracts.ts";
import {
  AgentRunConfigSchema, type AgentFailure, type AgentRunConfig, type AgentToolRecord, type AgentToolRegistry,
  type AgentTransition, type BaselineAgentResult,
} from "./contracts.ts";

/**
 * CaMeL-style agent (Debenedetti et al. 2025, "Defeating Prompt Injections by Design"), re-implemented on this harness.
 * A privileged planner sees only the trusted task and tool specs and writes a plan; it never sees tool outputs. A
 * quarantined extractor (the same model, no tools) turns untrusted tool output into one typed value per query. Every
 * value carries its sources, and a per-tool policy (configs/defenses.yaml `architectures.camel.policy`) refuses write
 * calls whose control arguments depend on anything but the planner's own literals. Simplifications, disclosed in the
 * system's family label: a JSON plan instead of Python code, linear plans, and replanning that sees error codes only.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const template = (relative: string) => readFileSync(path.join(root, relative), "utf8").trim();
const fill = (text: string, values: Record<string, string>) => text.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in values ? values[k]! : m));

export interface CamelArchitecture {
  planner_prompt_template: string;
  query_prompt_template: string;
  replan_prompt_template: string;
  max_replans: number;
  trusted_source: string;
  policy: { control_arguments: Record<string, string[]> };
  denied_error_code: string;
  plan_error_code: string;
  insufficient_information_code: string;
}

type Message = ModelRequest["messages"][number];
interface Value { value: unknown; sources: string[] }
type PlanStep =
  | { id: string; tool: string; args: Record<string, unknown> }
  | { id: string; query: { from: string[]; question: string; type: "string" | "number" | "boolean" | "string_list" } };
interface Plan { steps: PlanStep[]; final: string }

class StepError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the response");
  return JSON.parse(text.slice(start, end + 1));
}

export function parsePlan(text: string): Plan {
  const raw = firstJsonObject(text) as Record<string, unknown>;
  if (!raw || !Array.isArray(raw.steps)) throw new Error("plan has no steps array");
  const ids = new Set<string>();
  const steps = raw.steps.map((s: any, i: number): PlanStep => {
    if (!s || typeof s.id !== "string" || !s.id) throw new Error(`step ${i} has no id`);
    if (ids.has(s.id)) throw new Error(`duplicate step id ${s.id}`);
    ids.add(s.id);
    if (typeof s.tool === "string") return { id: s.id, tool: s.tool, args: s.args && typeof s.args === "object" ? s.args : {} };
    // Flat form {"query_from", "question", "type"} (the registered prompt) or nested {"query": {"from", ...}}.
    const q = s.query ?? (Array.isArray(s.query_from) ? { from: s.query_from, question: s.question, type: s.type } : null);
    if (q && Array.isArray(q.from) && typeof q.question === "string" && ["string", "number", "boolean", "string_list"].includes(q.type)) return { id: s.id, query: { from: q.from, question: q.question, type: q.type } };
    throw new Error(`step ${s.id} is neither a tool call nor a valid query`);
  });
  return { steps, final: typeof raw.final === "string" ? raw.final : "" };
}

const isRef = (v: unknown): v is { $ref: string } => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as any).$ref === "string" && Object.keys(v as object).length === 1;

/** Resolves a plan value to a concrete value and the union of its sources. */
export function resolveValue(v: unknown, env: Map<string, Value>, trusted: string): Value {
  if (isRef(v)) {
    const found = env.get(v.$ref);
    if (!found) throw new StepError("camel_unknown_reference", `reference to unknown step ${v.$ref}`);
    return found;
  }
  if (Array.isArray(v)) {
    const parts = v.map((x) => resolveValue(x, env, trusted));
    return { value: parts.map((p) => p.value), sources: [...new Set(parts.flatMap((p) => p.sources))] };
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v).map(([k, x]) => [k, resolveValue(x, env, trusted)] as const);
    return { value: Object.fromEntries(entries.map(([k, p]) => [k, p.value])), sources: [...new Set(entries.flatMap(([, p]) => p.sources))] };
  }
  return { value: v, sources: [trusted] };
}

/** Policy check: the arguments the policy marks as control arguments may only carry trusted (planner-literal) sources. */
export function policyViolation(tool: string, args: Record<string, Value>, arch: CamelArchitecture): string | null {
  const control = arch.policy.control_arguments[tool];
  if (!control) return null;
  const names = control.includes("*") ? Object.keys(args) : control;
  for (const name of names) {
    const v = args[name];
    if (v && v.sources.some((s) => s !== arch.trusted_source)) return name;
  }
  return null;
}

export interface CamelStats extends DefenseStats {
  camel: { plans: string[]; replans: number; policy_denials: Array<{ step: string; tool: string; argument: string; sources: string[] }>; queries: number; insufficient_information: number };
}

export async function runCamelAgent(input: {
  config: AgentRunConfig;
  adapter: ModelAdapter;
  tools: AgentToolRegistry;
  budgetConfig: BudgetConfig;
  architecture: CamelArchitecture;
  recovery?: { policy: RecoveryPolicy; seed: number };
}): Promise<BaselineAgentResult> {
  const config = AgentRunConfigSchema.parse(input.config);
  const arch = input.architecture;
  const budget = new BudgetController(input.budgetConfig);
  const runController = new AbortController();
  budget.signal.addEventListener("abort", () => runController.abort(budget.signal.reason), { once: true });
  const manager = input.recovery ? new RecoveryManager({ policy: input.recovery.policy, budget, signal: runController.signal, runId: config.run_id, seed: input.recovery.seed }) : null;
  const stats: CamelStats = { defenses: ["camel"], model_calls: 0, input_tokens: 0, output_tokens: 0, filtered_tools: null, filter_parse_failed: false, vetoes: [], checks: 0,
    camel: { plans: [], replans: 0, policy_denials: [], queries: 0, insufficient_information: 0 } };
  const transitions: AgentTransition[] = [];
  const toolRecords: AgentToolRecord[] = [];
  const failures: AgentFailure[] = [];
  let steps = 0;
  const env = new Map<string, Value>();
  const toolSpecs = canonicalJson(config.tools);
  const planner: Message[] = [
    { role: "system", content: `${config.system_prompt}\n\n${fill(template(arch.planner_prompt_template), { tool_specs: toolSpecs })}` },
    { role: "user", content: config.user_prompt },
  ];

  const plannerCall = async (): Promise<string> => {
    steps++; transitions.push({ step: steps, node: "model", detail: `planner_call_${budget.snapshot().model_calls + 1}` });
    budget.beginModelCall(config.planned_input_tokens_per_call, config.generation_settings.max_output_tokens);
    const request = { request_id: `${config.run_id}-planner-${budget.snapshot().model_calls}`, messages: structuredClone(planner), tools: [], settings: structuredClone(config.generation_settings) };
    const response = manager ? await manager.callModel("generate", (signal) => input.adapter.generate(request, { signal })) : await input.adapter.generate(request, { signal: runController.signal });
    budget.recordModelUsage(response.usage.input_tokens, response.usage.output_tokens);
    if (response.output_text.trim()) planner.push({ role: "assistant", content: response.output_text }); // empty messages are not valid requests
    stats.camel.plans.push(response.output_text.slice(0, 4000));
    return response.output_text;
  };

  const query = async (step: Extract<PlanStep, { query: unknown }>): Promise<Value> => {
    const inputs = step.query.from.map((id) => { const v = env.get(id); if (!v) throw new StepError("camel_unknown_reference", `query reads unknown step ${id}`); return v; });
    const data = inputs.map((v) => canonicalJson(v.value)).join("\n\n");
    stats.camel.queries++;
    steps++; transitions.push({ step: steps, node: "model", detail: `quarantined_query_${step.id}` });
    const request = { request_id: `${config.run_id}-query-${stats.camel.queries}`, messages: [{ role: "user" as const, content: fill(template(arch.query_prompt_template), { question: step.query.question, type: step.query.type, data }) }], tools: [], settings: structuredClone(config.generation_settings) };
    const response = manager ? await manager.callModel("generate", (signal) => input.adapter.generate(request, { signal })) : await input.adapter.generate(request, { signal: runController.signal });
    stats.model_calls++; stats.input_tokens += response.usage.input_tokens; stats.output_tokens += response.usage.output_tokens;
    let parsed: any;
    try { parsed = firstJsonObject(response.output_text); } catch { throw new StepError(arch.insufficient_information_code, "quarantined extractor returned no JSON"); }
    if (parsed?.have_enough_information !== true || parsed.value === null || parsed.value === undefined) { stats.camel.insufficient_information++; throw new StepError(arch.insufficient_information_code, "quarantined extractor reported insufficient information"); }
    // The value inherits every source of the data it was extracted from (capability propagation).
    return { value: parsed.value, sources: [...new Set(inputs.flatMap((v) => v.sources))] };
  };

  const callTool = async (step: Extract<PlanStep, { tool: string }>) => {
    const resolved = Object.fromEntries(Object.entries(step.args).map(([k, v]) => [k, resolveValue(v, env, arch.trusted_source)]));
    const args = Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, v.value])) as Record<string, unknown>;
    const callId = `call-${toolRecords.length + 1}`;
    steps++; transitions.push({ step: steps, node: "tool", detail: step.tool });
    stats.checks++;
    const fail = (code: string, message: string) => {
      failures.push({ node: "tool", code, message: message.slice(0, 1000), call_id: callId });
      toolRecords.push({ call_id: callId, tool_name: step.tool, status: "failed", arguments: args, output: null, state_change_ids: [], error_code: code });
      return new StepError(code, message);
    };
    const tool = input.tools[step.tool];
    if (!tool) throw fail("tool_not_registered", `Tool is not registered: ${step.tool}`);
    const violated = policyViolation(step.tool, resolved, arch);
    if (violated) {
      stats.camel.policy_denials.push({ step: step.id, tool: step.tool, argument: violated, sources: resolved[violated]!.sources });
      stats.vetoes.push({ call_id: callId, tool: step.tool, defense: "camel", matched_on: `argument ${violated} depends on ${resolved[violated]!.sources.join(",")}` });
      throw fail(arch.denied_error_code, `CaMeL policy: argument ${violated} of ${step.tool} depends on untrusted data`);
    }
    budget.recordToolCall();
    try {
      const context = { runId: config.run_id, taskId: config.task_id, callId };
      const attempt = manager
        ? await manager.callTool(step.tool, args, callId, (signal, n) => tool.execute(args, { ...context, signal, attempt: n }))
        : { value: await tool.execute(args, { ...context, signal: runController.signal }), attempts: 1, replayed: false };
      toolRecords.push({ call_id: callId, tool_name: step.tool, status: "succeeded", arguments: args, output: attempt.value.output, state_change_ids: attempt.replayed ? [] : attempt.value.stateChangeIds, error_code: null });
      env.set(step.id, { value: attempt.value.output, sources: [`tool:${step.tool}`] });
    } catch (error) {
      if (error instanceof BudgetExhaustedError) throw error;
      const code = typeof (error as any)?.code === "string" ? (error as any).code : "tool_error";
      throw fail(code, error instanceof Error ? error.message : String(error));
    }
  };

  const result = (outcome: BaselineAgentResult["outcome"], finalText: string): BaselineAgentResult => {
    transitions.push({ step: steps, node: "termination", detail: outcome });
    const b = budget.snapshot();
    return { run_id: config.run_id, task_id: config.task_id, outcome, final_text: finalText, steps, generation_settings: config.generation_settings,
      messages: planner, transitions, tool_records: toolRecords, failures, defense: stats, ...(manager ? { recovery: manager.summary() } : {}),
      budget: { model_calls: b.model_calls, tool_calls: b.tool_calls, input_tokens: b.input_tokens, output_tokens: b.output_tokens, retries: b.retries, elapsed_ms: b.elapsed_ms, cost_microusd: b.cost_microusd, pending_work_cancelled: false, exhausted_dimension: b.exhausted_dimension ?? null } };
  };

  const timeout = setTimeout(() => runController.abort(new Error("timeout")), config.timeout_ms);
  try {
    let text = await plannerCall();
    for (let attempt = 0; ; attempt++) {
      let plan: Plan | null = null;
      let failedStep = "plan", failedCode = arch.plan_error_code, detail = "";
      try { plan = parsePlan(text); } catch (error) {
        detail = text.trim() ? String((error as Error).message).slice(0, 200) : "the plan was empty"; // describes the planner's own output, never tool data
        failures.push({ node: "model", code: arch.plan_error_code, message: detail, call_id: null });
      }
      if (plan) {
        try {
          for (const step of plan.steps) {
            if (env.has(step.id)) continue; // a replan may reference steps that already ran
            if ("tool" in step) await callTool(step);
            else env.set(step.id, await query(step));
          }
          const finalText = plan.final.replace(/\{([A-Za-z0-9_.-]+)\}/g, (m, id: string) => (env.has(id) ? String(typeof env.get(id)!.value === "string" ? env.get(id)!.value : canonicalJson(env.get(id)!.value)) : m));
          return result("success", finalText || "Done.");
        } catch (error) {
          if (error instanceof BudgetExhaustedError) throw error;
          if (!(error instanceof StepError)) throw error;
          failedCode = error.code; detail = "see error code";
          failedStep = plan.steps.find((s) => !env.has(s.id))?.id ?? "unknown";
          if (error.code === arch.insufficient_information_code) failures.push({ node: "model", code: error.code, message: error.message, call_id: null });
        }
      }
      if (attempt >= arch.max_replans) return result("failure", "");
      stats.camel.replans++;
      // Replanning sees only trusted metadata: the failing step id, the error code and the ids of finished steps.
      planner.push({ role: "user", content: fill(template(arch.replan_prompt_template), { step_id: failedStep, error_code: failedCode, detail, done_steps: [...env.keys()].join(", ") || "(none)" }) });
      text = await plannerCall();
    }
  } catch (error) {
    if (error instanceof BudgetExhaustedError) { failures.push({ node: "model", code: error.name, message: error.message.slice(0, 1000), call_id: null }); return result("budget_exhausted", ""); }
    if (runController.signal.aborted) { failures.push({ node: "model", code: "AgentTimeoutError", message: "CaMeL agent exceeded its wall-clock timeout", call_id: null }); return result("timeout", ""); }
    const code = typeof (error as any)?.code === "string" ? (error as any).code : (error as Error)?.name ?? "unknown_error";
    failures.push({ node: "model", code, message: String((error as Error)?.message ?? error).slice(0, 1000), call_id: null });
    return result("failure", "");
  } finally { clearTimeout(timeout); }
}
