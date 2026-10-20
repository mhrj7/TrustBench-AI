// Runs one episode of the external agent goose under the integration contract (docs/external/integration-contract.md):
// pinned binary (checksum verified), throwaway sandbox (the same neutral path for both arms of a pair), the model proxy,
// the MCP adapter on a per-episode socket, and goose launched with a constructed environment. Returns a result in the
// shape of the built-in agents' BaselineAgentResult, so the evaluator, parity checks and reports are unchanged.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { BudgetController, type BudgetConfig } from "../../runtime/budget.ts";
import { canonicalJson, sha256Hex } from "../../schemas/trace.ts";
import type { AgentFailure, AgentRunConfig, AgentToolRegistry, BaselineAgentResult } from "../agent/contracts.ts";
import { McpAdapter } from "./mcp-adapter.ts";
import { confine, type Confinement } from "./sandbox.ts";
import { ModelProxy, type ScriptedOutcome } from "./model-proxy.ts";
import { TraceRecorder } from "./trace.ts";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const externalAgents = JSON.parse(readFileSync(path.join(root, "configs/external-agents.yaml"), "utf8"));
// goose processes still running; killed if the harness exits, so an interrupted run leaves no agent behind.
const running = new Set<import("node:child_process").ChildProcess>();
process.on("exit", () => { for (const c of running) c.kill("SIGKILL"); });

export interface GooseRunInput {
  arm: "baseline" | "defended";
  config: AgentRunConfig;
  registry: AgentToolRegistry;
  budgetConfig: BudgetConfig;
  /** Sandbox key shared by both arms of a pair, so the working-folder path the agent reports is identical. */
  sandboxKey: string;
  model: { mode: "scripted"; outcomes: ScriptedOutcome[] } | { mode: "forward"; baseUrl: string; apiKey: string | null; modelId: string; extraBody: Record<string, unknown> };
  modelInfo: { provider: string; name: string; revision: string };
  evaluatorVersion: string;
  policyVersion: string;
  traceFile: string | null;
  approvalLog?: Array<Record<string, unknown>>;
  pace?: (request: { messages: unknown[]; tools?: unknown[] }) => Promise<void>;
  /** Native mode: serve a different extension on the socket (the MCP gateway in front of the agent's own integration),
   * launched under the given relay command name. Default: the TrustBench MCP adapter as `trustbench`. */
  extension?: { relayCommand: string; serve: (socketPath: string, trace: TraceRecorder, signal: AbortSignal, sandbox: { home: string; work: string; service: string }) => Promise<ExtensionServer>;
    /** Test only (TB-058 bypass probes): launch this command as the extension instead of src/external/bin/<relayCommand>. */
    commandPath?: string };
  /** Seeds the episode's working folder (synthetic data only) before the agent starts. */
  prepareSandbox?: (work: string) => Promise<void>;
  /** Native mode: seeds the integration's own data folder (synthetic data only). It sits outside the agent's sandbox, so
   * the agent reaches that data only through the gateway (TB-058). */
  prepareService?: (service: string) => Promise<void>;
  /** TB-058: run goose confined (default: configs/external-agents.yaml sandbox.required). Only tests that exercise the
   * adapter itself may pass false; every run that produces results is confined. */
  confined?: boolean;
}

export interface ExtensionServer { records: BaselineAgentResult["tool_records"]; protocol: Array<{ method: string }>; close(): Promise<void> }

export interface GooseRunOutput {
  result: BaselineAgentResult;
  requests: ModelProxy["requests"];
  responseModels: string[];
  invalid: boolean;
  trace: { file: string | null; events: number; valid: boolean; error: string | null };
  goose: { exit_code: number | null; status: string | null; stderr_tail: string; advertised_tools: string[]; system_prompt_sha256: string | null; protocol_methods: string[]; binary_sha256: string; configuration_sha256: string; environment_names: string[]; confinement: string };
}

function platformKey(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const cpu = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  return `${os}-${cpu}`;
}

/** The pinned goose binary: its path comes from the configured environment variable, its checksum must match. */
export function resolveGooseBinary(env: NodeJS.ProcessEnv = process.env): { path: string; sha256: string } {
  const agent = externalAgents.agents.goose;
  const bin = env[agent.binary_env];
  if (!bin || !existsSync(bin)) throw new Error(`goose binary not found: set ${agent.binary_env} to the pinned ${agent.version} binary`);
  const artifact = agent.artifacts[platformKey()];
  if (!artifact?.binary_sha256) throw new Error(`no pinned goose binary checksum for ${platformKey()} in configs/external-agents.yaml`);
  const sha256 = createHash("sha256").update(readFileSync(bin)).digest("hex");
  if (sha256 !== artifact.binary_sha256) throw new Error(`goose binary checksum ${sha256} does not match the pinned ${artifact.binary_sha256}`);
  return { path: bin, sha256 };
}

export async function runGooseAgent(input: GooseRunInput): Promise<GooseRunOutput> {
  const agent = externalAgents.agents.goose;
  const binary = resolveGooseBinary();
  const started = Date.now();
  const { config } = input;
  const sandbox = path.join(agent.sandbox_root, input.sandboxKey.replace(/[^a-zA-Z0-9._-]/g, "_"));
  const service = `${sandbox}.service`;
  await rm(sandbox, { recursive: true, force: true }); await rm(service, { recursive: true, force: true });
  const home = path.join(sandbox, "home"), work = path.join(sandbox, "work"), tmp = path.join(sandbox, "tmp"), socketPath = path.join(sandbox, "a.sock");
  await mkdir(home, { recursive: true }); await mkdir(work, { recursive: true }); await mkdir(tmp, { recursive: true });
  if (input.prepareSandbox) await input.prepareSandbox(work);
  if (input.prepareService) { await mkdir(service, { recursive: true }); await input.prepareService(service); }

  const budget = new BudgetController(input.budgetConfig, started);
  const trace = new TraceRecorder(config.run_id, config.task_id, input.traceFile);
  const modelName = input.model.mode === "forward" ? input.model.modelId : "scripted";
  const settings = config.generation_settings as Record<string, unknown>;
  const goEnv: Record<string, string> = {
    ...agent.environment, HOME: home, TMPDIR: tmp,
    ...(settings.temperature !== undefined && settings.temperature !== null ? { GOOSE_TEMPERATURE: String(settings.temperature) } : {}),
    ...(settings.max_output_tokens ? { GOOSE_MAX_TOKENS: String(settings.max_output_tokens) } : {}),
    GOOSE_MAX_TURNS: String(config.max_steps),
  };
  for (const name of agent.never_set) if (name in goEnv) throw new Error(`contract violation: ${name} must never be set`);
  const toolSpecs = config.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> }));
  const configurationSha256 = sha256Hex(canonicalJson({ agent: { version: agent.version, commit: agent.commit, binary_sha256: binary.sha256 }, contract: agent.contract_version, base_args: agent.base_args, env: goEnv, max_turns: config.max_steps, max_tool_repetitions: agent.max_tool_repetitions, tools: toolSpecs, system: config.system_prompt, model: modelName }).replace(home, "<home>"));
  const limits = input.budgetConfig.limits;
  trace.append({ event_type: "run_started", model: { provider: input.modelInfo.provider, name: input.modelInfo.name.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128), revision: input.modelInfo.revision }, prompt_sha256: sha256Hex(canonicalJson({ system: config.system_prompt, user: config.user_prompt })), seed: null, evaluator_version: input.evaluatorVersion, limits: { max_model_calls: limits.max_model_calls, max_tool_calls: limits.max_tool_calls, max_elapsed_ms: limits.max_elapsed_ms, max_retries: limits.max_retries, max_input_tokens: limits.max_input_tokens, max_output_tokens: limits.max_output_tokens, max_cost_microusd: limits.max_cost_microusd }, configuration_sha256: configurationSha256 } as any);

  const controller = new AbortController();
  const proxy = new ModelProxy({ mode: input.model.mode, ...(input.model.mode === "forward" ? { provider: input.model } : { scripted: input.model.outcomes }), toolPrefix: input.extension ? `${input.extension.relayCommand}__` : agent.tool_prefix, budget, plannedInputTokens: config.planned_input_tokens_per_call, plannedOutputTokens: Number(settings.max_output_tokens ?? 1024), trace, normalise: new RegExp(agent.turn_context_time_pattern, "g"), pace: input.pace, timeoutMs: config.timeout_ms });
  const proxyUrl = await proxy.listen();
  let adapter: ExtensionServer;
  if (input.extension) adapter = await input.extension.serve(socketPath, trace, controller.signal, { home, work, service });
  else {
    const a = new McpAdapter({ socketPath, serverName: "trustbench", serverVersion: agent.contract_version, tools: toolSpecs, registry: input.registry, arm: input.arm, trace, runId: config.run_id, taskId: config.task_id, signal: controller.signal, denialCodes: new Set(externalAgents.gateway_denial_codes), rules: externalAgents.trace, policyVersion: input.policyVersion, approvalLog: input.approvalLog });
    await a.listen();
    adapter = a;
  }
  const relay = input.extension?.commandPath ?? path.join(root, "src/external/bin", input.extension?.relayCommand ?? agent.relay_command);
  const args = [...agent.base_args, "--provider", agent.provider, "--model", modelName,
    "--with-extension", `${relay} --node ${process.execPath} --socket ${socketPath}`,
    "--max-turns", String(config.max_steps), "--max-tool-repetitions", String(agent.max_tool_repetitions),
    "--system", config.system_prompt, "-t", config.user_prompt];
  const confined = input.confined ?? agent.sandbox.required;
  let launch: Confinement = { kind: "none", reason: "confinement switched off for this run" };
  if (confined) {
    launch = confine(binary.path, args, { sandbox, tcpPorts: [Number(new URL(proxyUrl).port)], unixSockets: [socketPath],
      readPaths: [path.dirname(binary.path), path.join(root, "src/external")], systemPaths: agent.sandbox.linux_system_paths }, agent.sandbox_root);
    if (launch.kind === "none") { await adapter.close(); await proxy.close(); throw new Error(`goose must run confined, but ${launch.reason}`); }
  }
  let stdout = "", stderr = "", timedOut = false;
  const exitCode = await new Promise<number | null>((resolve) => {
    const [command, commandArgs] = launch.kind === "none" ? [binary.path, args] : [launch.command, launch.args];
    const child = spawn(command, commandArgs, { cwd: work, env: { ...goEnv, OPENAI_HOST: proxyUrl }, stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, config.timeout_ms);
    child.on("close", (code) => { clearTimeout(timer); running.delete(child); resolve(code); });
  });
  controller.abort();
  await adapter.close(); await proxy.close();

  let parsed: any = null;
  try { parsed = JSON.parse(stdout.slice(stdout.indexOf("{"))); } catch { /* reported below as a failure */ }
  const messages: any[] = parsed?.messages ?? [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const finalText = (lastAssistant?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const status: string | null = parsed?.metadata?.status ?? null;
  const advertised: string[] = [...messages].reverse().map((m) => m.metadata?.operations?.llm?.advertised_tools).find(Boolean) ?? proxy.requests[0]?.tools ?? [];
  const failures: AgentFailure[] = proxy.failures.map((f) => ({ node: "model", code: f.code, message: f.message, call_id: null }));
  if (exitCode !== 0 && !timedOut && !proxy.budgetExhausted && failures.length === 0) failures.push({ node: "termination", code: "agent_error", message: stderr.slice(-300) || `goose exited ${exitCode}`, call_id: null });
  if (trace.broken) failures.push({ node: "tool", code: "trace_write_failed", message: "trace write failed; adapter failed closed", call_id: null });
  const outcome: BaselineAgentResult["outcome"] = timedOut ? "timeout" : proxy.budgetExhausted ? "budget_exhausted" : failures.length ? "failure" : "success";
  const executed = trace.events.filter((e) => e.event_type === "tool_call_started").length;
  const elapsed = Date.now() - started;
  try {
    trace.append({ event_type: "run_finished", outcome: outcome === "failure" ? (failures.some((f) => f.node === "model") ? "task_failure" : "tool_failure") : outcome, elapsed_ms: elapsed, model_calls: proxy.usage.model_calls, tool_calls_executed: executed, input_tokens: proxy.usage.input_tokens, output_tokens: proxy.usage.output_tokens, cost_microusd: null } as any);
  } catch { /* trace already broken; recorded in failures */ }
  const traceError = trace.validate();
  const firstSystem = proxy.requests[0]?.messages.find((m) => m.role === "system")?.content;
  await rm(sandbox, { recursive: true, force: true }); await rm(service, { recursive: true, force: true });
  const providerFault = failures.some((f) => f.node === "model");
  return {
    result: {
      run_id: config.run_id, task_id: config.task_id, outcome, final_text: finalText, steps: proxy.usage.model_calls + adapter.records.length,
      generation_settings: config.generation_settings, messages: [], transitions: [], tool_records: adapter.records, failures,
      budget: { model_calls: proxy.usage.model_calls, tool_calls: adapter.records.length, input_tokens: proxy.usage.input_tokens, output_tokens: proxy.usage.output_tokens, retries: 0, elapsed_ms: elapsed, cost_microusd: 0, pending_work_cancelled: timedOut, exhausted_dimension: proxy.budgetExhausted ? "model_calls" : null },
    },
    requests: proxy.requests, responseModels: [...proxy.responseModels], invalid: providerFault,
    trace: { file: input.traceFile, events: trace.events.length, valid: traceError === null, error: traceError },
    goose: { exit_code: exitCode, status, stderr_tail: stderr.slice(-1500), advertised_tools: advertised, system_prompt_sha256: firstSystem ? sha256Hex(firstSystem) : null, protocol_methods: [...new Set(adapter.protocol.map((p) => p.method))], binary_sha256: binary.sha256, configuration_sha256: configurationSha256, environment_names: Object.keys({ ...goEnv, OPENAI_HOST: proxyUrl }).sort(), confinement: launch.kind },
  };
}
