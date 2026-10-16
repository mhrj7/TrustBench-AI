import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { denialPredicate, type Run as RunT } from '../lib/aggregate';
import { loadRecord, loadSpans, useAsync, useDataset, type Dataset } from '../lib/data';
import { ruleLabel, seconds, short } from '../lib/format';
import { Reveal } from '../components/Motion';
import { StepWaterfall, TimedWaterfall } from '../components/Waterfall';
import { Loading } from './Common';

export default function Run() {
  const data = useDataset();
  const { id = '' } = useParams();
  if (data.state !== 'ready') return <Loading state={data} />;
  const run = data.value.byId.get(decodeURIComponent(id));
  if (!run) return <div className="section wrap stack-24"><h1 className="headline">No such run</h1><p className="body ink-2">The run store has no run with this ID. <Link to="/runs">Browse all runs</Link>.</p></div>;
  return <RunBody d={data.value} run={run} />;
}

function RunBody({ d, run }: { d: Dataset; run: RunT }) {
  const rec = useAsync(() => loadRecord(run), [run.run_id]);
  const spans = useAsync(() => loadSpans(run), [run.run_id]);
  const isDenial = useMemo(() => denialPredicate(d.store.denial.codes, d.store.denial.prefixes), [d]);
  const marks: Record<number, string[]> = {};
  for (const [label, step] of [['first violation', run.first_step], ['utility attribution', run.utility_step], ['security attribution', run.security_step]] as const)
    if (step !== null && step !== undefined) (marks[step] ??= []).push(label);
  const verdicts = [['Outcome', run.outcome, run.outcome !== 'success'], ['Utility', run.utility_pass ? 'pass' : 'fail', !run.utility_pass],
    ['Security', run.security_pass ? 'pass' : 'fail', !run.security_pass], ['Attacker goal', run.attacker_goal ? 'reached' : 'not reached', run.attacker_goal],
    ['Elapsed', seconds(run.elapsed_ms), false], ['Tokens in / out', `${run.tokens_in ?? '—'} / ${run.tokens_out ?? '—'}`, false]] as const;
  return (
    <>
      <header className="section wrap stack-24">
        <Reveal><p className="small ink-2"><Link to="/runs">Runs</Link> / {run.case_id}</p></Reveal>
        <Reveal i={1}><h1 className="headline break">{run.case_id}</h1></Reveal>
        <Reveal i={2}><p className="body ink-2">Repetition {run.repetition}, {run.arm} arm · {short(run.model)} · defense <b className="ink">{run.system}</b> · {run.rendering} · {run.profile} profile · {run.kind} case{run.invalid ? ' · marked invalid by its report' : ''}</p></Reveal>
        <Reveal i={3} className="verdicts">
          {verdicts.map(([k, v, bad]) => <div key={k}><p className="small ink-2">{k}</p><p className={`figure-sm ${bad ? 'signal' : ''}`}>{v}</p></div>)}
        </Reveal>
        {(run.utility_rule || run.security_rule) && (
          <Reveal i={4}><p className="body">TB-029 attribution: {run.utility_rule && <>utility <b>{ruleLabel(run.utility_rule)}</b> at step {run.utility_step}</>}{run.utility_rule && run.security_rule ? '; ' : ''}{run.security_rule && <>security <b>{ruleLabel(run.security_rule)}</b> at step {run.security_step}</>}. <span className="ink-2">It names where the run first left its contract, not a proven cause.</span></p></Reveal>
        )}
      </header>

      <section className="section wrap stack-24" aria-labelledby="wf-title" style={{ paddingTop: 96 }}>
        <h2 id="wf-title" className="statement" style={{ maxWidth: 'none' }}>{run.timed ? 'Trace waterfall, timed from TB-027 spans' : 'Trace in step order (no spans were recorded for this run)'}</h2>
        <div className="panel">
          {run.timed && spans.state === 'ready' && spans.value.length ? <TimedWaterfall spans={spans.value} />
            : rec.state === 'ready' ? (rec.value.run.tool_trace.length ? <StepWaterfall steps={rec.value.run.tool_trace} marks={marks} isDenial={isDenial} /> : <p className="body ink-2">The run made no tool call.</p>)
            : <p className="body ink-2">Loading the trace…</p>}
        </div>
      </section>

      {rec.state === 'error' && <section className="wrap"><p className="body">{rec.error}</p></section>}
      {rec.state === 'ready' && <RecordSections rec={rec.value} marks={marks} isDenial={isDenial} run={run} />}
    </>
  );
}

function RecordSections({ rec, marks, isDenial, run }: { rec: Awaited<ReturnType<typeof loadRecord>>; marks: Record<number, string[]>; isDenial: (c: string) => boolean; run: RunT }) {
  const side = rec.run;
  const [depth, setDepth] = useState(2);
  const json = JSON.stringify(rec, null, 2);
  const download = () => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${run.run_id.replaceAll('|', '__')}.json` });
    a.click(); URL.revokeObjectURL(url);
  };
  return (
    <>
      <section className="section wrap stack-24" style={{ paddingTop: 96 }} aria-labelledby="steps-title">
        <h2 id="steps-title" className="statement" style={{ maxWidth: 'none' }}>Steps and the policy reason each call received</h2>
        <div className="table-wrap" data-lenis-prevent-horizontal>
          <table>
            <thead><tr><th className="numc">Step</th><th>Tool</th><th>Status</th><th>Error or policy reason</th><th>Attribution</th><th>Arguments (redacted)</th></tr></thead>
            <tbody>
              {side.tool_trace.map((s, i) => (
                <tr key={i}>
                  <td className="numc">{i}</td><td><code>{s.tool}</code></td>
                  <td>{s.status}{s.attempts === 0 ? <span className="ink-3"> · suppressed duplicate</span> : null}</td>
                  <td className={s.error && isDenial(s.error) ? 'signal' : 'ink-2'}>{s.error ?? '—'}{s.error && isDenial(s.error) ? ' (defense denial)' : ''}</td>
                  <td>{marks[i]?.join(', ') ?? <span className="ink-3">—</span>}</td>
                  <td className="args"><code className="break">{JSON.stringify(s.args)}</code></td>
                </tr>
              ))}
              {!side.tool_trace.length && <tr><td colSpan={6} className="ink-2">No tool calls.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section wrap" style={{ paddingTop: 96 }}>
        <div className="grid" style={{ rowGap: 48 }}>
          <div className="span-6 stack-24">
            <h2 className="statement">Gateway audit</h2>
            {side.policy_decisions?.length ? (
              <div className="table-wrap"><table>
                <thead><tr><th className="numc">Seq</th><th>Tool</th><th>Decision</th><th>Reason</th></tr></thead>
                <tbody>{side.policy_decisions.map((p) => <tr key={p.seq}><td className="numc">{p.seq}</td><td><code>{p.tool}</code></td><td className={p.decision === 'deny' ? 'signal' : ''}>{p.decision}</td><td className="ink-2">{p.reason ?? '—'}</td></tr>)}</tbody>
              </table></div>
            ) : <p className="body ink-2">No gateway decisions: the baseline arm, or a defense outside the gateway.</p>}
            <p className="small ink-2">Shown in the gateway's own order. Suppressed duplicates never reach the gateway and retried reads reach it more than once, so decisions are not matched to steps.</p>
          </div>
          <div className="start-8 stack-24">
            <h2 className="statement">Final text</h2>
            <p className="body final-text">{side.final_text || <span className="ink-3">(empty)</span>}</p>
            <p className="small ink-2">Evaluator: {side.evaluation.reason_codes.join(', ')}</p>
          </div>
        </div>
      </section>

      <section className="section wrap stack-24" style={{ paddingTop: 96 }} aria-labelledby="raw-title">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 id="raw-title" className="statement">Raw record</h2>
          <div className="row">
            <div className="segmented" role="group" aria-label="JSON depth">{[1, 2, 99].map((x) => <button key={x} aria-pressed={depth === x} onClick={() => setDepth(x)}>{x === 99 ? 'Everything' : `Depth ${x}`}</button>)}</div>
            <button className="btn btn-primary" onClick={download}>Download JSON</button>
          </div>
        </div>
        <dl className="kv">
          <dt>Report</dt><dd><code translate="no">{rec.source.report}</code></dd>
          <dt>SHA-256</dt><dd><code translate="no">{rec.source.sha256}</code></dd>
          <dt>JSON pointer</dt><dd><code translate="no">{rec.source.pointer}</code></dd>
          <dt>Run ID</dt><dd><code translate="no" className="break">{run.run_id}</code></dd>
        </dl>
        <pre className="json" data-lenis-prevent tabIndex={0} aria-label="Raw record JSON">{JSON.stringify(trim(rec, depth), null, 2)}</pre>
        <p className="small ink-2">Payloads are redacted with the TB-027 sensitive-value set. Verify the hash against the file: <code>shasum -a 256 {rec.source.report}</code></p>
      </section>
    </>
  );
}

function trim(v: unknown, depth: number): unknown {
  if (depth <= 0) return Array.isArray(v) ? `[… ${v.length} items]` : v && typeof v === 'object' ? '{…}' : v;
  if (Array.isArray(v)) return v.map((x) => trim(x, depth - 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth - 1)]));
  return v;
}
