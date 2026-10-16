import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';
import { Link } from 'react-router';
import { applyFilters, type Run } from '../lib/aggregate';
import { runPath, useDataset, type Dataset } from '../lib/data';
import { ruleLabel, short } from '../lib/format';
import { Reveal } from '../components/Motion';
import { FilterBar, Loading, PageHead, useUrlFilters, useUrlValue } from './Common';

export default function Runs() {
  const data = useDataset();
  if (data.state !== 'ready') return <Loading state={data} />;
  return <RunsBody d={data.value} />;
}

const verdict = (ok: boolean, good = true) => <span className={ok === good ? 'ink-2' : 'signal'}>{ok ? 'pass' : 'fail'}</span>;

function RunsBody({ d }: { d: Dataset }) {
  const [filters, set, clear] = useUrlFilters(d.store.filters);
  const [q, setQ] = useUrlValue('q', '');
  const [invalid, setInvalid] = useUrlValue('invalid', '0');
  const runs = useMemo(() => {
    const f = applyFilters(d.runs, filters, invalid === '1');
    const needle = q.trim().toLowerCase();
    return needle ? f.filter((r) => r.run_id.toLowerCase().includes(needle) || (r.utility_rule ?? '').includes(needle) || (r.security_rule ?? '').includes(needle)) : f;
  }, [d.runs, filters, q, invalid]);
  const parent = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: runs.length, getScrollElement: () => parent.current, estimateSize: () => 56, overscan: 12 });
  return (
    <>
      <PageHead title="Every run in the store">Filter by any dimension or search run IDs and attributions. Select a run to see its trace, its policy decisions and its raw record.</PageHead>
      <section className="wrap stack-24">
        <Reveal><FilterBar runs={d.runs} dims={d.store.filters} filters={filters} set={set} clear={clear} /></Reveal>
        <Reveal i={1} className="controls">
          <label className="field" style={{ flex: '1 1 280px' }}><span>Search</span>
            <input className="input" type="search" name="q" autoComplete="off" spellCheck={false} placeholder="Run ID or attribution, e.g. call_denied…" defaultValue={q}
              onChange={(e) => setQ(e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={invalid === '1'} onChange={(e) => setInvalid(e.target.checked ? '1' : '0')} /> Include invalid runs</label>
        </Reveal>
        <p className="small ink-2" aria-live="polite">{runs.length.toLocaleString('en')} runs</p>
        <div className="runtable" role="table" aria-label="Runs" aria-rowcount={runs.length}>
          <div className="runtable-row runtable-head" role="row">
            {['Run', 'Model', 'Defense', 'Rendering', 'Outcome', 'Utility', 'Security', 'Attribution'].map((h) => <span role="columnheader" key={h}>{h}</span>)}
          </div>
          <div ref={parent} className="runtable-body" data-lenis-prevent>
            <div style={{ height: v.getTotalSize(), position: 'relative' }}>
              {v.getVirtualItems().map((it) => {
                const r: Run = runs[it.index];
                return (
                  <Link key={r.run_id} to={runPath(r.run_id)} role="row" className="runtable-row" style={{ transform: `translateY(${it.start}px)` }}>
                    <span role="cell"><b>{r.case_id}</b> <span className="ink-3">r{r.repetition} · {r.arm}</span></span>
                    <span role="cell">{short(r.model)}</span>
                    <span role="cell">{r.system}</span>
                    <span role="cell" className="ink-2">{r.rendering}</span>
                    <span role="cell">{r.outcome}{r.invalid ? <span className="signal"> · invalid</span> : null}</span>
                    <span role="cell">{verdict(r.utility_pass)}</span>
                    <span role="cell">{verdict(r.security_pass)}</span>
                    <span role="cell" className="ink-2">{r.utility_rule ? `${ruleLabel(r.utility_rule)} @ ${r.utility_step}` : r.security_rule ? `${ruleLabel(r.security_rule)} @ ${r.security_step}` : '—'}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
