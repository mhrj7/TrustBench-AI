import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("parallel pilot tools retain both records and state changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trustbench-pilot-store-"));
  process.env.TRUSTBENCH_PILOT_STATE_DIR = directory;
  const store = await import(`../src/pilot/store.ts?test=${Date.now()}`);
  const fixture = {
    initial_state: {
      users: [], documents: [], contacts: [], customers: [], approvals: [], research_notes: [],
      email_drafts: [], sent_emails: [], applied_updates: [], audit_log: [],
    },
  };
  try {
    await store.resetPilotEpisode("episode-1", fixture);
    await Promise.all([
      store.executePilotTool({ episodeId: "episode-1", callId: "call-1", toolName: "first", arguments: {}, operation(episode: import("../src/pilot/store.ts").PilotEpisode) {
        store.arrayState(episode, "research_notes").push({ note_id: "note-1" });
        return { output: { ok: 1 }, stateChangeIds: ["note-1"] };
      }}),
      store.executePilotTool({ episodeId: "episode-1", callId: "call-2", toolName: "second", arguments: {}, operation(episode: import("../src/pilot/store.ts").PilotEpisode) {
        store.arrayState(episode, "email_drafts").push({ draft_id: "draft-1" });
        return { output: { ok: 2 }, stateChangeIds: ["draft-1"] };
      }}),
    ]);
    const snapshot = await store.snapshotPilotEpisode("episode-1");
    assert.equal(snapshot.tool_records.length, 2);
    assert.equal((snapshot.final_state.research_notes as unknown[]).length, 1);
    assert.equal((snapshot.final_state.email_drafts as unknown[]).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
    delete process.env.TRUSTBENCH_PILOT_STATE_DIR;
  }
});
