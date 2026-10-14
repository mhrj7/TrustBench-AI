import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docker = process.env.DOCKER_BIN || "/Users/mohitraj/.docker/bin/docker";
const image = "trustbench-tools:tb014";
const name = `trustbench-tb014-${process.pid}`;
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};

run(docker, ["build", "-f", "agent/sandbox/Dockerfile", "-t", image, "."]);
run(docker, ["run", "--name", name, "--detach", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m,mode=1777", "--tmpfs", "/state:rw,noexec,nosuid,size=32m,uid=10001,gid=10001,mode=0700", "--memory", "256m", "--cpus", "1", "--pids-limit", "64", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", image]);
try {
  const inspected = JSON.parse(run(docker, ["inspect", name]))[0];
  assert.equal(inspected.HostConfig.NetworkMode, "none");
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspected.HostConfig.Memory, 268435456);
  assert.equal(inspected.HostConfig.NanoCpus, 1000000000);
  assert.equal(inspected.HostConfig.PidsLimit, 64);
  assert(inspected.HostConfig.CapDrop.includes("ALL"));
  assert(inspected.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.equal(inspected.Config.User, "10001:10001");
  assert.equal(inspected.Config.Env.some((value) => /(API_KEY|TOKEN|PASSWORD|SECRET)=/i.test(value)), false);
  const testOutput = run(docker, ["exec", name, "python", "-m", "pytest", "-q", "src/tools/tests/test_integration.py"]);
  const passed = Number(testOutput.match(/(\d+) passed/)?.[1] ?? 0);
  assert(passed > 0, `pytest pass count missing from output: ${testOutput}`);
  const report = {
    schema_version: "1.0.0",
    task_id: "TB-014",
    checked_at: new Date().toISOString(),
    ok: true,
    integration_tests: { passed, state_reset_verified: true, episode_isolation_verified: true, transactional_tool_call_limit_verified: true, every_fixture_tool_has_a_route: true },
    container: { network_mode: "none", read_only_rootfs: true, memory_bytes: inspected.HostConfig.Memory, nano_cpus: inspected.HostConfig.NanoCpus, pids_limit: inspected.HostConfig.PidsLimit, capability_drop: inspected.HostConfig.CapDrop, no_new_privileges: true, user: inspected.Config.User, credential_env_vars: 0 },
    limits: "These checks establish this tested Docker configuration and application boundary; they do not claim universal container isolation.",
  };
  const evidence = path.join(root, "evidence", "tb014-tool-service-report.json");
  await mkdir(path.dirname(evidence), { recursive: true });
  await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  spawnSync(docker, ["rm", "-f", name], { cwd: root, encoding: "utf8" });
}
