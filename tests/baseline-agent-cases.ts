import type { BudgetConfig } from "../runtime/budget.ts";
import { runBaselineAgent, type AgentToolRegistry, type BaselineAgentResult } from "../src/agent/index.ts";
import { MockModelAdapter, NormalizedProviderError, type GenerationSettings, type MockOutcome } from "../src/models/index.ts";

const settings: GenerationSettings = {
  max_output_tokens: 128,
  temperature: null,
  top_p: null,
  seed: 17,
  reasoning_effort: "medium",
};

const baseBudget: BudgetConfig = {
  schema_version: "1.0.0",
  pricing: {
    provider: "openai", runtime_model_alias: "test/model", pricing_model_id: "test-model", service_tier: "fast",
    context_band: "short", input_usd_per_million_tokens: 1, output_usd_per_million_tokens: 1,
    verified_at: "2026-10-14T00:00:00.000Z", source_url: "https://example.invalid/pricing", max_age_hours_at_provider_run: 24,
  },
  limits: {
    max_model_calls: 4, max_tool_calls: 4, max_input_tokens: 10000, max_output_tokens: 1000,
    max_retries: 0, max_elapsed_ms: 60000, max_cost_microusd: 10000,
  },
};

const tools: AgentToolRegistry = {
  read_document: {
    async execute(args) {
      if (args.resource_id === "explode") throw Object.assign(new Error("Synthetic tool failure"), { code: "synthetic_tool_failure" });
      return { output: { document_id: args.resource_id, content: "Synthetic Silver tier." }, stateChangeIds: [] };
    },
  },
};

type ScriptedOutcome = Exclude<MockOutcome, Error>;

const outcome = (id: string, calls: ScriptedOutcome["tool_calls"], text = "", finish: ScriptedOutcome["finish_reason"] = calls.length ? "tool_call" : "stop"): ScriptedOutcome => ({
  response_id: `response-${id}`,
  response_model: "mock-baseline-v1",
  output_text: text,
  tool_calls: calls,
  usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
  finish_reason: finish,
});

async function run(id: string, outcomes: MockOutcome[], options: { budget?: BudgetConfig; maxSteps?: number; timeoutMs?: number; onToolError?: "stop" | "continue" } = {}): Promise<{ result: BaselineAgentResult; adapter: MockModelAdapter }> {
  const adapter = new MockModelAdapter("mock-baseline", outcomes);
  const result = await runBaselineAgent({
    config: {
      run_id: `run-${id}`, task_id: `task-${id}`,
      system_prompt: "Use only the supplied synthetic tools.", user_prompt: "Complete the synthetic task.",
      generation_settings: settings,
      tools: [{ name: "read_document", description: "Read one allowed synthetic document.", parameters: { type: "object", properties: { resource_id: { type: "string" } }, required: ["resource_id"], additionalProperties: false } }],
      max_steps: options.maxSteps ?? 8,
      timeout_ms: options.timeoutMs ?? 1000,
      planned_input_tokens_per_call: 100, on_tool_error: options.onToolError ?? "stop",
    },
    adapter,
    tools,
    budgetConfig: options.budget ?? baseBudget,
  });
  return { result, adapter };
}

export async function runBaselineVerificationMatrix() {
  const success = await run("success", [
    outcome("success-1", [{ call_id: "call-success", tool_name: "read_document", arguments: { resource_id: "doc-001" } }]),
    outcome("success-2", [], "The synthetic tier is Silver."),
  ]);
  const modelFailure = await run("model-failure", [new NormalizedProviderError("mock", "server", true, "Synthetic model failure", 500)]);
  const toolFailure = await run("tool-failure", [outcome("tool-failure", [{ call_id: "call-failure", tool_name: "read_document", arguments: { resource_id: "explode" } }])]);
  const stepLimit = await run("step-limit", [outcome("step-limit", [{ call_id: "call-limit", tool_name: "read_document", arguments: { resource_id: "doc-001" } }])], { maxSteps: 2 });
  const budget = await run("budget", [
    outcome("budget-1", [{ call_id: "call-budget", tool_name: "read_document", arguments: { resource_id: "doc-001" } }]),
    outcome("budget-2", [], "This must never be reached."),
  ], { budget: { ...baseBudget, limits: { ...baseBudget.limits, max_model_calls: 1 } } });

  let timeoutSignalAborted = false;
  const hanging = {
    provider: "hanging", modelId: "hanging-model",
    generate: async (_request: unknown, options?: { signal?: AbortSignal }) => await new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => { timeoutSignalAborted = true; reject(options.signal?.reason); }, { once: true });
    }),
  };
  const timeout = await runBaselineAgent({
    config: {
      run_id: "run-timeout", task_id: "task-timeout", system_prompt: "Synthetic timeout test.", user_prompt: "Wait.",
      generation_settings: settings, tools: [], max_steps: 4, timeout_ms: 20, planned_input_tokens_per_call: 100, on_tool_error: "stop",
    },
    adapter: hanging,
    tools: {},
    budgetConfig: baseBudget,
  });

  const continued = await run("continue", [
    outcome("continue-1", [{ call_id: "call-bad", tool_name: "read_document", arguments: { resource_id: "explode" } }]),
    outcome("continue-2", [{ call_id: "call-good", tool_name: "read_document", arguments: { resource_id: "doc-001" } }]),
    outcome("continue-3", [], "Recovered after the failed call."),
  ], { onToolError: "continue" });
  return { success, modelFailure, toolFailure, stepLimit, budget, timeout, timeoutSignalAborted, settings, continued };
}
