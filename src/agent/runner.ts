import { BudgetController, BudgetExhaustedError, type BudgetConfig } from "../../runtime/budget.ts";
import { canonicalJson } from "../../schemas/trace.ts";
import { RecoveryManager, type RecoveryPolicy, type Sleep } from "./recovery.ts";
import type { ModelAdapter, ModelRequest } from "../models/contracts.ts";
import {
  AgentRunConfigSchema, type AgentFailure, type AgentNode, type AgentRunConfig, type AgentToolRegistry,
  type AgentToolRecord, type AgentTransition, type BaselineAgentResult,
} from "./contracts.ts";

class AgentTimeoutError extends Error {
  constructor() { super("Baseline agent exceeded its wall-clock timeout"); this.name = "AgentTimeoutError"; }
}

type ModelMessage = ModelRequest["messages"][number];

function failure(node: AgentNode, error: unknown, callId: string | null = null): AgentFailure {
  const value = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof value.code === "string" ? value.code : error instanceof Error ? error.name : "unknown_error";
  const message = error instanceof Error ? error.message : String(error);
  return { node, code, message: message.slice(0, 1000), call_id: callId };
}

function toolResultMessage(record: AgentToolRecord): ModelMessage {
  return {
    role: "user",
    content: canonicalJson({
      type: "tool_result",
      call_id: record.call_id,
      tool_name: record.tool_name,
      status: record.status,
      output: record.output,
      error_code: record.error_code,
      ...(record.outcome_unknown ? { note: "This write may or may not have been applied and was not retried. Verify with a read before repeating it." } : {}),
      ...(record.replayed ? { note: "An identical write already succeeded; its saved result is returned and nothing was executed again." } : {}),
    }),
  };
}

export async function runBaselineAgent(input: {
  config: AgentRunConfig;
  adapter: ModelAdapter;
  tools: AgentToolRegistry;
  budgetConfig: BudgetConfig;
  /** Bounded recovery (TB-025). Omit to keep the TB-015 behavior: no retries. */
  recovery?: { policy: RecoveryPolicy; seed: number; sleep?: Sleep };
}): Promise<BaselineAgentResult> {
  const config = AgentRunConfigSchema.parse(input.config);
  const budget = new BudgetController(input.budgetConfig);
  const controller = new AbortController();
  const runController = new AbortController();
  const forwardBudgetAbort = () => runController.abort(budget.signal.reason);
  budget.signal.addEventListener("abort", forwardBudgetAbort, { once: true });
  const manager = input.recovery
    ? new RecoveryManager({ policy: input.recovery.policy, budget, signal: runController.signal, runId: config.run_id, seed: input.recovery.seed, sleep: input.recovery.sleep })
    : null;
  const messages: ModelMessage[] = [
    { role: "system", content: config.system_prompt },
    { role: "user", content: config.user_prompt },
  ];
  const transitions: AgentTransition[] = [];
  const toolRecords: AgentToolRecord[] = [];
  const failures: AgentFailure[] = [];
  let finalText = "";
  let steps = 0;

  const terminate = (outcome: BaselineAgentResult["outcome"]): BaselineAgentResult => {
    transitions.push({ step: steps, node: "termination", detail: outcome });
    const snapshot = budget.snapshot();
    return {
      run_id: config.run_id,
      task_id: config.task_id,
      outcome,
      final_text: finalText,
      steps,
      generation_settings: structuredClone(config.generation_settings),
      messages: structuredClone(messages),
      transitions: structuredClone(transitions),
      tool_records: structuredClone(toolRecords),
      failures: structuredClone(failures),
      ...(manager ? { recovery: manager.summary() } : {}),
      budget: {
        model_calls: snapshot.model_calls, tool_calls: snapshot.tool_calls,
        input_tokens: snapshot.input_tokens, output_tokens: snapshot.output_tokens,
        retries: snapshot.retries, elapsed_ms: snapshot.elapsed_ms,
        cost_microusd: snapshot.cost_microusd, pending_work_cancelled: snapshot.pending_work_cancelled,
        exhausted_dimension: snapshot.exhausted_dimension,
      },
    };
  };

  const visit = (node: Exclude<AgentNode, "termination">, detail: string): void => {
    if (steps + 1 > config.max_steps) throw Object.assign(new Error("Maximum graph steps reached"), { code: "step_limit_exceeded" });
    steps += 1;
    transitions.push({ step: steps, node, detail });
  };

  const execute = async (): Promise<BaselineAgentResult> => {
    try {
      while (true) {
        visit("model", `model_call_${budget.snapshot().model_calls + 1}`);
        budget.beginModelCall(config.planned_input_tokens_per_call, config.generation_settings.max_output_tokens);
        const modelRequest = {
          request_id: `${config.run_id}-model-${budget.snapshot().model_calls}`,
          messages: structuredClone(messages),
          tools: structuredClone(config.tools),
          settings: structuredClone(config.generation_settings),
        };
        const response = manager
          ? await manager.callModel("generate", (signal) => input.adapter.generate(modelRequest, { signal }))
          : await input.adapter.generate(modelRequest, { signal: runController.signal });
        if (controller.signal.aborted) throw new AgentTimeoutError();
        budget.recordModelUsage(response.usage.input_tokens, response.usage.output_tokens);
        if (response.output_text) messages.push({ role: "assistant", content: response.output_text });

        if (response.tool_calls.length === 0) {
          if (response.finish_reason === "stop" && response.output_text.trim()) {
            finalText = response.output_text;
            return terminate("success");
          }
          failures.push(failure("model", Object.assign(new Error(`Model ended without a successful final response: ${response.finish_reason}`), { code: `model_finish_${response.finish_reason}` })));
          return terminate("failure");
        }

        visit("tool", `${response.tool_calls.length}_call(s)`);
        for (const call of response.tool_calls) {
          try {
            budget.recordToolCall();
            const tool = input.tools[call.tool_name];
            if (!tool) throw Object.assign(new Error(`Tool is not registered: ${call.tool_name}`), { code: "tool_not_registered" });
            const context = { runId: config.run_id, taskId: config.task_id, callId: call.call_id };
            const attemptResult = manager
              ? await manager.callTool(call.tool_name, call.arguments, call.call_id, (signal, attempt) => tool.execute(call.arguments, { ...context, signal, attempt }))
              : { value: await tool.execute(call.arguments, { ...context, signal: runController.signal }), attempts: 1, replayed: false };
            const result = attemptResult.value;
            if (controller.signal.aborted) throw new AgentTimeoutError();
            const record: AgentToolRecord = {
              call_id: call.call_id, tool_name: call.tool_name, status: "succeeded", arguments: call.arguments,
              output: result.output, state_change_ids: attemptResult.replayed ? [] : result.stateChangeIds, error_code: null,
              ...(manager ? { attempts: attemptResult.attempts } : {}), ...(attemptResult.replayed ? { replayed: true } : {}),
            };
            toolRecords.push(record);
            messages.push(toolResultMessage(record));
          } catch (error) {
            if (error instanceof BudgetExhaustedError || error instanceof AgentTimeoutError) throw error;
            const captured = failure("tool", error, call.call_id);
            failures.push(captured);
            const record: AgentToolRecord = {
              call_id: call.call_id, tool_name: call.tool_name, status: "failed", arguments: call.arguments,
              output: null, state_change_ids: [], error_code: captured.code,
              ...(manager ? { attempts: (error as { attempts?: number }).attempts ?? 1 } : {}),
              ...((error as { outcome_unknown?: boolean }).outcome_unknown ? { outcome_unknown: true } : {}),
            };
            toolRecords.push(record);
            messages.push(toolResultMessage(record));
          }
        }
        if (config.on_tool_error === "stop" && toolRecords.slice(-response.tool_calls.length).some((record) => record.status === "failed")) {
          finalText = response.output_text;
          return terminate("failure");
        }
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        failures.push(failure(transitions.at(-1)?.node ?? "termination", error));
        return terminate("budget_exhausted");
      }
      if (error instanceof AgentTimeoutError || controller.signal.aborted) {
        failures.push(failure(transitions.at(-1)?.node ?? "termination", error));
        return terminate("timeout");
      }
      failures.push(failure(transitions.at(-1)?.node ?? "termination", error));
      return terminate("failure");
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BaselineAgentResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new AgentTimeoutError());
      runController.abort(new AgentTimeoutError());
      failures.push(failure(transitions.at(-1)?.node ?? "termination", new AgentTimeoutError()));
      resolve(terminate("timeout"));
    }, config.timeout_ms);
  });
  try {
    return await Promise.race([execute(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    budget.signal.removeEventListener("abort", forwardBudgetAbort);
  }
}
