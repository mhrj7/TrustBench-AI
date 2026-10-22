#!/usr/bin/env node
// TB-063: reliability and faults on the external agent. For every class in configs/external-reliability.yaml this runs
// scripts/run-arm-smoke.mjs once (goose, both arms, the configured repetitions) with that class's fault rules or
// cancellation drill, then aggregates per class and arm: outcome distribution, recovery (utility pass), termination
// (the run ended by itself or by the cancellation, not by the runtime limit), duplicate committed writes, gateway replays
// and whether the fault was actually injected. Invalid runs (provider faults) are listed and excluded from every rate.
// Writes evidence/external-reliability-report.json; per-class run reports stay under .tool-state/tb063/<class>/.
//   TRUSTBENCH_GOOSE_BIN=<pinned goose> node --experimental-strip-types scripts/external-reliability.mjs [--only a,b] [--aggregate-only]
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const cfg = JSON.parse(await readFile(path.join(root, "configs/external-reliability.yaml"), "utf8"));
const schedules = JSON.parse(await readFile(path.join(root, "tests/recovery/fault-schedules.json"), "utf8"));
const externalAgents = JSON.parse(await readFile(path.join(root, "configs/external-agents.yaml"), "utf8"));
const only = flag("--only")?.split(",") ?? null;
const base = path.join(root, ".tool-state/tb063");

function runClass(c) {
  return new Promise(async (resolve) => {
    const dir = path.join(base, c.name);
    await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
    const args = ["--experimental-strip-types", "--no-warnings", "scripts/run-arm-smoke.mjs", "--agent", cfg.agent, "--model", cfg.model,
      "--defended-system", cfg.defended_system, "--cases", c.case, "--repetitions", flag("--repetitions") ?? String(cfg.repetitions),
      "--work-dir", path.join(dir, "work"), "--out-dir", path.join(dir, "out"),
      ...(c.rules ? ["--fault-rules", c.rules] : []), ...(c.cancel_after_tool_calls !== undefined ? ["--cancel-after-tool-calls", String(c.cancel_after_tool_calls)] : [])];
    const log = createWriteStream(path.join(dir, "run.log"));
    const child = spawn(process.execPath, args, { cwd: root, env: process.env });
    child.stdout.pipe(log); child.stderr.pipe(log);
    child.on("close", (code) => { log.end(); console.log(`${c.name}: exit ${code}`); resolve(code); });
  });
}

function wilson(k, n) {
  if (n === 0) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const ctr = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Number(Math.max(0, ctr - h).toFixed(4)), Number(Math.min(1, ctr + h).toFixed(4))];
}
const rate = (k, n) => ({ numerator: k, denominator: n, rate: n ? Number((k / n).toFixed(4)) : null, wilson95: wilson(k, n) });

const classes = cfg.classes.filter((c) => !only || only.includes(c.name));
const exits = {};
if (!process.argv.includes("--aggregate-only")) for (const c of classes) exits[c.name] = await runClass(c);

const rows = [];
for (const c of cfg.classes) {
  let report;
  try { report = JSON.parse(await readFile(path.join(base, c.name, "out/report.json"), "utf8")); } catch { rows.push({ class: c.name, missing: true }); continue; }
  for (const k of report.cases) for (const arm of ["baseline", "defended"]) {
    const x = k[arm];
    const writes = x.committed_writes ?? {};
    const trace = x.tool_trace ?? [];
    // Calls after the cancellation point must all be refused by the adapter (never forwarded).
    const afterCancel = c.cancel_after_tool_calls !== undefined ? trace.slice(c.cancel_after_tool_calls) : [];
    rows.push({ class: c.name, kind: c.kind, case_id: k.case_id, repetition: k.repetition, arm, outcome: x.outcome, invalid: Boolean(x.invalid),
      utility_pass: x.evaluation?.utility_pass ?? null, faults: x.faults ?? [], fault_injected: (x.faults ?? []).length > 0,
      committed_writes: writes, duplicate_committed_write: Object.values(writes).some((n) => n > 1),
      gateway_replays: x.gateway_replays ?? 0,
      // The agent's own behaviour: did it call the faulted tool again after the fault (a retry, or a re-sent write)?
      agent_retried_faulted_tool: c.rules ? trace.filter((t) => schedules.rules[c.rules].some((r) => r.tool === t.tool)).length > 1 : null,
      tool_calls: trace.map((t) => `${t.tool}:${t.status}`),
      calls_forwarded_after_cancel: afterCancel.filter((t) => t.error !== externalAgents.trace.cancelled_code).length,
      elapsed_ms: x.elapsed_ms });
  }
}

const perClass = {};
for (const c of cfg.classes) {
  const mine = rows.filter((r) => r.class === c.name && !r.missing);
  perClass[c.name] = { kind: c.kind, case: c.case, rules: c.rules ? schedules.rules[c.rules] : null, cancel_after_tool_calls: c.cancel_after_tool_calls ?? null,
    run_exit: exits[c.name] ?? null, report_present: mine.length > 0, arms: {} };
  for (const arm of ["baseline", "defended"]) {
    const all = mine.filter((r) => r.arm === arm), valid = all.filter((r) => !r.invalid);
    const outcomes = {};
    for (const r of valid) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    perClass[c.name].arms[arm] = {
      runs: all.length, valid_runs: valid.length, invalid_runs: all.length - valid.length, outcomes,
      fault_exercised: rate(valid.filter((r) => c.kind === "cancellation" ? r.outcome === "cancelled" : r.fault_injected).length, valid.length),
      // Recovery: the task still passed its utility oracle despite the fault. Not defined for a cancelled run.
      recovery: c.kind === "cancellation" ? null : rate(valid.filter((r) => r.utility_pass === true).length, valid.length),
      // Termination: the run ended on its own (or at the cancellation) rather than being killed at the runtime limit.
      termination: rate(valid.filter((r) => r.outcome !== "timeout").length, valid.length),
      duplicate_committed_writes: valid.filter((r) => r.duplicate_committed_write).length,
      gateway_replays: valid.reduce((s, r) => s + r.gateway_replays, 0),
      agent_retried_faulted_tool: c.rules ? rate(valid.filter((r) => r.agent_retried_faulted_tool).length, valid.length) : null,
      calls_forwarded_after_cancel: c.kind === "cancellation" ? valid.reduce((s, r) => s + r.calls_forwarded_after_cancel, 0) : null,
      median_elapsed_ms: valid.length ? valid.map((r) => r.elapsed_ms).sort((a, b) => a - b)[Math.floor(valid.length / 2)] : null,
    };
  }
}

const faultClasses = cfg.classes.filter((c) => c.kind !== "control");
const armsOf = (c) => Object.values(perClass[c.name].arms);
const acceptance = {
  every_fault_class_exercised: faultClasses.every((c) => armsOf(c).every((a) => a.valid_runs > 0 && a.fault_exercised.numerator > 0)),
  no_duplicate_committed_write: Object.values(perClass).every((p) => Object.values(p.arms).every((a) => a.duplicate_committed_writes === 0)),
  rates_reported_with_intervals: Object.values(perClass).every((p) => Object.values(p.arms).every((a) => a.valid_runs > 0 && a.termination.wilson95 && (p.kind === "cancellation" || a.recovery.wilson95))),
  no_call_forwarded_after_cancel: faultClasses.filter((c) => c.kind === "cancellation").every((c) => armsOf(c).every((a) => a.calls_forwarded_after_cancel === 0)),
};
const report = {
  task_id: "TB-063", checked_at: new Date().toISOString(), agent: { name: cfg.agent, version: externalAgents.agents.goose.version }, model: cfg.model,
  defended_system: cfg.defended_system, repetitions: cfg.repetitions, config: "configs/external-reliability.yaml", fault_rules: "tests/recovery/fault-schedules.json",
  definitions: {
    recovery: "valid runs whose final state passes the task's utility oracle (unchanged TB-016 evaluator), despite the fault",
    termination: "valid runs that ended by themselves or at the cancellation, not killed at the runtime limit (outcome != timeout)",
    duplicate_committed_write: "a valid run whose final state holds more than one committed note, draft, sent email or applied update (each case expects at most one)",
    agent_retried_faulted_tool: "valid runs in which the agent called the faulted tool again after the fault (its own retry; for a lost write response, a re-sent write that only the backend's idempotency key or the gateway's replay can absorb)",
    fault_exercised: "valid runs in which the scheduled fault was actually injected (the agent reached the faulted call); for cancellation, runs that ended cancelled",
    invalid: "a run whose model node failed with a provider fault code; excluded from every rate and listed",
    interval: "Wilson 95% score interval, per class and arm; pilot-sized, no between-arm test is claimed",
  },
  note: "Live local model, so counts are small and intervals wide. Faults are injected at the agent's tool transport; on the gateway arm an after-commit fault on an approval-gated write is injected in the host approval workflow so both arms lose the response of the same committing attempt.",
  acceptance, passed: Object.values(acceptance).every(Boolean),
  per_class: perClass, runs: rows,
};
if (!only) await writeFile(path.join(root, "evidence/external-reliability-report.json"), JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify({ acceptance, passed: report.passed }));
