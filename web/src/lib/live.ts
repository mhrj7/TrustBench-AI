// Client for the live-test service (src/service/app.py). Same origin by default; VITE_TRUSTBENCH_API points the site at a
// service on another origin. Keys typed into the page go only to POST /api/runs and are never stored by the browser.

export const API_BASE: string = (import.meta.env.VITE_TRUSTBENCH_API as string | undefined)?.replace(/\/$/, '') ?? '';

export type Rate = { numerator: number; denominator: number; rate: number | null; wilson95: [number, number] | null };
export type Pair = { baseline: Rate; defended: Rate };
export type ModeInfo = { label: string; live: boolean; available: boolean; reason: string | null; remaining_pairs_today?: number;
  limits: Record<string, number>; models: { id: string; provider: string; frozen: boolean; key_env: string | null }[] };
export type Catalog = {
  modes: Record<'scripted' | 'hosted' | 'own_key', ModeInfo>;
  systems: { id: string; label: string; modes: string[]; frozen?: boolean }[];
  renderings: string[]; default_rendering: string;
  cases: { id: string; kind: 'benign' | 'attack'; workflow: string; scripted_only: boolean }[];
  agents: Record<string, { status: string; label: string; tasks?: string }>;
  frozen: { system: string; model: string; prompt_profile: string };
  holdouts: string; access_token_required: boolean;
};
export type Job = {
  id: string; status: 'queued' | 'running' | 'done' | 'done_with_parity_warnings' | 'failed'; mode: string; system: string; rendering: string;
  model: { id: string } | null; cases: string[]; repetitions: number; pairs: number; key_source: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; progress: { done: number; total: number }; queue_position?: number; error: string | null;
  summary?: { valid_pairs: number; invalid_pairs: number; invalid_reasons?: { code: string; runs: number; message: string }[]; unsafe_committed_effect: Pair; benign_utility_pass: Pair; attacker_goal_achieved: Pair; observed_response_models: string[] | null };
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `request failed (${r.status})`);
  return body as T;
}

export const getCatalog = () => call<Catalog>('/api/catalog');
export const getJob = (id: string) => call<Job>(`/api/runs/${encodeURIComponent(id)}`);
export const getReport = (id: string) => call<any>(`/api/runs/${encodeURIComponent(id)}/report`);
export const reportUrl = (id: string) => `${API_BASE}/api/runs/${encodeURIComponent(id)}/report`;
export const evaluationUrl = (id: string) => `${API_BASE}/api/runs/${encodeURIComponent(id)}/evaluation`;

export function submitRun(body: Record<string, unknown>, token?: string) {
  return call<Job>('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-trustbench-token': token } : {}) }, body: JSON.stringify(body) });
}
