const intl = new Intl.NumberFormat('en');
export const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : intl.format(v));
export const pct = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? '—' : new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
export const ci = (c: [number, number] | null) => (c ? `${pct(c[0])}–${pct(c[1])}` : '—');
export const seconds = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(ms / 1000)} s`);

/** Human labels for identifiers that appear in the data; unknown values pass through unchanged. */
const LABELS: Record<string, string> = {
  system: 'Defense', model: 'Model', rendering: 'Attack rendering', profile: 'Prompt profile', kind: 'Case kind', case_id: 'Case', arm: 'Arm', outcome: 'Outcome',
};
export const dimLabel = (d: string) => LABELS[d] ?? d;
export const short = (model: string) => model.replace(/^[^:]+:/, '').replace(/^(meta|openai)\//, '');
export const ruleLabel = (rule: string | null) => (rule ? rule.replaceAll('_', ' ') : '—');
export const value = (dim: string, v: unknown) => (dim === 'model' ? short(String(v)) : String(v));
