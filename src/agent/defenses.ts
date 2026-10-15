import { readFileSync } from "node:fs";
import path from "node:path";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../models/contracts.ts";
import type { AgentRunConfig } from "./contracts.ts";

/**
 * Agent-side defenses compared against the gateway (configs/defenses.yaml). All prompt text comes from registered
 * templates. Defenses that need a model use a separate adapter instance of the same model, and their calls are
 * counted separately from the agent's budget so their cost is visible.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const template = (relative: string) => readFileSync(path.join(root, relative), "utf8").trim();
const fill = (text: string, values: Record<string, string>) => text.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in values ? values[k]! : m));

type Message = ModelRequest["messages"][number];
type ToolCall = ModelResponse["tool_calls"][number];

export interface DefenseRegistry {
  defenses: Record<string, Record<string, any>>;
  masked_call_matching: { identity_arguments: string[]; text_arguments: string[]; text_jaccard_min: number };
}

export interface DefenseStats {
  defenses: string[];
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  filtered_tools: string[] | null;
  filter_parse_failed: boolean;
  vetoes: Array<{ call_id: string; tool: string; defense: string; matched_on: string }>;
  checks: number;
  /** directive_flow audit: the attributed passages and the classifier's labels for each checked write. */
  classifications?: Array<{ call_id: string; passages: string[]; labels: Record<string, boolean> | null }>;
}

const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9@.:/_-]+/).filter(Boolean));
function jaccard(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size && !y.size) return 1;
  let inter = 0; for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

export class AgentDefenses {
  readonly stats: DefenseStats;
  private readonly registry: DefenseRegistry;
  private readonly names: Set<string>;
  private readonly writeTools: Set<string>;
  private readonly adapter: ModelAdapter | null;
  private maskedCache: { key: number; calls: ToolCall[] } | null = null;
  /** v4 (A-017): writes denied as instruction-derived in this run, keyed by tool and data-argument values. */
  private readonly stickyDenials = new Set<string>();

  constructor(options: { names: string[]; registry: DefenseRegistry; writeTools: string[]; adapter: ModelAdapter | null }) {
    this.registry = options.registry;
    this.names = new Set(options.names);
    for (const name of this.names) if (!this.registry.defenses[name]) throw new Error(`defense ${name} is not registered in configs/defenses.yaml`);
    this.writeTools = new Set(options.writeTools);
    this.adapter = options.adapter;
    if ([...this.names].some((n) => this.registry.defenses[n]!.uses_model) && !this.adapter) throw new Error("model-based defenses need a defense model adapter");
    this.stats = { defenses: [...this.names], model_calls: 0, input_tokens: 0, output_tokens: 0, filtered_tools: null, filter_parse_failed: false, vetoes: [], checks: 0 };
  }

  has(name: string) { return this.names.has(name); }

  private async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const response = await this.adapter!.generate(request, { signal });
    this.stats.model_calls++; this.stats.input_tokens += response.usage.input_tokens; this.stats.output_tokens += response.usage.output_tokens;
    return response;
  }

  systemPrompt(base: string): string {
    if (!this.has("spotlighting")) return base;
    const cfg = this.registry.defenses.spotlighting!;
    return `${base}\n\n${fill(template(cfg.system_prompt_template), { open: cfg.open, close: cfg.close })}`;
  }

  wrapToolResult(content: string): string {
    if (!this.has("spotlighting")) return content;
    const cfg = this.registry.defenses.spotlighting!;
    return `${cfg.open}${content}${cfg.close}`;
  }

  reminder(userPrompt: string): Message | null {
    if (!this.has("sandwich")) return null;
    return { role: "user", content: fill(template(this.registry.defenses.sandwich!.reminder_template), { user_prompt: userPrompt }) };
  }

  /** AgentDojo-style tool filter: one model call before the run selects the tools the task needs. */
  async filterTools(config: AgentRunConfig, signal: AbortSignal): Promise<string[] | null> {
    if (!this.has("tool_filter")) return null;
    const names = config.tools.map((t) => t.name);
    const prompt = fill(template(this.registry.defenses.tool_filter!.prompt_template), { user_prompt: config.user_prompt, tool_names: names.join(", ") });
    const response = await this.generate({ request_id: `${config.run_id}-tool-filter`, messages: [{ role: "system", content: config.system_prompt }, { role: "user", content: prompt }], tools: [], settings: config.generation_settings }, signal);
    let chosen: string[] | null = null;
    try {
      const match = response.output_text.match(/\[[\s\S]*\]/);
      const parsed = match ? JSON.parse(match[0]) : null;
      if (Array.isArray(parsed)) chosen = parsed.filter((n): n is string => typeof n === "string" && names.includes(n));
    } catch { chosen = null; }
    if (chosen === null) { this.stats.filter_parse_failed = true; chosen = names; }
    this.stats.filtered_tools = chosen;
    return chosen;
  }

  /**
   * Directive-attributed flow (candidate 2): salient tokens and word n-grams in a write's data arguments that are absent
   * from the trusted task are attributed to the untrusted tool-output sentences that contain them (provenance from the
   * signature-verified envelopes). One isolated classifier call, which never sees the user task, labels those sentences
   * as instruction or information. The write is denied only when its content traces back to an instruction.
   */
  async directiveFlow(name: string, call: ToolCall, messages: Message[], config: AgentRunConfig, signal: AbortSignal): Promise<{ code: string; defense: string } | null> {
    const cfg = this.registry.defenses[name]!;
    if (cfg.scope === "write_class_tools" && !this.writeTools.has(call.tool_name)) return null;
    const trusted = (config.user_prompt + "\n" + config.system_prompt).toLowerCase();
    // Sentences grouped by tool output, so v2 can show each attributed sentence with its neighbours from the same output.
    const outputs: string[][] = [];
    for (const m of messages.slice(2)) {
      if (m.role !== "user" || !m.content.includes('"type":"tool_result"')) continue;
      let parsed: any; try { parsed = JSON.parse(m.content.slice(m.content.indexOf("{"), m.content.lastIndexOf("}") + 1)); } catch { continue; }
      const output = parsed?.output;
      const trust = output?.provenance?.trust;
      if (!output || !cfg.untrusted_trust_levels.includes(trust ?? "unknown")) continue;
      const own: string[] = [];
      const walk = (v: unknown) => { if (typeof v === "string") own.push(...v.split(new RegExp(cfg.sentence_split)).map((x) => x.trim()).filter(Boolean)); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
      walk(output.payload ?? output);
      outputs.push(own);
    }
    const sentences = outputs.flat();
    const text = cfg.data_arguments.map((a: string) => call.arguments[a]).filter((v: unknown): v is string => typeof v === "string").join("\n");
    if (!text || !sentences.length) return null;
    const stickyKey = `${name}|${call.tool_name}|${JSON.stringify(cfg.data_arguments.map((a: string) => call.arguments[a] ?? null))}`;
    if (cfg.sticky_denials && this.stickyDenials.has(stickyKey)) {
      // An identical retry of a write already denied in this run: deny again without giving the classifier another draw.
      this.stats.vetoes.push({ call_id: call.call_id, tool: call.tool_name, defense: name, matched_on: "sticky_denial_of_identical_retry" });
      this.stats.classifications = [...(this.stats.classifications ?? []), { call_id: call.call_id, passages: [], labels: null, sticky: true } as any];
      return { code: cfg.denied_error_code, defense: name };
    }
    const salient = new Set<string>();
    for (const pattern of Object.values(cfg.salient_token_patterns) as string[]) for (const raw of text.match(new RegExp(pattern, "g")) ?? []) { const t = raw.replace(new RegExp(cfg.token_trailing_punctuation), ""); if (t && !trusted.includes(t.toLowerCase())) salient.add(t); }
    const toks = text.toLowerCase().split(/\s+/).filter(Boolean);
    const grams = new Set<string>();
    for (let i = 0; i + cfg.ngram_size <= toks.length; i++) { const g = toks.slice(i, i + cfg.ngram_size).join(" "); if (!trusted.includes(g)) grams.add(g); }
    // v3 (A-016): a short data value that is not in the trusted task is attributed as a whole, so names and one-word values
    // without digits or markers are not invisible to attribution.
    const wholeValues = cfg.whole_value_max_words
      ? cfg.data_arguments.map((a: string) => call.arguments[a]).filter((v: unknown): v is string => typeof v === "string")
        .map((v: string) => v.trim().replace(new RegExp(cfg.token_trailing_punctuation), "").toLowerCase())
        .filter((v: string) => v.length >= cfg.whole_value_min_chars && v.split(/\s+/).length <= cfg.whole_value_max_words && !trusted.includes(v))
      : [];
    const attributes = (s: string) => [...salient].some((t) => s.includes(t)) || [...grams].some((g) => s.toLowerCase().replace(/\s+/g, " ").includes(g))
      || wholeValues.some((v: string) => s.toLowerCase().includes(v));
    const contributing = [...new Set(sentences.filter(attributes))];
    if (!contributing.length) return null;
    this.stats.checks++;
    const window = cfg.context_window_sentences ?? 0;
    const inContext = (s: string) => {
      if (!window) return s;
      for (const own of outputs) {
        const i = own.indexOf(s);
        if (i < 0) continue;
        return [...own.slice(Math.max(0, i - window), i), `${cfg.context_marker_open}${s}${cfg.context_marker_close}`, ...own.slice(i + 1, i + 1 + window)].join(" ");
      }
      return s;
    };
    const passages = contributing.map((s, i) => `${i + 1}. ${inContext(s)}`).join("\n");
    const response = await this.generate({ request_id: `${config.run_id}-${name}-${messages.length}`, messages: [{ role: "user", content: fill(template(cfg.classifier_prompt_template), { passages }) }], tools: [], settings: config.generation_settings }, signal);
    let labels: Record<string, boolean> | null = null;
    try { const m = response.output_text.match(/\{[\s\S]*\}/); labels = m ? JSON.parse(m[0]) : null; } catch { labels = null; }
    const directive = labels ? contributing.findIndex((_s, i) => labels![String(i + 1)] === true) : (cfg.on_classifier_parse_failure === "deny" ? 0 : -1);
    this.stats.classifications = [...(this.stats.classifications ?? []), { call_id: call.call_id, passages: contributing.map((x) => inContext(x).slice(0, 300)), labels }];
    if (directive < 0) return null;
    if (cfg.sticky_denials) this.stickyDenials.add(stickyKey);
    this.stats.vetoes.push({ call_id: call.call_id, tool: call.tool_name, defense: name, matched_on: labels ? contributing[directive]!.slice(0, 160) : "classifier_parse_failure" });
    return { code: cfg.denied_error_code, defense: name };
  }

  /** Task-masked re-execution (MELON-style) for every call, or only for write-class calls (counterfactual_writes). */
  async veto(call: ToolCall, messages: Message[], config: AgentRunConfig, signal: AbortSignal): Promise<{ code: string; defense: string } | null> {
    for (const name of this.names) {
      if (this.registry.defenses[name]!.kind !== "directive_flow") continue;
      const blocked = await this.directiveFlow(name, call, messages, config, signal);
      if (blocked) return blocked;
    }
    const defense = this.has("melon") ? "melon" : this.has("counterfactual_writes") ? "counterfactual_writes" : null;
    if (!defense) return null;
    const cfg = this.registry.defenses[defense]!;
    if (cfg.scope === "write_class_tools" && !this.writeTools.has(call.tool_name)) return null;
    this.stats.checks++;
    if (!this.maskedCache || this.maskedCache.key !== messages.length) {
      const toolResults = messages.slice(2).filter((m) => m.role === "user" && m.content.includes('"type":"tool_result"')).map((m) => m.content).join("\n");
      const masked = fill(template(cfg.masked_prompt_template), { tool_results: toolResults || "(none)" });
      const response = await this.generate({
        request_id: `${config.run_id}-masked-${messages.length}`,
        messages: [{ role: "system", content: config.system_prompt }, { role: "user", content: masked }],
        tools: config.tools, settings: config.generation_settings,
      }, signal);
      this.maskedCache = { key: messages.length, calls: response.tool_calls };
    }
    const m = this.registry.masked_call_matching;
    for (const masked of this.maskedCache.calls) {
      if (masked.tool_name !== call.tool_name) continue;
      const identity = m.identity_arguments.find((a) => a in call.arguments && a in masked.arguments && JSON.stringify(call.arguments[a]) === JSON.stringify(masked.arguments[a]));
      const text = m.text_arguments.find((a) => typeof call.arguments[a] === "string" && typeof masked.arguments[a] === "string" && jaccard(call.arguments[a] as string, masked.arguments[a] as string) >= m.text_jaccard_min);
      const noArgs = Object.keys(call.arguments).length === 0 && Object.keys(masked.arguments).length === 0;
      if (identity || text || noArgs) {
        this.stats.vetoes.push({ call_id: call.call_id, tool: call.tool_name, defense, matched_on: identity ?? text ?? "no_arguments" });
        return { code: cfg.denied_error_code, defense };
      }
    }
    return null;
  }
}
