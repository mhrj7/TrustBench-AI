import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotEpisode } from "../../src/arms/arms.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = path.join(root, ".venv-tools/bin/python");

const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); }); });

export interface RunningService { baseUrl: string; db: string; stop(): Promise<void>; reset(episode: string, fixture: string, maxToolCalls?: number): Promise<void>; state(episode: string): Promise<any> }

/** Starts the real synthetic tool service (TB-014) in the given backend mode on a temporary database. */
export async function startToolService(mode: "contract" | "permissive"): Promise<RunningService> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tb025-"));
  const fixtures = path.join(dir, "fixtures.jsonl");
  await snapshotEpisode("src.arms.cli", ["materialize", "--out", fixtures]);
  const db = path.join(dir, "tools.sqlite");
  const port = await freePort();
  const child: ChildProcess = spawn(python, ["-m", "uvicorn", "src.tools.app:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {
    cwd: root, env: { ...process.env, TRUSTBENCH_FIXTURE_PATH: fixtures, TRUSTBENCH_TOOL_DB: db, TRUSTBENCH_TOOL_MODE: mode }, stdio: "ignore",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(`${baseUrl}/health`); break; } catch { if (i > 100) throw new Error("tool service did not start"); await new Promise((r) => setTimeout(r, 100)); }
  }
  return {
    baseUrl, db,
    async stop() { child.kill("SIGTERM"); await rm(dir, { recursive: true, force: true }); },
    async reset(episode, fixture, maxToolCalls = 12) {
      const r = await fetch(`${baseUrl}/v1/episodes/${episode}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fixture_id: fixture, max_tool_calls: maxToolCalls }) });
      if (!r.ok) throw new Error(`reset failed ${r.status}`);
    },
    async state(episode) { return await snapshotEpisode("src.arms.cli", ["snapshot", "--db", db, "--episode", episode]); },
  };
}
