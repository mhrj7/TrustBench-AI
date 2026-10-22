// Model proxy for external agents (docs/external/integration-contract.md). An OpenAI-compatible chat endpoint on
// loopback that the agent is pointed at. It holds the provider key (the agent gets a placeholder), applies the run's
// budget and pacing, records every request (normalised for parity and exposure checks) and writes model_usage trace
// events. "forward" sends each request to the registered provider (non-streaming) and returns it in the format the
// agent asked for; "scripted" replays a fixed trajectory for deterministic wiring tests, with no model.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BudgetExhaustedError, type BudgetController } from "../../runtime/budget.ts";
import type { TraceRecorder } from "./trace.ts";

export interface ScriptedOutcome { output_text: string; tool_calls: Array<{ call_id: string; tool_name: string; arguments: Record<string, unknown> }>; finish_reason: string; usage?: { input_tokens: number; output_tokens: number } }

export interface ProxyOptions {
  mode: "forward" | "scripted";
  /** forward: provider chat-completions base URL, key (null for local) and registered model id. */
  provider?: { baseUrl: string; apiKey: string | null; modelId: string; extraBody: Record<string, unknown> };
  scripted?: ScriptedOutcome[];
  toolPrefix: string;
  budget: BudgetController;
  plannedInputTokens: number;
  plannedOutputTokens: number;
  trace: TraceRecorder;
  /** Removed from recorded copies only (the agent's per-turn clock), so paired runs compare like for like. */
  normalise: RegExp;
  pace?: (request: { messages: unknown[]; tools?: unknown[] }) => Promise<void>;
  /** Wraps each model request in a span (the runner's RunSpans.model), so external-agent runs export model spans like the
   *  built-in agents: queueing, tokens, finish reason, tool calls and provider errors. */
  span?: <T extends { usage: { input_tokens: number; output_tokens: number }; finish_reason: string; tool_calls: unknown[] }>(requestId: string, wait: (() => Promise<void>) | null, call: () => Promise<T>) => Promise<T>;
  timeoutMs: number;
}

/** A provider or scripted fault, answered to the agent with this status and code. */
export class ProxyFailure extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export interface ProviderFailure { code: string; status: number | null; message: string }

export class ModelProxy {
  /** Provider requests sent and not yet answered: a run cut off by its time limit while one is open ended on the
   *  provider, not on the agent, and is reported as a provider fault (invalid), like the built-in agents' runs. */
  inFlight = 0;
  readonly requests: Array<{ messages: Array<{ role: string; content: string }>; tools: string[]; settings: Record<string, unknown> }> = [];
  readonly responseModels = new Set<string>();
  readonly failures: ProviderFailure[] = [];
  usage = { input_tokens: 0, output_tokens: 0, model_calls: 0 };
  budgetExhausted: string | null = null;
  private server: http.Server | null = null;
  private step = 0;
  private readonly o: ProxyOptions;
  constructor(o: ProxyOptions) { this.o = o; }

  async listen(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res).catch((e) => this.fail(res, 500, "server", String(e))));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", () => resolve()));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> { if (this.server) await new Promise<void>((r) => this.server!.close(() => r())); }

  private fail(res: http.ServerResponse, status: number, code: string, message: string) {
    if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message, type: code, code } }));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: this.o.provider?.modelId ?? "scripted", object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { this.fail(res, 404, "invalid_request", "not found"); return; }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Record<string, any>;
    const callId = `model-${++this.step}`;
    const messages = (body.messages ?? []).map((m: any) => ({ role: String(m.role), content: (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? m.tool_calls ?? "")).replace(this.o.normalise, "") }));
    this.requests.push({ messages, tools: (body.tools ?? []).map((t: any) => String(t.function?.name)), settings: { temperature: body.temperature ?? null, max_tokens: body.max_tokens ?? body.max_completion_tokens ?? null } });
    try {
      this.o.budget.checkElapsed();
      this.o.budget.beginModelCall(this.o.plannedInputTokens, this.o.plannedOutputTokens);
    } catch (e) {
      if (e instanceof BudgetExhaustedError) { this.budgetExhausted = e.message; this.fail(res, 400, "budget_exhausted", "run budget exhausted"); return; }
      throw e;
    }
    const wait = this.o.pace ? () => this.o.pace!({ messages: body.messages ?? [], tools: body.tools ?? [] }) : null;
    let t0 = Date.now();
    // The provider request (or the scripted answer). A provider fault is thrown as a ProxyFailure, so the span records it
    // as an error and the agent gets the provider's status.
    const produce = async () => {
      t0 = Date.now();
      let completion: any;
      if (this.o.mode === "scripted") {
        const next = this.o.scripted?.[Math.min(this.step - 1, (this.o.scripted?.length ?? 1) - 1)];
        if (!next) throw new ProxyFailure(500, "invalid_response", "no scripted outcome");
        completion = {
          id: callId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "scripted",
          choices: [{ index: 0, finish_reason: next.tool_calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: next.output_text || null,
            ...(next.tool_calls.length ? { tool_calls: next.tool_calls.map((c) => ({ id: c.call_id, type: "function", function: { name: `${this.o.toolPrefix}${c.tool_name}`, arguments: JSON.stringify(c.arguments) } })) } : {}) } }],
          usage: { prompt_tokens: next.usage?.input_tokens ?? 400, completion_tokens: next.usage?.output_tokens ?? 40, total_tokens: (next.usage?.input_tokens ?? 400) + (next.usage?.output_tokens ?? 40) },
        };
      } else {
        const p = this.o.provider!;
        const forward: Record<string, unknown> = { ...body, ...p.extraBody, model: p.modelId, stream: false };
        delete forward.stream_options;
        let response: Response;
        this.inFlight++;
        try {
          response = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}) }, body: JSON.stringify(forward), signal: AbortSignal.timeout(this.o.timeoutMs) });
        } catch (e) {
          this.inFlight--;
          const code = (e as Error)?.name === "TimeoutError" ? "timeout" : "network";
          this.failures.push({ code, status: null, message: String(e).slice(0, 200) });
          throw new ProxyFailure(502, code, "provider unreachable");
        }
        let text: string;
        try { text = await response.text(); } finally { this.inFlight--; }
        if (!response.ok) {
          const code = response.status === 429 ? "rate_limit" : response.status === 401 || response.status === 403 ? "authentication" : response.status >= 500 ? "server" : "invalid_request";
          this.failures.push({ code, status: response.status, message: text.slice(0, 200) });
          throw new ProxyFailure(response.status, code, "provider error");
        }
        try { completion = JSON.parse(text); } catch { this.failures.push({ code: "invalid_response", status: response.status, message: "non-JSON body" }); throw new ProxyFailure(502, "invalid_response", "invalid provider response"); }
        if (completion.model) this.responseModels.add(String(completion.model));
      }
      return { completion, usage: { input_tokens: Number(completion.usage?.prompt_tokens ?? 0), output_tokens: Number(completion.usage?.completion_tokens ?? 0) },
        finish_reason: String(completion.choices?.[0]?.finish_reason ?? "other"), tool_calls: completion.choices?.[0]?.message?.tool_calls ?? [] };
    };
    let completion: any;
    try {
      const out = this.o.span ? await this.o.span(callId, wait, produce) : (wait && (await wait()), await produce());
      completion = out.completion;
    } catch (e) {
      if (e instanceof ProxyFailure) { this.fail(res, e.status, e.code, e.message); return; }
      throw e;
    }
    const inTok = Number(completion.usage?.prompt_tokens ?? 0), outTok = Number(completion.usage?.completion_tokens ?? 0);
    this.usage.input_tokens += inTok; this.usage.output_tokens += outTok; this.usage.model_calls += 1;
    try { this.o.budget.recordModelUsage(inTok, outTok); } catch (e) { if (e instanceof BudgetExhaustedError) this.budgetExhausted = e.message; else throw e; }
    const fr = String(completion.choices?.[0]?.finish_reason ?? "other");
    this.o.trace.append({ event_type: "model_usage", model_call_id: callId, input_tokens: inTok, output_tokens: outTok, latency_ms: Date.now() - t0, cost_microusd: null,
      finish_reason: fr === "tool_calls" ? "tool_call" : ["stop", "length", "content_filter"].includes(fr) ? fr : "other" } as any);
    if (body.stream) this.stream(res, completion); else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(completion)); }
  }

  /** Re-emits a complete completion as an SSE stream: one content/tool-call chunk, a finish chunk and a usage chunk. */
  private stream(res: http.ServerResponse, c: any) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const choice = c.choices?.[0] ?? {}; const msg = choice.message ?? {};
    const base = { id: c.id ?? "x", object: "chat.completion.chunk", created: c.created ?? Math.floor(Date.now() / 1000), model: c.model ?? "model" };
    const delta: Record<string, unknown> = { role: "assistant" };
    if (msg.content) delta.content = msg.content;
    if (msg.tool_calls?.length) delta.tool_calls = msg.tool_calls.map((t: any, i: number) => ({ index: i, id: t.id, type: "function", function: { name: t.function?.name, arguments: t.function?.arguments ?? "{}" } }));
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? "stop" }] });
    send({ ...base, choices: [], usage: c.usage ?? null });
    res.end("data: [DONE]\n\n");
  }
}
