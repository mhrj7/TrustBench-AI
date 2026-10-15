import { z } from "zod";
import { GenerationSettingsSchema, ModelMessageSchema, ModelToolSchema } from "../models/contracts.ts";

export const AgentRunConfigSchema = z.object({
  run_id: z.string().min(1).max(128),
  task_id: z.string().min(1).max(128),
  system_prompt: z.string().min(1),
  user_prompt: z.string().min(1),
  generation_settings: GenerationSettingsSchema,
  tools: z.array(ModelToolSchema),
  max_steps: z.number().int().min(1).max(100),
  timeout_ms: z.number().int().min(1).max(600_000),
  planned_input_tokens_per_call: z.number().int().positive(),
}).strict();

export type AgentRunConfig = z.infer<typeof AgentRunConfigSchema>;
export type AgentOutcome = "success" | "failure" | "timeout" | "budget_exhausted";
export type AgentNode = "model" | "tool" | "termination";

export interface ToolExecutionContext {
  runId: string;
  taskId: string;
  callId: string;
  signal: AbortSignal;
}

export interface ToolExecutionResult {
  output: unknown;
  stateChangeIds: string[];
}

export interface AgentTool {
  execute(argumentsValue: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export type AgentToolRegistry = Readonly<Record<string, AgentTool>>;

export interface AgentFailure {
  node: AgentNode;
  code: string;
  message: string;
  call_id: string | null;
}

export interface AgentTransition {
  step: number;
  node: AgentNode;
  detail: string;
}

export interface AgentToolRecord {
  call_id: string;
  tool_name: string;
  status: "succeeded" | "failed";
  arguments: Record<string, unknown>;
  output: unknown | null;
  state_change_ids: string[];
  error_code: string | null;
}

export interface BaselineAgentResult {
  run_id: string;
  task_id: string;
  outcome: AgentOutcome;
  final_text: string;
  /** Executed model/tool nodes; terminal bookkeeping is excluded from this bounded count. */
  steps: number;
  generation_settings: z.infer<typeof GenerationSettingsSchema>;
  messages: z.infer<typeof ModelMessageSchema>[];
  transitions: AgentTransition[];
  tool_records: AgentToolRecord[];
  failures: AgentFailure[];
  budget: {
    model_calls: number;
    tool_calls: number;
    input_tokens: number;
    output_tokens: number;
    retries: number;
    elapsed_ms: number;
    cost_microusd: number;
    pending_work_cancelled: boolean;
    exhausted_dimension: string | null;
  };
}
