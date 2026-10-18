import { motion, useReducedMotion } from 'motion/react';
import { useMemo } from 'react';
import { applyFilters, denialPredicate, outcomeCounts, policyReasons } from '../lib/aggregate';
import { useDataset, type Dataset } from '../lib/data';
import { dimLabel, value } from '../lib/format';
import { StackBars } from '../components/Charts';
import { EASE_OUT, Reveal } from '../components/Motion';
import { useEvidence } from '../components/Shell';
import { FilterBar, Loading, PageHead, useUrlFilters, useUrlValue } from './Common';

export function Policy() {
  const data = useDataset();
  if (data.state !== 'ready') return <Loading state={data} />;
  return <PolicyBody d={data.value} />;
}

function PolicyBody({ d }: { d: Dataset }) {
  const [source, setSource] = useUrlValue('source', 'gateway');
  const [by, setBy] = useUrlValue('by', 'system');
  const [filters, set, clear] = useUrlFilters(d.store.filters);
  const isDenial = useMemo(() => denialPredicate(d.store.denial.codes, d.store.denial.prefixes), [d]);
  const runs = useMemo(() => applyFilters(d.runs, filters), [d.runs, filters]);
  const rows = useMemo(() => policyReasons(runs, [by], source as 'gateway' | 'agent', isDenial).filter((r) => r.decision !== 'allow'), [runs, by, source, isDenial]);
  const byReason = useMemo(() => {
    const m = new Map<string, { count: number; parts: typeof rows }>();
    for (const r of rows) { const k = r.reason ? `${r.decision}: ${r.reason}` : r.decision; const e = m.get(k) ?? { count: 0, parts: [] }; e.count += r.count; e.parts.push(r); m.set(k, e); }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [rows]);
  const max = Math.max(1, ...byReason.map(([, e]) => e.count));
  const reduce = useReducedMotion();
  const open = useEvidence();
  return (
    <>
      <PageHead title="Why calls were stopped">The gateway records a decision and a reason for every request it sees. Defenses outside the gateway show up as the denial the agent received. Select a bar to open the runs behind it.</PageHead>
      <section className="wrap stack-32">
        <Reveal className="controls">
          <div className="field"><span>Source</span><div className="segmented" role="group" aria-label="Source">
            <button aria-pressed={source === 'gateway'} onClick={() => setSource('gateway')}>Gateway audit</button>
            <button aria-pressed={source === 'agent'} onClick={() => setSource('agent')}>Denials the agent received</button></div></div>
          <label className="field"><span>Split by</span><select className="select" value={by} onChange={(e) => setBy(e.target.value)}>{d.store.group_dimensions.map((x) => <option key={x} value={x}>{dimLabel(x)}</option>)}</select></label>
        </Reveal>
        <Reveal i={1}><FilterBar runs={d.runs} dims={d.store.filters.filter((x) => x !== by)} filters={filters} set={set} clear={clear} /></Reveal>
        {!byReason.length && <p className="body ink-2">No denials or approval holds in the selected runs.</p>}
        <ol className="reasons" key={`${source}-${by}`}>
          {byReason.map(([reason, e], i) => (
            <li key={reason} className="reason">
              <div className="row" style={{ justifyContent: 'space-between' }}><span className="small">{reason}</span><span className="small num ink-2">{e.count.toLocaleString('en')} decisions</span></div>
              <div className="reason-track">
                {e.parts.map((p, j) => (
                  <motion.button key={String(p.key[by])} className="reason-seg" style={{ width: `${(p.count / max) * 100}%`, background: j % 2 ? 'var(--data-2)' : 'var(--data-1)' }}
                    title={`${value(by, p.key[by])}: ${p.count}`}
                    aria-label={`${reason}, ${value(by, p.key[by])}: ${p.count} decisions in ${p.run_ids.length} runs. Open the evidence.`}
                    onClick={() => open({ title: `${reason}`, summary: <>{value(by, p.key[by])}: {p.count} decisions in {p.run_ids.length} runs.</>, runIds: p.run_ids })}
                    initial={{ scaleX: reduce ? 1 : 0, opacity: reduce ? 0 : 1 }} whileInView={{ scaleX: 1, opacity: 1 }} viewport={{ once: true }}
                    transition={{ duration: 0.6, ease: EASE_OUT, delay: Math.min(i * 0.04 + j * 0.05, 0.6) }} />
                ))}
              </div>
              <p className="small ink-3">{e.parts.slice(0, 6).map((p) => `${value(by, p.key[by])} ${p.count}`).join(' · ')}{e.parts.length > 6 ? ` · ${e.parts.length - 6} more` : ''}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

const OUTCOME_COLORS: Record<string, string> = { success: 'var(--data-1)', failure: 'var(--ink-3)', timeout: 'var(--signal-dim)', budget_exhausted: 'var(--signal)' };

export function Outcomes() {
  const data = useDataset();
  if (data.state !== 'ready') return <Loading state={data} />;
  return <OutcomesBody d={data.value} />;
}

function OutcomesBody({ d }: { d: Dataset }) {
  const [by, setBy] = useUrlValue('by', 'system');
  const [filters, set, clear] = useUrlFilters(d.store.filters);
  const runs = useMemo(() => applyFilters(d.runs, filters), [d.runs, filters]);
  const rows = useMemo(() => {
    const counts = outcomeCounts(runs, [by]);
    const groups = new Map<string, { label: string; total: number; segments: { label: string; count: number; color: string; runIds: string[] }[] }>();
    for (const c of counts) {
      const k = value(by, c.key[by]);
      const g = groups.get(k) ?? { label: k, total: 0, segments: [] };
      g.total += c.runs; g.segments.push({ label: c.outcome, count: c.runs, color: OUTCOME_COLORS[c.outcome] ?? 'var(--tone-3)', runIds: c.run_ids });
      groups.set(k, g);
    }
    return [...groups.values()].sort((a, b) => b.total - a.total);
  }, [runs, by]);
  const codes = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of runs) for (const c of r.reason_codes) (m.get(c) ?? m.set(c, []).get(c)!).push(r.run_id);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [runs]);
  const open = useEvidence();
  const outcomes = [...new Set(rows.flatMap((r) => r.segments.map((s) => s.label)))];
  return (
    <>
      <PageHead title="How runs ended">Outcome is how the agent loop stopped; the evaluator's reason codes say what each check found. Select a segment or a code to open its runs.</PageHead>
      <section className="wrap stack-32">
        <Reveal className="controls"><label className="field"><span>Split by</span><select className="select" value={by} onChange={(e) => setBy(e.target.value)}>{d.store.group_dimensions.map((x) => <option key={x} value={x}>{dimLabel(x)}</option>)}</select></label></Reveal>
        <Reveal i={1}><FilterBar runs={d.runs} dims={d.store.filters.filter((x) => x !== by)} filters={filters} set={set} clear={clear} /></Reveal>
        <div className="legend">{outcomes.map((o) => <span key={o}><i style={{ background: OUTCOME_COLORS[o] ?? 'var(--tone-3)' }} />{o.replaceAll('_', ' ')}</span>)}</div>
        <StackBars key={by} rows={rows} onSelect={(row, s) => open({ title: `${row}: ${s.label.replaceAll('_', ' ')}`, summary: <>{s.count} of the runs in this group.</>, runIds: s.runIds })} />
      </section>
      <section className="section wrap stack-24" aria-labelledby="codes-title">
        <Reveal><h2 id="codes-title" className="statement">Evaluator reason codes</h2></Reveal>
        <div className="table-wrap"><table>
          <thead><tr><th>Reason code</th><th className="numc">Runs</th><th /></tr></thead>
          <tbody>{codes.map(([c, ids]) => (
            <tr key={c}><td><code>{c}</code></td><td className="numc">{ids.length.toLocaleString('en')}</td>
              <td className="numc"><button className="btn btn-secondary btn-sm" onClick={() => open({ title: c, runIds: ids })}>Open Runs</button></td></tr>
          ))}</tbody>
        </table></div>
      </section>
    </>
  );
}
