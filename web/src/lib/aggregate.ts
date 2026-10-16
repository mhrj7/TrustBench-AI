// Aggregation for the review site: a port of app/views.py. Every aggregate keeps the IDs of the runs it counts, so any
// number on the page opens to its evidence. tests (aggregate.test.ts) check this port against the Python implementation.

export type Run = {
  run_id: string; report: number; pointer: string; model: string; system: string; rendering: string; profile: string;
  kind: string; case_id: string; repetition: number; arm: string; outcome: string; invalid: boolean;
  utility_pass: boolean; security_pass: boolean; attacker_goal: boolean; steps: number; elapsed_ms: number | null;
  tokens_in: number | null; tokens_out: number | null; timed: boolean;
  utility_rule: string | null; utility_step: number | null; security_rule: string | null; security_step: number | null;
  first_rule: string | null; first_step: number | null; policy: [string, string, string][]; trace_errors: [string, string][];
  reason_codes: string[];
};

export type MetricSpec = { label: string; field: 'utility_pass' | 'security_pass' | 'attacker_goal'; kinds: string[] | null };
export type MetricCell = { k: number; n: number; rate: number | null; ci: [number, number] | null; hit_ids: string[]; miss_ids: string[] };
export type Group = { key: Record<string, string | number>; runs: number; run_ids: string[]; invalid_ids: string[]; metrics: Record<string, MetricCell> };

export function wilson(k: number, n: number, z: number): [number, number] | null {
  if (n === 0) return null;
  const p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

export type Filters = Partial<Record<string, string[]>>;

export function applyFilters(runs: Run[], selected: Filters, includeInvalid = false): Run[] {
  const active = Object.entries(selected).filter(([, v]) => v && v.length) as [string, string[]][];
  return runs.filter((r) => (includeInvalid || !r.invalid) && active.every(([k, v]) => v.includes(String(r[k as keyof Run]))));
}

const keyOf = (r: Run, dims: string[]) => dims.map((d) => String(r[d as keyof Run]));

export function aggregate(runs: Run[], dims: string[], metrics: Record<string, MetricSpec>, z: number): Group[] {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const k = JSON.stringify(keyOf(r, dims));
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, members]) => {
      const key = Object.fromEntries(dims.map((d, i) => [d, members[0][d as keyof Run] as string | number]));
      void k;
      const cell: Record<string, MetricCell> = {};
      for (const [name, spec] of Object.entries(metrics)) {
        const counted = members.filter((r) => !r.invalid && (spec.kinds === null || spec.kinds.includes(r.kind)));
        const hits = counted.filter((r) => r[spec.field]).map((r) => r.run_id);
        cell[name] = { k: hits.length, n: counted.length, rate: counted.length ? hits.length / counted.length : null, ci: wilson(hits.length, counted.length, z),
                       hit_ids: hits, miss_ids: counted.filter((r) => !r[spec.field]).map((r) => r.run_id) };
      }
      return { key, runs: members.length, run_ids: members.map((r) => r.run_id), invalid_ids: members.filter((r) => r.invalid).map((r) => r.run_id), metrics: cell };
    });
}

export type PolicyRow = { key: Record<string, string | number>; decision: string; reason: string; count: number; run_ids: string[] };

/** Policy outcomes by dims and reason. 'gateway': the gateway's own audit. 'agent': defense denials the agent received. */
export function policyReasons(runs: Run[], dims: string[], source: 'gateway' | 'agent', isDenial: (code: string) => boolean): PolicyRow[] {
  const rows = new Map<string, PolicyRow>();
  for (const r of runs) {
    const items = source === 'gateway' ? r.policy.map(([, decision, reason]) => [decision, reason] as const)
      : r.trace_errors.filter(([, e]) => isDenial(e)).map(([, e]) => ['denied', e] as const);
    for (const [decision, reason] of items) {
      const id = JSON.stringify([...keyOf(r, dims), decision, reason]);
      let row = rows.get(id);
      if (!row) { row = { key: Object.fromEntries(dims.map((d) => [d, r[d as keyof Run] as string])), decision, reason, count: 0, run_ids: [] }; rows.set(id, row); }
      row.count += 1;
      if (row.run_ids[row.run_ids.length - 1] !== r.run_id) row.run_ids.push(r.run_id);
    }
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || JSON.stringify([a.key, a.decision, a.reason]).localeCompare(JSON.stringify([b.key, b.decision, b.reason])));
}

export type OutcomeRow = { key: Record<string, string | number>; outcome: string; runs: number; run_ids: string[] };

export function outcomeCounts(runs: Run[], dims: string[]): OutcomeRow[] {
  const rows = new Map<string, OutcomeRow>();
  for (const r of runs) {
    const id = JSON.stringify([...keyOf(r, dims), r.outcome]);
    let row = rows.get(id);
    if (!row) { row = { key: Object.fromEntries(dims.map((d) => [d, r[d as keyof Run] as string])), outcome: r.outcome, runs: 0, run_ids: [] }; rows.set(id, row); }
    row.runs += 1; row.run_ids.push(r.run_id);
  }
  return [...rows.values()].sort((a, b) => JSON.stringify([a.key, a.outcome]).localeCompare(JSON.stringify([b.key, b.outcome])));
}

/** Defense denial codes, as the localizer defines them: the gateway codes, every defense's denied_error_code, and flow-check prefixes. */
export function denialPredicate(codes: string[], prefixes: string[]): (code: string) => boolean {
  const set = new Set(codes);
  return (code) => !!code && (set.has(code) || prefixes.some((p) => code.startsWith(p)));
}
