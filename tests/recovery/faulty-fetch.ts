/** Deterministic fault injection at the HTTP layer. Rules are data (fault-schedules.json). */
export interface FaultRule { tool: string; attempts: number[]; mode: "fail_before" | "fail_after" | "hang" | "reset_before" | "reset_after"; http_status?: number; detail?: string }

export function faultyFetch(real: typeof fetch, rules: FaultRule[]): typeof fetch & { attempts: Record<string, number>; injected: Array<{ tool: string; attempt: number; mode: string }> } {
  const attempts: Record<string, number> = {};
  const injected: Array<{ tool: string; attempt: number; mode: string }> = [];
  const fn = (async (input: URL | string | Request, init?: RequestInit) => {
    const tool = String(input instanceof Request ? input.url : input).split("/").pop()!;
    attempts[tool] = (attempts[tool] ?? 0) + 1;
    const rule = rules.find((r) => r.tool === tool && r.attempts.includes(attempts[tool]!));
    if (!rule) return real(input as URL, init);
    injected.push({ tool, attempt: attempts[tool]!, mode: rule.mode });
    const status = (): Response => Response.json({ detail: rule.detail ?? "injected_fault" }, { status: rule.http_status ?? 503 });
    switch (rule.mode) {
      case "fail_before": return status();
      case "reset_before": throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      case "hang": return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
      case "fail_after": await real(input as URL, init); return status(); // the effect committed; the caller only sees the failure
      case "reset_after": await real(input as URL, init); throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    }
  }) as typeof fetch & { attempts: Record<string, number>; injected: typeof injected };
  fn.attempts = attempts; fn.injected = injected;
  return fn;
}
