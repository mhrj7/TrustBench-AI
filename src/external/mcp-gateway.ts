// MCP gateway for native integrations (TB-057 native mode). Sits between the external agent and one of its own,
// independently implemented MCP integrations, launched unchanged as a child process. Every tools/call is decided by the
// task's policy (configs/external-agents.yaml native_integrations) before it can reach the integration: allowed calls
// are forwarded and their results returned unchanged; refused calls never reach it. Server-initiated requests
// (sampling, elicitation, roots) are refused. Each decision is recorded in the TB-004 trace and in an audit list.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AgentToolRecord } from "../agent/contracts.ts";
import type { TraceRecorder } from "./trace.ts";

export interface NativePolicy {
  policy_version: string;
  default: "deny";
  allow: Record<string, { operations: string[]; path_argument: string; path_scope: "sandbox" }>;
  reason_codes: { tool: string; operation: string; path: string; arguments: string };
  refused_server_requests: string[];
}

/** Codes for refusals that are not tool decisions (configs/external-agents.yaml trace). */
export interface RefusalCodes { cancelled: string; connectionRefused: string; connectionTool: string }
const traceRules = JSON.parse(readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../configs/external-agents.yaml"), "utf8")).trace;
const defaultRefusals: RefusalCodes = { cancelled: traceRules.cancelled_code, connectionRefused: traceRules.connection_refused_code, connectionTool: traceRules.connection_tool };

export interface Decision { decision: "allow" | "deny"; reason: string }

/** Real path of p, resolving symlinks in its deepest existing ancestor (the file itself may not exist yet). */
function realOf(p: string): string {
  let head = p; const tail: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(head), ...tail.reverse()); } catch { /* walk up */ }
    const parent = path.dirname(head);
    if (parent === head) return p;
    tail.push(path.basename(head)); head = parent;
  }
}

/** Pure policy decision for one call; exported for tests. */
export function decideNative(policy: NativePolicy, sandbox: string, tool: string, args: Record<string, unknown>): Decision {
  const rule = policy.allow[tool];
  if (!rule) return { decision: "deny", reason: policy.reason_codes.tool };
  const op = args.operation;
  if (typeof op !== "string" || !rule.operations.includes(op)) return { decision: "deny", reason: policy.reason_codes.operation };
  const p = args[rule.path_argument];
  if (typeof p !== "string" || !p) return { decision: "deny", reason: policy.reason_codes.arguments };
  const real = realOf(path.resolve(sandbox, p));
  const root = realOf(sandbox);
  if (real !== root && !real.startsWith(root + path.sep)) return { decision: "deny", reason: policy.reason_codes.path };
  return { decision: "allow", reason: "allowed" };
}

export interface GatewayOptions {
  socketPath: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  sandbox: string;
  policy: NativePolicy;
  trace: TraceRecorder;
  runId: string;
  ruleId: string;
  /** Default: configs/external-agents.yaml trace. */
  refusals?: RefusalCodes;
}

export class McpGateway {
  readonly records: AgentToolRecord[] = [];
  readonly protocol: Array<{ method: string; at: number; from: "agent" | "integration" }> = [];
  readonly audit: Array<{ call_id: string; tool: string; operation: unknown; decision: string; reason: string; forwarded: boolean }> = [];
  readonly forwarded: Array<{ tool: string; args: unknown }> = [];
  serverInfo: { name?: string; version?: string } | null = null;
  handshake: { method: string; result: unknown } | null = null;
  private readonly o: GatewayOptions;
  private server: net.Server | null = null;
  private child: ChildProcess | null = null;
  private calls = 0;
  private closed = false;
  /** Connections refused because the socket already had its client (TB-058). */
  refusedConnections = 0;
  private pending = new Map<unknown, { callId: string; tool: string; args: Record<string, unknown>; t0: number; method: string }>();

  constructor(o: GatewayOptions) { this.o = o; }

  /** A refusal that never reaches the integration still leaves a TB-004 proposal and deny decision, and an audit entry. */
  private refuse(tool: string, args: Record<string, unknown>, reason: string) {
    const callId = `${this.o.runId}-native-${++this.calls}`.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128);
    try {
      this.o.trace.proposed(callId, tool.replace(/[^a-zA-Z0-9._:-]/g, "_") || "unknown", args);
      this.o.trace.decision(callId, args, "deny", reason, this.o.ruleId, this.o.policy.policy_version);
    } catch { /* trace broken: the recorder refuses everything after this and the runner reports it */ }
    this.audit.push({ call_id: callId, tool, operation: args.operation, decision: "deny", reason, forwarded: false });
  }

  async listen(): Promise<void> {
    this.child = spawn(this.o.command, this.o.args, { cwd: this.o.cwd, env: this.o.env, stdio: ["pipe", "pipe", "ignore"] });
    let up = "";
    let agent: net.Socket | null = null;
    const toAgent = (m: unknown) => { agent?.write(JSON.stringify(m) + "\n"); };
    const toServer = (m: unknown) => { this.child?.stdin?.write(JSON.stringify(m) + "\n"); };
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      up += chunk;
      let nl: number;
      while ((nl = up.indexOf("\n")) >= 0) {
        const line = up.slice(0, nl).trim(); up = up.slice(nl + 1);
        if (!line) continue;
        let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method) {
          this.protocol.push({ method: msg.method, at: Date.now(), from: "integration" });
          // Server-initiated request: refused here, never shown to the agent (EX-13).
          if (msg.id !== undefined && this.o.policy.refused_server_requests.some((r) => msg.method === r)) { toServer({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "refused by the TrustBench gateway" } }); continue; }
          if (msg.method === "notifications/tools/list_changed") continue;
          toAgent(msg); continue;
        }
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (p.method === "initialize" || p.method === "server/discover") { this.handshake = { method: p.method, result: msg.result ?? null }; this.serverInfo = msg.result?.serverInfo ?? msg.result?._meta?.["io.modelcontextprotocol/serverInfo"] ?? this.serverInfo; }
          if (p.method === "tools/call") {
            const isError = Boolean(msg.error) || msg.result?.isError === true;
            const text = JSON.stringify(msg.result?.content ?? msg.error ?? null);
            try { this.o.trace.finished(p.callId, !isError, Date.now() - p.t0, text.slice(0, 200), isError ? "integration_error" : null); } catch { /* trace broken: reported by the runner */ }
            this.records.push({ call_id: p.callId, tool_name: p.tool, status: isError ? "failed" : "succeeded", arguments: p.args, output: msg.result ?? null, state_change_ids: [], error_code: isError ? "integration_error" : null });
          }
        }
        toAgent(msg);
      }
    });
    this.server = net.createServer((socket) => {
      if (agent || this.closed) {  // one client per episode socket; a refused connection is audited, then closed
        this.refusedConnections++;
        this.refuse((this.o.refusals ?? defaultRefusals).connectionTool, {}, this.closed ? (this.o.refusals ?? defaultRefusals).cancelled : (this.o.refusals ?? defaultRefusals).connectionRefused);
        socket.destroy(); return;
      }
      agent = socket;
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: any; try { msg = JSON.parse(line); } catch { continue; }
          this.protocol.push({ method: String(msg.method ?? ""), at: Date.now(), from: "agent" });
          if (this.closed) {  // the episode ended or was cancelled: nothing more is forwarded, and a call is audited as refused
            if (msg.method === "tools/call") this.refuse(String(msg.params?.name ?? ""), (msg.params?.arguments ?? {}) as Record<string, unknown>, (this.o.refusals ?? defaultRefusals).cancelled);
            toAgent({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "episode ended" } }); continue;
          }
          if (msg.method !== "tools/call") {
            if (msg.id !== undefined) this.pending.set(msg.id, { callId: "", tool: "", args: {}, t0: Date.now(), method: String(msg.method ?? "") });
            toServer(msg); continue;
          }
          const tool = String(msg.params?.name ?? ""), args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
          const callId = `${this.o.runId}-native-${++this.calls}`.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128);
          const d = decideNative(this.o.policy, this.o.sandbox, tool, args);
          try {
            this.o.trace.proposed(callId, tool.replace(/[^a-zA-Z0-9._:-]/g, "_") || "unknown", args);
            this.o.trace.decision(callId, args, d.decision, d.reason, this.o.ruleId, this.o.policy.policy_version);
          } catch {
            toAgent({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ detail: "tool_unavailable" }) }], isError: true } });
            continue;
          }
          this.audit.push({ call_id: callId, tool, operation: args.operation, decision: d.decision, reason: d.reason, forwarded: d.decision === "allow" });
          if (d.decision === "deny") {
            this.records.push({ call_id: callId, tool_name: tool, status: "failed", arguments: args, output: null, state_change_ids: [], error_code: d.reason });
            toAgent({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ detail: d.reason }) }], isError: true } });
            continue;
          }
          try { this.o.trace.started(callId, tool.replace(/[^a-zA-Z0-9._:-]/g, "_"), args); } catch { toAgent({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ detail: "tool_unavailable" }) }], isError: true } }); continue; }
          this.forwarded.push({ tool, args });
          this.pending.set(msg.id, { callId, tool, args, t0: Date.now(), method: "tools/call" });
          toServer(msg);
        }
      });
      socket.on("error", () => { /* agent went away */ });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.o.socketPath, () => resolve()); });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.child?.kill("SIGTERM");
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }
}
