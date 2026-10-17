import { createHash } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BaselineAgentResult } from "./contracts.ts";

/**
 * Durable run state (TB-026). One SQLite file holds checkpoints, a write-ahead intent log for tool calls, cancellation
 * markers and the single final outcome of each run. A second process can resume a run or observe that it already ended.
 * TB-040: every checkpoint and final outcome is stored with its SHA-256; a record that fails the check or does not parse is
 * reported as corrupt and never resumed, so a damaged or altered checkpoint cannot replay or inject a tool call.
 */
export interface RunCheckpoint {
  steps: number;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  transitions: BaselineAgentResult["transitions"];
  tool_records: BaselineAgentResult["tool_records"];
  failures: BaselineAgentResult["failures"];
  final_text: string;
  budget: Record<string, unknown>;
  pending_calls: Array<{ call_id: string; tool_name: string; arguments: Record<string, unknown> }>;
  response_text: string;
  allowed_by_filter: string[] | null;
}

/** The failure code of a run whose checkpoint or final outcome failed its integrity check (TB-040). */
export const CHECKPOINT_CORRUPT = "checkpoint_corrupt";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export class RunStore {
  private readonly db: DatabaseSync;

  constructor(path: string, retentionDays: number) {
    const created = !existsSync(path);
    this.db = new DatabaseSync(path);
    if (created) chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('running','finished')), checkpoint_json TEXT, final_json TEXT, updated_at REAL NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS intents (run_id TEXT NOT NULL, call_id TEXT NOT NULL, tool TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, call_id)) STRICT;
      CREATE TABLE IF NOT EXISTS control (run_id TEXT PRIMARY KEY, cancel_requested INTEGER NOT NULL DEFAULT 0, reason TEXT) STRICT;`);
    const columns = new Set((this.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!columns.has("checkpoint_sha256")) this.db.exec("ALTER TABLE runs ADD COLUMN checkpoint_sha256 TEXT");
    if (!columns.has("final_sha256")) this.db.exec("ALTER TABLE runs ADD COLUMN final_sha256 TEXT");
    const cutoff = Date.now() / 1000 - retentionDays * 86400;
    this.db.prepare("DELETE FROM intents WHERE run_id IN (SELECT run_id FROM runs WHERE status='finished' AND updated_at < ?)").run(cutoff);
    this.db.prepare("DELETE FROM control WHERE run_id IN (SELECT run_id FROM runs WHERE status='finished' AND updated_at < ?)").run(cutoff);
    this.db.prepare("DELETE FROM runs WHERE status='finished' AND updated_at < ?").run(cutoff);
  }

  load(runId: string): { final: BaselineAgentResult | null; checkpoint: RunCheckpoint | null; corrupt: string | null } {
    const row = this.db.prepare("SELECT status, checkpoint_json, checkpoint_sha256, final_json, final_sha256 FROM runs WHERE run_id = ?").get(runId) as
      { status: string; checkpoint_json: string | null; checkpoint_sha256: string | null; final_json: string | null; final_sha256: string | null } | undefined;
    if (!row) return { final: null, checkpoint: null, corrupt: null };
    const read = <T>(text: string | null, sha: string | null, what: string): { value: T | null; corrupt: string | null } => {
      if (!text) return { value: null, corrupt: null };
      if (!sha || sha !== digest(text)) return { value: null, corrupt: `${what} checksum mismatch` };
      try { return { value: JSON.parse(text) as T, corrupt: null }; } catch { return { value: null, corrupt: `${what} does not parse` }; }
    };
    const final = read<BaselineAgentResult>(row.final_json, row.final_sha256, "final outcome");
    if (final.value) return { final: final.value, checkpoint: null, corrupt: null };
    const checkpoint = read<RunCheckpoint>(row.checkpoint_json, row.checkpoint_sha256, "checkpoint");
    return { final: null, checkpoint: checkpoint.value, corrupt: final.corrupt ?? checkpoint.corrupt };
  }

  checkpoint(runId: string, state: RunCheckpoint): void {
    const text = JSON.stringify(state);
    this.db.prepare(`INSERT INTO runs (run_id, status, checkpoint_json, checkpoint_sha256, updated_at) VALUES (?, 'running', ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET checkpoint_json = excluded.checkpoint_json, checkpoint_sha256 = excluded.checkpoint_sha256, updated_at = excluded.updated_at
      WHERE runs.status = 'running'`).run(runId, text, digest(text), Date.now() / 1000);
  }

  /** Records the single final outcome. If another process already finished the run, its outcome wins and is returned. */
  finish(runId: string, result: BaselineAgentResult): BaselineAgentResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT final_json, final_sha256 FROM runs WHERE run_id = ? AND status = 'finished'").get(runId) as { final_json: string; final_sha256: string | null } | undefined;
      if (existing && existing.final_sha256 === digest(existing.final_json)) { this.db.exec("COMMIT"); return JSON.parse(existing.final_json); }
      const text = JSON.stringify(result);
      this.db.prepare(`INSERT INTO runs (run_id, status, final_json, final_sha256, updated_at) VALUES (?, 'finished', ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET status = 'finished', final_json = excluded.final_json, final_sha256 = excluded.final_sha256, updated_at = excluded.updated_at`).run(runId, text, digest(text), Date.now() / 1000);
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  beginIntent(runId: string, callId: string, tool: string): void {
    this.db.prepare("INSERT OR IGNORE INTO intents (run_id, call_id, tool) VALUES (?, ?, ?)").run(runId, callId, tool);
  }
  finishIntent(runId: string, callId: string): void {
    this.db.prepare("UPDATE intents SET finished = 1 WHERE run_id = ? AND call_id = ?").run(runId, callId);
  }
  /** True when a previous process started this call and never recorded its end. */
  interrupted(runId: string, callId: string): boolean {
    const row = this.db.prepare("SELECT finished FROM intents WHERE run_id = ? AND call_id = ?").get(runId, callId) as { finished: number } | undefined;
    return row !== undefined && row.finished === 0;
  }

  requestCancel(runId: string, reason: string): void {
    this.db.prepare("INSERT INTO control (run_id, cancel_requested, reason) VALUES (?, 1, ?) ON CONFLICT(run_id) DO UPDATE SET cancel_requested = 1, reason = excluded.reason").run(runId, reason);
  }
  cancelRequested(runId: string): string | null {
    const row = this.db.prepare("SELECT cancel_requested, reason FROM control WHERE run_id = ?").get(runId) as { cancel_requested: number; reason: string } | undefined;
    return row && row.cancel_requested ? row.reason ?? "cancelled" : null;
  }

  close(): void { this.db.close(); }
}
