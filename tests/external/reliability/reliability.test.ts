// TB-063: the fault machinery used for the external agent's reliability runs. Fault modes (malformed, oversized, slow)
// at the tool transport, the adapter's per-call timeout for a hung tool, the cancellation drill (every call after the
// cancellation point is refused, never forwarded) and the shape of the reliability evidence.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentToolRegistry } from "../../../src/agent/contracts.ts";
import { createHttpToolRegistry } from "../../../src/agent/http-tools.ts";
import { externalAgents } from "../../../src/external/goose.ts";
import { McpAdapter } from "../../../src/external/mcp-adapter.ts";
import { TraceRecorder } from "../../../src/external/trace.ts";
import { faultyFetch } from "../../../src/reliability/faults.ts";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const manifests = JSON.parse(readFileSync(path.join(root, "src/policy/capability-manifests.json"), "utf8"));
const descriptions = JSON.parse(readFileSync(path.join(root, "configs/tool-descriptions.json"), "utf8")).descriptions;
const toolNames: string[] = Object.keys(manifests.argument_schemas);
const tools = toolNames.map((name) => ({ name, description: descriptions[name], parameters: manifests.argument_schemas[name] }));
const schedules = JSON.parse(readFileSync(path.join(root, "tests/recovery/fault-schedules.json"), "utf8"));
const cfg = JSON.parse(readFileSync(path.join(root, "configs/external-reliability.yaml"), "utf8"));

/** A local tool backend that answers every tool call with a small JSON body and counts the calls it executed. */
async function backend() {
  const executed: string[] = [];
  const server = http.createServer((req, res) => {
    executed.push(String(req.url).split("/").pop()!);
    req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ payload: { ok: true }, state_change_ids: [] })); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { executed, url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
}

test("every external fault class names a registered rule, and every fault mode the rules use is implemented", () => {
  const modes = new Set<string>();
  for (const c of cfg.classes) {
    if (c.kind === "fault") { assert.ok(schedules.rules[c.rules], `${c.name}: rule ${c.rules}`); for (const r of schedules.rules[c.rules]) modes.add(r.mode); }
    if (c.kind === "cancellation") assert.ok(Number.isInteger(c.cancel_after_tool_calls) && c.cancel_after_tool_calls > 0);
  }
  const src = readFileSync(path.join(root, "src/reliability/faults.ts"), "utf8");
  for (const m of modes) assert.match(src, new RegExp(`case "${m}"`), `fault mode ${m} is implemented`);
  for (const m of ["hang", "fail_before", "reset_before", "malformed", "oversized", "slow", "reset_after", "fail_after"]) assert.ok(modes.has(m), `class set covers ${m}`);
});

test("malformed and oversized responses reach the caller as such; a slow response arrives late but intact", async () => {
  const b = await backend();
  try {
    const call = (rules: any[]) => createHttpToolRegistry({ baseUrl: b.url, episodeId: "ep", fetchImpl: faultyFetch(fetch, rules) }).read_document!
      .execute({ resource_id: "doc-1" }, { runId: "r", taskId: "t", callId: "c1", signal: new AbortController().signal });
    await assert.rejects(call([{ tool: "read_document", attempts: [1], mode: "malformed" }]), "a non-JSON body is not taken as a result");
    assert.equal(b.executed.length, 0, "the malformed response is injected without reaching the backend");
    const big = await call([{ tool: "read_document", attempts: [1], mode: "oversized", size_bytes: 200_000 }]);
    assert.ok(JSON.stringify(big.output).length >= 200_000, "oversized output is delivered, not silently truncated by the transport");
    const t0 = Date.now();
    const slow = await call([{ tool: "read_document", attempts: [1], mode: "slow", delay_ms: 300 }]);
    assert.ok(Date.now() - t0 >= 290 && b.executed.includes("read_document"));
    assert.deepEqual(slow.output, { payload: { ok: true }, state_change_ids: [] });
  } finally { await b.close(); }
});

/** One client connection; each message is sent only after the previous reply (calls are strictly ordered). */
async function sequential(socketPath: string, messages: object[]): Promise<any[]> {
  const sock = net.createConnection(socketPath);
  let buf = ""; const replies: any[] = []; let next: ((v: any) => void) | null = null;
  sock.on("data", (d) => { buf += d; let nl; while ((nl = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); next?.(m); } });
  for (const m of messages) { replies.push(await new Promise((r) => { next = r; sock.write(JSON.stringify(m) + "\n"); })); }
  sock.end();
  return replies;
}

function adapter(registry: AgentToolRegistry, socketPath: string, extra: Record<string, unknown>) {
  const trace = new TraceRecorder("run-test", "task-test", null);
  trace.append({ event_type: "run_started", model: { provider: "scripted", name: "scripted", revision: "none" }, prompt_sha256: "0".repeat(64), seed: null, evaluator_version: "test",
    limits: { max_model_calls: 10, max_tool_calls: 20, max_elapsed_ms: 60000, max_retries: 0, max_input_tokens: 100000, max_output_tokens: 10000, max_cost_microusd: 0 }, configuration_sha256: "0".repeat(64) } as any);
  const controller = new AbortController();
  const a = new McpAdapter({ socketPath, serverName: "trustbench", serverVersion: "1.0.0", tools, registry, arm: "baseline", trace, runId: "run-test", taskId: "task-test",
    signal: controller.signal, denialCodes: new Set(externalAgents.gateway_denial_codes), rules: externalAgents.trace, policyVersion: "test", ...extra });
  return { a, controller };
}
const callMsg = (id: number, name: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { resource_id: `r${id}` } } });

test("a hung tool call is ended by the adapter's per-call timeout and reported as unavailable; the next call proceeds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tb063-"));
  const executed: string[] = [];
  const registry: AgentToolRegistry = Object.fromEntries(toolNames.map((n) => [n, { async execute(_args: any, ctx: any) {
    executed.push(n);
    if (executed.length === 1) await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }));
    return { output: { ok: true }, stateChangeIds: [] };
  } }]));
  const { a } = adapter(registry, path.join(dir, "s"), { attemptTimeoutMs: 200 });
  await a.listen();
  const t0 = Date.now();
  const [hung, ok] = await sequential(path.join(dir, "s"), [callMsg(1, "read_document"), callMsg(2, "read_document")]);
  await a.close();
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(JSON.parse(hung.result.content[0].text), { detail: externalAgents.trace.unavailable_code });
  assert.equal(ok.result.isError, false);
  assert.deepEqual(a.records.map((r) => r.status), ["failed", "succeeded"]);
  await rm(dir, { recursive: true, force: true });
});

test("cancellation drill: once the N-th call is recorded the episode is cancelled and every later call is refused, never executed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tb063-"));
  const executed: string[] = [];
  const registry: AgentToolRegistry = Object.fromEntries(toolNames.map((n) => [n, { async execute() { executed.push(n); return { output: { ok: true }, stateChangeIds: [] }; } }]));
  let ctl: AbortController;
  const { a, controller } = adapter(registry, path.join(dir, "s"), { onRecorded: (n: number) => { if (n >= 1) ctl.abort(); } });
  ctl = controller;
  await a.listen();
  const replies = await sequential(path.join(dir, "s"), [callMsg(1, "read_document"), callMsg(2, "create_email_draft"), callMsg(3, "apply_record_update")]);
  await a.close();
  assert.equal(replies[0].result.isError, false);
  for (const r of replies.slice(1)) assert.deepEqual(JSON.parse(r.result.content[0].text), { detail: externalAgents.trace.cancelled_code });
  assert.deepEqual(executed, ["read_document"], "no write is forwarded after the cancellation");
  await rm(dir, { recursive: true, force: true });
});

test("the reliability evidence covers every class on both arms and meets the acceptance checks", { skip: existsSync(path.join(root, "evidence/external-reliability-report.json")) ? false : "evidence not generated yet" }, () => {
  const r = JSON.parse(readFileSync(path.join(root, "evidence/external-reliability-report.json"), "utf8"));
  assert.deepEqual(Object.keys(r.per_class).sort(), cfg.classes.map((c: any) => c.name).sort());
  for (const [name, p] of Object.entries<any>(r.per_class)) for (const arm of ["baseline", "defended"]) {
    const a = p.arms[arm];
    assert.ok(a.valid_runs > 0, `${name}/${arm} has valid runs`);
    assert.ok(Array.isArray(a.termination.wilson95), `${name}/${arm} termination interval`);
    if (p.kind !== "cancellation") assert.ok(Array.isArray(a.recovery.wilson95), `${name}/${arm} recovery interval`);
    assert.equal(a.duplicate_committed_writes, 0, `${name}/${arm} has no duplicate committed write`);
  }
  assert.equal(r.passed, true, JSON.stringify(r.acceptance));
});
