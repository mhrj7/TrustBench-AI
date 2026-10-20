// TrustBench MCP adapter (docs/external/integration-contract.md). Serves the arm's own tool registry to an external agent
// over MCP (newline-delimited JSON-RPC 2.0) on a per-episode Unix socket, and records the TB-004 trace for every call.
// It holds the tool registry (and so the gateway session in the defended arm); the agent only ever sees tool names,
// schemas, descriptions and results. Fails closed: if a trace write fails, that call and every later one is refused.
import net from "node:net";
import { ToolServiceError } from "../agent/http-tools.ts";
import type { AgentToolRecord, AgentToolRegistry } from "../agent/contracts.ts";
import type { TraceRecorder } from "./trace.ts";

export interface AdapterTool { name: string; description: string; parameters: Record<string, unknown> }

export interface AdapterOptions {
  socketPath: string;
  serverName: string;
  serverVersion: string;
  tools: AdapterTool[];
  registry: AgentToolRegistry;
  arm: "baseline" | "defended";
  trace: TraceRecorder;
  runId: string;
  taskId: string;
  signal: AbortSignal;
  /** Gateway denial codes and trace rule IDs from configs/external-agents.yaml. */
  denialCodes: Set<string>;
  rules: { baseline_policy: { reason_code: string; rule_id: string; policy_version: string }; gateway_rule_id: string; approval_rule_id: string; adapter_rule_id: string; unavailable_code: string };
  policyVersion: string;
  /** Defended arm: the approval log the guarded registry appends to, keyed by call ID. */
  approvalLog?: Array<Record<string, unknown>>;
}

const ID = /[^a-zA-Z0-9._:-]/g;
const asId = (s: string) => (s.replace(ID, "_").replace(/^[^a-zA-Z0-9]+/, "") || "unknown").slice(0, 128);

export class McpAdapter {
  readonly records: AgentToolRecord[] = [];
  readonly protocol: Array<{ method: string; at: number }> = [];
  private server: net.Server | null = null;
  private calls = 0;
  private readonly byName: Map<string, AdapterTool>;

  private readonly o: AdapterOptions;
  constructor(o: AdapterOptions) {
    this.o = o;
    this.byName = new Map(o.tools.map((t) => [t.name, t]));
  }

  async listen(): Promise<void> {
    this.server = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) void this.handle(line).then((reply) => { if (reply) socket.write(JSON.stringify(reply) + "\n"); });
        }
      });
      socket.on("error", () => { /* the agent went away; the run's own timeout ends it */ });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.o.socketPath, () => resolve()); });
  }

  async close(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(line: string): Promise<Record<string, unknown> | null> {
    let msg: { id?: unknown; method?: string; params?: any };
    try { msg = JSON.parse(line); } catch { return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }; }
    const method = String(msg.method ?? "");
    this.protocol.push({ method, at: Date.now() });
    const isNotification = msg.id === undefined;
    const ok = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
    switch (method) {
      case "initialize":
        return ok({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: this.o.serverName, version: this.o.serverVersion } });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: this.o.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
      case "tools/call":
        return ok(await this.call(String(msg.params?.name ?? ""), (msg.params?.arguments ?? {}) as Record<string, unknown>));
      default:
        return isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not supported: ${method}` } };
    }
  }

  private result(text: string, isError: boolean) { return { content: [{ type: "text", text }], isError }; }

  private async call(name: string, args: Record<string, unknown>) {
    const { trace, rules } = this.o;
    const callId = asId(`${this.o.runId}-call-${++this.calls}`);
    const refuse = (code: string) => this.result(JSON.stringify({ detail: code }), true);
    const tool = this.byName.get(name);
    try {
      trace.proposed(callId, asId(name), args);
    } catch {
      return refuse(rules.unavailable_code);
    }
    try {
      if (!tool || !this.o.registry[name]) {
        trace.decision(callId, args, "deny", "tool_not_allowed", rules.adapter_rule_id, this.o.policyVersion);
        this.records.push({ call_id: callId, tool_name: name, status: "failed", arguments: args, output: null, state_change_ids: [], error_code: "tool_not_allowed" });
        return refuse("tool_not_allowed");
      }
      const approvalsBefore = this.o.approvalLog?.length ?? 0;
      const t0 = Date.now();
      let output: unknown;
      let stateChangeIds: string[] = [];
      let error: { status: number; code: string } | null = null;
      try {
        const r = await this.o.registry[name]!.execute(args, { runId: this.o.runId, taskId: this.o.taskId, callId, signal: this.o.signal });
        output = r.output; stateChangeIds = r.stateChangeIds;
      } catch (e) {
        error = e instanceof ToolServiceError ? { status: e.status, code: e.code } : { status: 0, code: rules.unavailable_code };
      }
      const approved = (this.o.approvalLog?.slice(approvalsBefore) ?? []).some((a) => a.call_id === callId);
      const denied = this.o.arm === "defended" && error !== null && this.o.denialCodes.has(error.code);
      if (this.o.arm === "baseline") {
        const p = rules.baseline_policy;
        trace.decision(callId, args, "allow", p.reason_code, p.rule_id, p.policy_version);
      } else if (denied) {
        trace.decision(callId, args, "deny", asId(error!.code), approved ? rules.approval_rule_id : rules.gateway_rule_id, this.o.policyVersion);
      } else {
        trace.decision(callId, args, "allow", approved ? "approval_granted" : "allowed", approved ? rules.approval_rule_id : rules.gateway_rule_id, this.o.policyVersion);
      }
      if (!denied) {
        trace.started(callId, asId(name), args);
        trace.finished(callId, error === null, Date.now() - t0, error === null ? summarize(output) : `error ${error.status}`, error === null ? null : asId(error.code), stateChangeIds.map(asId));
      }
      this.records.push({ call_id: callId, tool_name: name, status: error === null ? "succeeded" : "failed", arguments: args, output: error === null ? output : null, state_change_ids: stateChangeIds, error_code: error?.code ?? null });
      return error === null ? this.result(JSON.stringify(output), false) : refuse(error.code);
    } catch {
      // A trace write failed after the proposal: fail closed for this call and, via the recorder, every later one.
      return refuse(rules.unavailable_code);
    }
  }
}

function summarize(output: unknown): string {
  const text = JSON.stringify(output) ?? "";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
