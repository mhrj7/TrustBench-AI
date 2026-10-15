import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PilotToolRecord {
  call_id: string;
  tool_name: string;
  status: "succeeded" | "failed";
  arguments: Record<string, unknown>;
  output: unknown;
  state_change_ids: string[];
  error_code: string | null;
  timestamp: string;
}

export interface PilotEpisode {
  fixture: Record<string, unknown>;
  final_state: Record<string, unknown>;
  tool_records: PilotToolRecord[];
}

const stateDir = process.env.TRUSTBENCH_PILOT_STATE_DIR ?? path.resolve("runs/baseline-pilot/state");
const episodeLocks = new Map<string, Promise<void>>();

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error("invalid_episode_id");
  return value;
}

function episodePath(episodeId: string): string {
  return path.join(stateDir, `${safeId(episodeId)}.json`);
}

async function readEpisode(episodeId: string): Promise<PilotEpisode> {
  return JSON.parse(await readFile(episodePath(episodeId), "utf8")) as PilotEpisode;
}

async function writeEpisode(episodeId: string, episode: PilotEpisode): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const target = episodePath(episodeId);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(episode, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export async function clearPilotState(): Promise<void> {
  await rm(stateDir, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true });
}

export async function resetPilotEpisode(episodeId: string, fixture: Record<string, unknown>): Promise<void> {
  const initial = fixture.initial_state;
  if (initial === null || typeof initial !== "object" || Array.isArray(initial)) throw new Error("invalid_initial_state");
  await writeEpisode(episodeId, {
    fixture: structuredClone(fixture),
    final_state: structuredClone(initial as Record<string, unknown>),
    tool_records: [],
  });
}

export async function snapshotPilotEpisode(episodeId: string): Promise<PilotEpisode> {
  return structuredClone(await readEpisode(episodeId));
}

export async function executePilotTool(input: {
  episodeId: string;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  operation: (episode: PilotEpisode) => { output: unknown; stateChangeIds?: string[] };
}): Promise<unknown> {
  const previous = episodeLocks.get(input.episodeId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  episodeLocks.set(input.episodeId, tail);
  await previous;
  try {
    const episode = await readEpisode(input.episodeId);
    try {
      const result = input.operation(episode);
      episode.tool_records.push({
        call_id: input.callId,
        tool_name: input.toolName,
        status: "succeeded",
        arguments: structuredClone(input.arguments),
        output: structuredClone(result.output),
        state_change_ids: result.stateChangeIds ?? [],
        error_code: null,
        timestamp: new Date().toISOString(),
      });
      await writeEpisode(input.episodeId, episode);
      return result.output;
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown_tool_error";
      episode.tool_records.push({
        call_id: input.callId,
        tool_name: input.toolName,
        status: "failed",
        arguments: structuredClone(input.arguments),
        output: null,
        state_change_ids: [],
        error_code: code,
        timestamp: new Date().toISOString(),
      });
      await writeEpisode(input.episodeId, episode);
      throw error;
    }
  } finally {
    release();
    if (episodeLocks.get(input.episodeId) === tail) episodeLocks.delete(input.episodeId);
  }
}

export function arrayState(episode: PilotEpisode, key: string): Array<Record<string, unknown>> {
  const value = episode.final_state[key];
  if (!Array.isArray(value)) throw new Error(`invalid_state_${key}`);
  return value as Array<Record<string, unknown>>;
}

export function exactResource(rows: Array<Record<string, unknown>>, key: string, id: string): Record<string, unknown> {
  const matches = rows.filter((row) => row[key] === id);
  if (matches.length !== 1) throw new Error("resource_not_found");
  return structuredClone(matches[0]!);
}
