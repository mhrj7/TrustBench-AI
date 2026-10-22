/** Deterministic HTTP-level fault injection for tool transports. Rules and rates are data (tests/recovery/fault-schedules.json). */
export interface FaultRule {
  tool: string; attempts: number[];
  /** malformed: a 200 whose body is not JSON; oversized: a 200 with a JSON body of size_bytes; slow: the real response after
   *  delay_ms (TB-063). The others are TB-025's. */
  mode: "fail_before" | "fail_after" | "hang" | "reset_before" | "reset_after" | "malformed" | "oversized" | "slow";
  http_status?: number; detail?: string; delay_ms?: number; size_bytes?: number;
}
export interface FaultProfile { seed: number; read_tools: string[]; write_tools: string[]; read_transient_rate: number; read_mode: FaultRule["mode"]; read_http_status?: number; write_response_loss_rate: number; write_mode: FaultRule["mode"] }

const mulberry32 = (seed: number) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const resetError = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

type Injected = Array<{ tool: string; attempt: number; mode: string }>;
export type FaultyFetch = typeof fetch & { attempts: Record<string, number>; injected: Injected };

async function apply(mode: FaultRule["mode"], real: typeof fetch, input: URL | string | Request, init: RequestInit | undefined, status: number, detail: string, extra: { delay_ms?: number; size_bytes?: number } = {}): Promise<Response> {
  const respond = () => Response.json({ detail }, { status });
  switch (mode) {
    case "fail_before": return respond();
    case "reset_before": throw resetError();
    case "hang": return await new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    case "fail_after": await real(input as URL, init); return respond(); // the effect committed; the caller only sees the failure
    case "reset_after": await real(input as URL, init); throw resetError();
    case "malformed": return new Response("<html><body>502 upstream proxy error</body></html>", { status: 200, headers: { "content-type": "application/json" } });
    case "oversized": return Response.json({ payload: { content: "x".repeat(extra.size_bytes ?? 1_500_000) }, note: "injected oversized output" }, { status: 200 });
    case "slow": await new Promise((r, reject) => { const t = setTimeout(r, extra.delay_ms ?? 5000); init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(init.signal!.reason); }, { once: true }); }); return real(input as URL, init);
  }
}

function wrap(real: typeof fetch, decide: (tool: string, attempt: number) => { mode: FaultRule["mode"]; status: number; detail: string; delay_ms?: number; size_bytes?: number } | null): FaultyFetch {
  const attempts: Record<string, number> = {};
  const injected: Injected = [];
  const fn = (async (input: URL | string | Request, init?: RequestInit) => {
    const tool = String(input instanceof Request ? input.url : input).split("/").pop()!;
    attempts[tool] = (attempts[tool] ?? 0) + 1;
    const fault = decide(tool, attempts[tool]!);
    if (!fault) return real(input as URL, init);
    injected.push({ tool, attempt: attempts[tool]!, mode: fault.mode });
    return apply(fault.mode, real, input, init, fault.status, fault.detail, fault);
  }) as FaultyFetch;
  fn.attempts = attempts; fn.injected = injected;
  return fn;
}

/** Fixed schedule: fault the listed attempt numbers of a tool. */
export function faultyFetch(real: typeof fetch, rules: FaultRule[]): FaultyFetch {
  return wrap(real, (tool, attempt) => {
    const rule = rules.find((r) => r.tool === tool && r.attempts.includes(attempt));
    return rule ? { mode: rule.mode, status: rule.http_status ?? 503, detail: rule.detail ?? "injected_fault", delay_ms: rule.delay_ms, size_bytes: rule.size_bytes } : null;
  });
}

/** Rate profile for live runs: each read attempt fails transiently with a probability; each write may lose its response after committing. */
export function rateFaultyFetch(real: typeof fetch, profile: FaultProfile, stream: string): FaultyFetch {
  const random = mulberry32(profile.seed ^ [...stream].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7));
  return wrap(real, (tool) => {
    if (profile.read_tools.includes(tool) && random() < profile.read_transient_rate) return { mode: profile.read_mode, status: profile.read_http_status ?? 503, detail: "injected_transient" };
    if (profile.write_tools.includes(tool) && random() < profile.write_response_loss_rate) return { mode: profile.write_mode, status: 503, detail: "injected_response_loss" };
    return null;
  });
}
