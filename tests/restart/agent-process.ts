// Child process for restart tests: runs one durable agent run and can SIGKILL itself at a chosen phase.
import { readFile } from "node:fs/promises";
import { runBaselineAgent } from "../../src/agent/index.ts";
import { RunStore } from "../../src/agent/run-store.ts";
import { buildArm } from "../../src/arms/arms.ts";
import { MockModelAdapter } from "../../src/models/index.ts";

const args = JSON.parse(process.argv[2]!);
const durability = JSON.parse(await readFile(new URL("../../configs/durability.yaml", import.meta.url), "utf8"));
const policy = JSON.parse(await readFile(new URL("../../configs/policy.yaml", import.meta.url), "utf8"));
const store = new RunStore(args.store, durability.run_store_retention_days);
if (args.cancel) store.requestCancel(args.runId, args.cancel);
const done = store.load(args.runId);
const used = done.checkpoint ? (done.checkpoint.budget as { model_calls: number }).model_calls : 0;
const outcomes = args.outcomes.slice(used); // a resumed process continues the scripted model where the dead one stopped

let killArmed = Boolean(args.killAt);
const killingFetch: typeof fetch = async (input, init) => {
  const tool = String(input).split("/").pop();
  if (killArmed && args.killAt.tool === tool && args.killAt.when === "before_request") process.kill(process.pid, "SIGKILL");
  const response = await fetch(input, init);
  if (killArmed && args.killAt.tool === tool && args.killAt.when === "after_response" && (!args.killAt.status || response.status === args.killAt.status)) process.kill(process.pid, "SIGKILL");
  return response;
};
const fixture = JSON.parse(args.fixtureJson);
const transport = args.mode === "gateway" ? "gateway" : "direct";
const replaySafe = durability.replay_safe_writes_by_transport[transport];
const built = await buildArm({
  arm: args.mode === "gateway" ? "defended" : "baseline", fixture, episodeId: args.episode, runId: args.runId, taskId: fixture.fixture_id,
  baseUrl: args.baseUrl, budgetConfigPath: args.budget, fetchImpl: killingFetch,
  ...(args.mode === "gateway" ? { gateway: { ...args.gateway } } : {}),
});
const model = new MockModelAdapter("restart-mock", outcomes);
const result = await runBaselineAgent({
  config: built.config, adapter: model, tools: built.tools, budgetConfig: built.budget,
  recovery: { policy: built.recovery, seed: 1 },
  durability: { store, writeTools: built.recovery.tool_classes.write, replaySafeTools: Array.isArray(replaySafe) ? replaySafe : policy[replaySafe], interruptedWriteCode: durability.interrupted_write_error_code },
});
process.stdout.write(JSON.stringify({ model_calls_this_process: model.requests.length, outcome: result.outcome, resumed: result.resumed ?? false, records: result.tool_records.map((r) => ({ tool: r.tool_name, status: r.status, error: r.error_code, unknown: r.outcome_unknown ?? false })) }));
