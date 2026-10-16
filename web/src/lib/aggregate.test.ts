// Parity: the browser's aggregation (aggregate.ts) must produce exactly the cells and run IDs that the Python view logic
// (app/views.py) produces, because scripts/verify-dashboard.py checks the Python results against the raw records.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { aggregate, applyFilters, denialPredicate, outcomeCounts, policyReasons, type Run } from './aggregate.ts';

const root = new URL('../../../', import.meta.url).pathname;
const store = JSON.parse(readFileSync(`${root}web/public/data/store.json`, 'utf8'));
const table = JSON.parse(readFileSync(`${root}web/public/data/runs.json`, 'utf8'));
const runs: Run[] = table.rows.map((r: unknown[]) => Object.fromEntries(table.fields.map((f: string, i: number) => [f, r[i]])));

const python = JSON.parse(execFileSync(`${root}.venv-tools/bin/python`, ['-c', `
import json, sys
sys.path.insert(0, '.')
from app import views
from app.store import load_config, load_runs
from src.analysis.localize import Contracts
K = lambda x: json.dumps(x, separators=(',', ':'))
cfg = load_config(); runs = load_runs(json.load(open(cfg['index_file'])), cfg)
metrics = {k: v for k, v in cfg['metrics'].items() if isinstance(v, dict)}
valid = views.apply_filters(runs, {})
out = {'aggregate': {}, 'policy': {}, 'outcomes': {}}
for dims in [cfg['default_group']] + [[d] for d in cfg['group_dimensions']]:
    out['aggregate'][','.join(dims)] = {K([str(g['key'][d]) for d in dims]): {m: [x['k'], x['n'], sorted(x['hit_ids'])] for m, x in g['metrics'].items()} for g in views.aggregate(valid, dims, metrics, cfg['wilson_z'])}
    out['outcomes'][','.join(dims)] = {K([str(r['key'][d]) for d in dims] + [r['key']['outcome']]): sorted(r['run_ids']) for r in views.outcome_counts(valid, dims)}
    for src in ('gateway', 'agent'):
        out['policy'][src + ':' + ','.join(dims)] = {K([str(r['key'][d]) for d in dims] + [r['key']['decision'], r['key']['reason']]): [r['count'], sorted(r['run_ids'])] for r in views.policy_reasons(valid, dims, src, Contracts().is_defense_denial)}
print(json.dumps(out))
`], { cwd: root, maxBuffer: 1 << 28 }).toString());

const valid = applyFilters(runs, {});
const isDenial = denialPredicate(store.denial.codes, store.denial.prefixes);
const groupings: string[][] = [store.default_group, ...store.group_dimensions.map((d: string) => [d])];

test('aggregate cells and counted run IDs match the Python view logic', () => {
  for (const dims of groupings) {
    const ts = Object.fromEntries(aggregate(valid, dims, store.metrics, store.wilson_z).map((g) =>
      [JSON.stringify(dims.map((d) => String(g.key[d]))), Object.fromEntries(Object.entries(g.metrics).map(([m, x]) => [m, [x.k, x.n, [...x.hit_ids].sort()]]))]));
    assert.deepEqual(ts, python.aggregate[dims.join(',')], `grouping ${dims}`);
  }
});

test('policy reasons match for both sources', () => {
  for (const dims of groupings) for (const src of ['gateway', 'agent'] as const) {
    const ts = Object.fromEntries(policyReasons(valid, dims, src, isDenial).map((r) => [JSON.stringify([...dims.map((d) => String(r.key[d])), r.decision, r.reason]), [r.count, [...r.run_ids].sort()]]));
    assert.deepEqual(ts, python.policy[`${src}:${dims.join(',')}`], `${src} ${dims}`);
  }
});

test('outcome counts match', () => {
  for (const dims of groupings) {
    const ts = Object.fromEntries(outcomeCounts(valid, dims).map((r) => [JSON.stringify([...dims.map((d) => String(r.key[d])), r.outcome]), [...r.run_ids].sort()]));
    assert.deepEqual(ts, python.outcomes[dims.join(',')], `outcomes ${dims}`);
  }
});

test('invalid runs are excluded unless asked for, and filters narrow by exact value', () => {
  assert.ok(valid.every((r) => !r.invalid));
  assert.equal(applyFilters(runs, {}, true).length, runs.length);
  const model = runs[0].model;
  assert.ok(applyFilters(runs, { model: [model] }).every((r) => r.model === model));
});
