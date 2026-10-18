import { useEffect, useState } from 'react';
import type { MetricSpec, Run } from './aggregate';

export type AttributionRound = {
  localizer_version: string; cases: number; note: string; corrections: number;
  summary: Record<'utility' | 'security' | 'all', { judged: number; correct: number; accuracy: number | null; wilson95: [number, number] | null }>;
};

export type Store = {
  store_version: string; exported_at: string; git_commit: string | null;
  redaction: { sensitive_values: number; mode: string };
  reports: { n: number; path: string; sha256: string; runs: number }[];
  span_reports: number[];
  attribution_file: { path: string; sha256: string; localizer_version: string } | null;
  fields: string[]; filters: string[]; group_dimensions: string[]; default_group: string[];
  metrics: Record<string, MetricSpec>; wilson_z: number; hero_run: string | null;
  denial: { codes: string[]; prefixes: string[] };
  attribution: {
    notes: string[];
    measured: { round: number; localizer_version: string; all: AttributionRound['summary']['all'] };
    rounds: Record<string, AttributionRound>; constructed: { cases: number; correct: number }; reviewer: string;
  };
};

export type RawRecord = { case: Record<string, unknown>; run: RunSide };
export type TraceStep = { tool: string; status: string; error: string | null; attempts?: number | null; args: Record<string, unknown> };
export type RunSide = {
  tool_trace: TraceStep[]; policy_decisions?: { seq: number; tool: string; decision: string; reason: string | null; executed: boolean | null; replayed: boolean }[];
  final_text: string; evaluation: { reason_codes: string[]; utility_pass: boolean; security_pass: boolean; attacker_goal_achieved: boolean };
  failures: string[]; outcome: string; elapsed_ms?: number; [k: string]: unknown;
};
export type Span = { name: string; start_ms: number; end_ms: number; duration_ms: number; status: string; attributes: Record<string, string | number | boolean> };

const base = `${import.meta.env.BASE_URL}data`;
const cache = new Map<string, Promise<unknown>>();
function getJson<T>(path: string): Promise<T> {
  let p = cache.get(path);
  if (!p) {
    p = fetch(`${base}/${path}`).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${path} (${r.status}). Run npm run web:data to export the run store.`);
      return r.json();
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p as Promise<T>;
}

export type Dataset = { store: Store; runs: Run[]; byId: Map<string, Run> };

let dataset: Promise<Dataset> | null = null;
export function loadDataset(): Promise<Dataset> {
  dataset ??= Promise.all([getJson<Store>('store.json'), getJson<{ fields: string[]; rows: unknown[][] }>('runs.json')]).then(([store, table]) => {
    const runs = table.rows.map((row) => Object.fromEntries(table.fields.map((f, i) => [f, row[i]])) as Run);
    return { store, runs, byId: new Map(runs.map((r) => [r.run_id, r])) };
  });
  return dataset;
}

export async function loadRecord(run: Run): Promise<RawRecord & { source: { report: string; sha256: string; pointer: string } }> {
  const body = await getJson<{ report: string; sha256: string; runs: Record<string, RawRecord> }>(`records/${run.report}.json`);
  const rec = body.runs[run.pointer];
  if (!rec) throw new Error(`No record at ${run.pointer} in ${body.report}`);
  return { ...rec, source: { report: body.report, sha256: body.sha256, pointer: run.pointer } };
}

export async function loadSpans(run: Run): Promise<Span[]> {
  if (!run.timed) return [];
  const body = await getJson<Record<string, Span[]>>(`spans/${run.report}.json`);
  return body[run.pointer] ?? [];
}

export type Loadable<T> = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; value: T };

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Loadable<T> {
  const [v, setV] = useState<Loadable<T>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    setV({ state: 'loading' });
    fn().then((value) => live && setV({ state: 'ready', value }), (e: Error) => live && setV({ state: 'error', error: e.message }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return v;
}

export const useDataset = () => useAsync(loadDataset, []);
export const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`;

/** The story page's numbers and its real recorded example (web/public/data/headline.json, from configs/site-headline.json). */
export type HeadlineSide = { run_id: string; outcome: string; security_pass: boolean; utility_pass: boolean; attacker_goal_achieved: boolean;
  tools: { tool: string; status: string; error: string | null }[]; decisions: { tool: string; decision: string; reason: string | null }[]; reason_codes: string[] };
export type Endpoint = { baseline: string; defended: string; baseline_rate: number; defended_rate: number; difference_pp: number; ci95_pp: [number, number]; clusters: number };
export type Headline = {
  primary: { analysis: string; pairs: number; verdict: string; unsafe: Endpoint; utility: Endpoint };
  confidence: number; holdout1_verdict: string; extra_seconds: number; confirmatory_runs: number;
  audit: { sampled: number; security_errors: number; oracle_defects: number };
  reproduction: { steps: number; outcome: string };
  example: { case_id: string; repetition: number; task: string; hidden_text: string; attacker_goal: string; without_guard: HeadlineSide; with_guard: HeadlineSide };
  comparison: { note: string; systems: { id: string; label: string; defended: { numerator: number; denominator: number; rate: number }; baseline: { numerator: number; denominator: number; rate: number } }[] };
};
export const loadHeadline = () => getJson<Headline>('headline.json');
