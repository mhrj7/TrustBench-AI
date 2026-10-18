import { useMemo } from 'react';
import { aggregate, applyFilters, type Group } from '../lib/aggregate';
import { useDataset, type Dataset } from '../lib/data';
import { ci, dimLabel, pct, value } from '../lib/format';
import { Heatmap, RateBars } from '../components/Charts';
import { Reveal } from '../components/Motion';
import { useEvidence } from '../components/Shell';
import { FilterBar, Loading, PageHead, useUrlFilters, useUrlValue } from './Common';

export default function Compare() {
  const data = useDataset();
  if (data.state !== 'ready') return <Loading state={data} />;
  return <CompareBody d={data.value} />;
}

function CompareBody({ d }: { d: Dataset }) {
  const { store, runs } = d;
  const [rows, setRows] = useUrlValue('rows', store.default_group[0]);
  const [cols, setCols] = useUrlValue('cols', store.default_group[1]);
  const [metric, setMetric] = useUrlValue('metric', 'attacker_goal');
  const [filters, setFilter, clear] = useUrlFilters(store.filters);
  const spec = store.metrics[metric] ?? store.metrics.attacker_goal;
  const filtered = useMemo(() => applyFilters(runs, filters), [runs, filters]);
  const dims = cols === 'none' || cols === rows ? [rows] : [rows, cols];
  const groups = useMemo(() => aggregate(filtered, dims, store.metrics, store.wilson_z), [filtered, dims.join(','), store]);
  const open = useEvidence();
  const select = (g: Group) => {
    const m = g.metrics[metric];
    open({
      title: dims.map((x) => value(x, g.key[x])).join(' · '),
      summary: <>{spec.label}: {m.k} of {m.n} counted runs ({pct(m.rate)}, 95% Wilson {ci(m.ci)}). {g.invalid_ids.length ? `${g.invalid_ids.length} invalid runs are listed but never counted.` : ''}</>,
      runIds: g.run_ids,
      counted: Object.fromEntries(g.run_ids.map((id) => [id, m.hit_ids.includes(id) ? 'yes' : m.miss_ids.includes(id) ? 'no' : 'not counted'])) as Record<string, 'yes' | 'no' | 'not counted'>,
    });
  };
  const total = filtered.length;
  return (
    <>
      <PageHead title="Compare defenses on the same runs">
        Choose what to put on each axis and which verdict to count. Every cell is a set of runs; select one to see them, each with its raw record.
      </PageHead>
      <section className="wrap stack-32">
        <Reveal className="controls">
          <label className="field"><span>Rows</span>
            <select className="select" value={rows} onChange={(e) => setRows(e.target.value)}>{store.group_dimensions.map((x) => <option key={x} value={x}>{dimLabel(x)}</option>)}</select></label>
          <label className="field"><span>Columns</span>
            <select className="select" value={cols} onChange={(e) => setCols(e.target.value)}><option value="none">None (ranked bars)</option>
              {store.group_dimensions.filter((x) => x !== rows).map((x) => <option key={x} value={x}>{dimLabel(x)}</option>)}</select></label>
          <div className="field"><span>Verdict counted</span>
            <div className="segmented" role="group" aria-label="Verdict counted">
              {Object.entries(store.metrics).map(([k, s]) => <button key={k} aria-pressed={metric === k} onClick={() => setMetric(k)}>{s.label}</button>)}
            </div></div>
        </Reveal>
        <Reveal i={1}><FilterBar runs={runs} dims={store.filters.filter((x) => !dims.includes(x))} filters={filters} set={setFilter} clear={clear} /></Reveal>
        <p className="small ink-2" aria-live="polite">{total.toLocaleString('en')} valid runs in view{spec.kinds ? `; ${spec.label.toLowerCase()} counts ${spec.kinds.join(' and ')} cases only` : ''}. Wilson 95% intervals; pilot evidence on the development split.</p>
        {dims.length === 2
          ? <Heatmap key={`${rows}-${cols}-${metric}`} groups={groups} dims={dims as [string, string]} metric={metric} spec={spec} onSelect={select} />
          : <RateBars key={`${rows}-${metric}`} groups={groups} dim={rows} metric={metric} spec={spec} onSelect={select} />}
        <Legend bad={spec.field === 'attacker_goal'} />
      </section>
    </>
  );
}

function Legend({ bad }: { bad: boolean }) {
  return (
    <div className="legend">
      <span><i style={{ background: 'var(--tone-2)' }} />0%</span>
      <span><i style={{ background: bad ? 'var(--signal)' : 'var(--data-1)' }} />100%{bad ? ' attacker success' : ''}</span>
      <span><i style={{ background: 'var(--tone-1)' }} />not run</span>
    </div>
  );
}
