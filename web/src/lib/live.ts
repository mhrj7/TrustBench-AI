// Client for the live-test service (src/service/app.py). Same origin by default; VITE_TRUSTBENCH_API points the site at a
// service on another origin. Every visitor has a session (TB-039): an anonymous guest session is created on first use, and
// signing in replaces it with an account session. The session token is kept in this browser only. Provider keys typed into
// the page go only to POST /api/runs and are never stored by the browser.

export const API_BASE: string = (import.meta.env.VITE_TRUSTBENCH_API as string | undefined)?.replace(/\/$/, '') ?? '';
const SESSION_KEY = 'trustbench.session';

export type Rate = { numerator: number; denominator: number; rate: number | null; wilson95: [number, number] | null };
export type Pair = { baseline: Rate; defended: Rate };
export type ModeInfo = { label: string; live: boolean; available: boolean; reason: string | null; remaining_pairs_today?: number;
  limits: Record<string, number>; models: { id: string; provider: string; frozen: boolean; key_env: string | null }[] };
export type Catalog = {
  modes: Record<'scripted' | 'hosted' | 'own_key', ModeInfo>;
  systems: { id: string; label: string; modes: string[]; frozen?: boolean }[];
  renderings: string[]; default_rendering: string;
  cases: { id: string; kind: 'benign' | 'attack'; workflow: string; scripted_only: boolean }[];
  agents: Record<string, { status: string; label: string; tasks?: string; reason?: string; runner_agent?: string; compatible_systems?: string[]; contract?: string }>;
  frozen: { system: string; model: string; prompt_profile: string };
  holdouts: string; access_token_required: boolean; storage?: 'ok' | 'unavailable';
  auth?: { retention_hours: number; accounts: { retention_days: number; verified_quota_multiplier: number; email_delivery: string; password_min_length: number } };
};
export type Job = {
  id: string; status: 'queued' | 'running' | 'done' | 'done_with_parity_warnings' | 'failed'; mode: string; system: string; rendering: string;
  model: { id: string } | null; cases: string[]; repetitions: number; pairs: number; key_source: string | null; agent?: string;
  created_at: string; started_at: string | null; finished_at: string | null; progress: { done: number; total: number }; queue_position?: number; error: string | null;
  summary?: { valid_pairs: number; invalid_pairs: number; invalid_reasons?: { code: string; runs: number; message: string }[]; unsafe_committed_effect: Pair; benign_utility_pass: Pair; attacker_goal_achieved: Pair; observed_response_models: string[] | null };
};
export type Me = { kind: 'guest'; retention_hours: number } | { kind: 'account'; email: string; verified: boolean; retention_days: number; quota_multiplier: number };

function stored(): string | null {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}
export function setSession(token: string | null) {
  try { token ? localStorage.setItem(SESSION_KEY, token) : localStorage.removeItem(SESSION_KEY); } catch { /* private mode: the session lasts for this page */ }
  memory = token;
}
let memory: string | null = stored();

/** The share token of a shared run link (#share=...): in the fragment, so it never reaches server logs. */
export function shareFromHash(): string | null {
  const m = /(?:^#|&)share=([A-Za-z0-9_-]+)/.exec(typeof window !== 'undefined' ? window.location.hash : '');
  return m ? m[1] : null;
}
export function tokenFromHash(): string | null {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(typeof window !== 'undefined' ? window.location.hash : '');
  return m ? m[1] : null;
}

async function raw(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (auth && memory) headers.authorization = `Bearer ${memory}`;
  const share = shareFromHash();
  if (share && path.startsWith('/api/runs/')) headers['x-trustbench-share'] = share;
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

async function call<T>(path: string, init?: RequestInit, auth = true): Promise<T> {
  const r = await raw(path, init, auth);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(typeof body.detail === 'string' ? body.detail : `request failed (${r.status})`) as Error & { status?: number };
    e.status = r.status;
    throw e;
  }
  return body as T;
}

const json = (method: string, body: unknown, token?: string): RequestInit => ({ method, headers: { 'content-type': 'application/json', ...(token ? { 'x-trustbench-token': token } : {}) }, body: JSON.stringify(body) });

/** A valid session for this browser, created on first use (a guest) or kept from a sign-in. */
export async function ensureSession(accessToken?: string): Promise<void> {
  if (memory) {
    try { await call('/api/auth/me'); return; } catch (e) { if ((e as { status?: number }).status !== 401) throw e; }
  }
  const s = await call<{ token: string }>('/api/session', { method: 'POST', headers: accessToken ? { 'x-trustbench-token': accessToken } : {} }, false);
  setSession(s.token);
}

export const getCatalog = () => call<Catalog>('/api/catalog', undefined, false);
export const getJob = (id: string) => call<Job>(`/api/runs/${encodeURIComponent(id)}`);
export const getReport = (id: string) => call<any>(`/api/runs/${encodeURIComponent(id)}/report`);
export const myRuns = () => call<Job[]>('/api/runs');
export const deleteRun = (id: string) => call<{ deleted: string; files_removed: number }>(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const shareRun = (id: string) => call<{ share_token: string }>(`/api/runs/${encodeURIComponent(id)}/share`, { method: 'POST' });
export const unshareRun = (id: string) => call<{ shared: false }>(`/api/runs/${encodeURIComponent(id)}/share`, { method: 'DELETE' });
export const submitRun = (body: Record<string, unknown>, token?: string) => call<Job>('/api/runs', json('POST', body, token));

/** Save a run artifact through the authenticated API (a plain link would not carry the session). */
export async function download(id: string, artifact: 'report' | 'evaluation') {
  const r = await raw(`/api/runs/${encodeURIComponent(id)}/${artifact}`);
  if (!r.ok) throw new Error(`could not fetch the ${artifact} (${r.status})`);
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: `trustbench-${id}-${artifact}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- accounts ---------------------------------------------------------------------------------------------------------
export const me = () => call<Me>('/api/auth/me');
export const signup = (email: string, password: string, token?: string) => call<{ message: string }>('/api/auth/signup', json('POST', { email, password }, token));
export const resendVerification = (email: string) => call<{ message: string }>('/api/auth/verify/resend', json('POST', { email }));
export const forgotPassword = (email: string) => call<{ message: string }>('/api/auth/password/forgot', json('POST', { email }));
export const changePassword = (current_password: string, new_password: string) => call<{ changed: true }>('/api/auth/password/change', json('POST', { current_password, new_password }));
export async function verifyEmail(token: string) {
  const s = await call<{ token: string; claimed_runs: number }>('/api/auth/verify', json('POST', { token }));
  setSession(s.token);
  return s;
}
export async function login(email: string, password: string, token?: string) {
  const s = await call<{ token: string; claimed_runs: number }>('/api/auth/login', json('POST', { email, password }, token));
  setSession(s.token);
  return s;
}
export async function resetPassword(token: string, password: string) {
  return call<{ reset: true }>('/api/auth/password/reset', json('POST', { token, password }));
}
export async function logout() {
  try { await call('/api/session', { method: 'DELETE' }); } finally { setSession(null); }
}
export async function deleteAccount(password: string) {
  const r = await call<{ deleted_runs: number }>('/api/auth/account', json('DELETE', { password }));
  setSession(null);
  return r;
}
