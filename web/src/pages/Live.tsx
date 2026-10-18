import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { API_BASE, type Catalog, type Job, type Me, deleteRun, download, ensureSession, getCatalog, getJob, getReport, me, myRuns, shareFromHash, shareRun, submitRun } from '../lib/live';
import { ci, pct, short } from '../lib/format';
import { Reveal } from '../components/Motion';
import { PageHead } from './Common';

type Mode = 'scripted' | 'hosted' | 'own_key';
const MODE_ORDER: Mode[] = ['hosted', 'own_key', 'scripted'];
const MODE_TITLE: Record<Mode, string> = { hosted: 'Live, our key', own_key: 'Live, your key', scripted: 'Instant, no model' };

export default function Live() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'browser' | 'cli'>(params.get('tab') === 'cli' ? 'cli' : 'browser');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [who, setWho] = useState<Me | null>(null);
  const runId = params.get('run');
  useEffect(() => {
    getCatalog().then((c) => { setCatalog(c); return c.storage === 'unavailable' ? undefined : ensureSession().then(me).then(setWho); }).catch((e) => setOffline(String(e.message ?? e)));
  }, []);
  const origin = API_BASE || (typeof window !== 'undefined' ? window.location.origin : '');
  return (
    <>
      <PageHead title="Run TrustBench live">
        Run the same paired benchmark as the study, now: the baseline agent and the defended agent on identical synthetic tasks and attacks, with the
        project's free-tier key, your own key, or no model at all. Sealed holdouts are never offered.
      </PageHead>
      <section className="wrap stack-32">
        <div className="segmented" role="tablist" aria-label="How to run">
          <button role="tab" aria-selected={tab === 'browser'} aria-pressed={tab === 'browser'} onClick={() => setTab('browser')}>In the browser</button>
          <button role="tab" aria-selected={tab === 'cli'} aria-pressed={tab === 'cli'} onClick={() => setTab('cli')}>From the command line</button>
        </div>
        {catalog?.storage === 'unavailable' && tab === 'browser' && (
          <div className="panel stack-8" role="status">
            <p className="body">Live runs are paused on this server: {catalog.modes.scripted.reason}.</p>
            <p className="small ink-2">The published results are all here: start at <Link to="/">the overview</Link> or <Link to="/method">the evidence index</Link>.</p>
          </div>
        )}
        {offline && tab === 'browser' && (
          <div className="panel stack-8" role="status">
            <p className="body">The live-test service is not reachable from this copy of the site ({offline}).</p>
            <p className="small ink-2">The published results are all here: start at <Link to="/">the overview</Link> or <Link to="/method">the evidence index</Link>.
              To run it yourself, use the command line tab with the project checkout.</p>
          </div>
        )}
        {tab === 'browser' && catalog && who && <SessionNote who={who} catalog={catalog} />}
        {tab === 'browser' && catalog && who && (runId ? <Result id={runId} onNew={() => setParams({})} /> : (
          <><RunForm catalog={catalog} onStarted={(id) => setParams({ run: id })} /><History onOpen={(id) => setParams({ run: id })} /></>
        ))}
        {tab === 'cli' && <CliGuide origin={origin} catalog={catalog} />}
      </section>
    </>
  );
}

function RunForm({ catalog, onStarted }: { catalog: Catalog; onStarted: (id: string) => void }) {
  // A reviewer may have no key: when the shared key is unavailable, fall back to the instant mode, not to "your key".
  const firstMode: Mode = catalog.modes.hosted.available ? 'hosted' : catalog.modes.scripted.available ? 'scripted' : (MODE_ORDER.find((m) => catalog.modes[m].available) ?? 'scripted');
  const [mode, setMode] = useState<Mode>(firstMode);
  const info = catalog.modes[mode];
  const systems = catalog.systems.filter((s) => s.modes.includes(mode));
  const [system, setSystem] = useState('');
  const [model, setModel] = useState('');
  const [rendering, setRendering] = useState(catalog.default_rendering);
  const [reps, setReps] = useState(1);
  const [key, setKey] = useState('');
  const [token, setToken] = useState('');
  const offered = catalog.cases.filter((c) => !(info.live && c.scripted_only));
  const maxPairs = info.limits.max_pairs_per_run;
  const [cases, setCases] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const sys = systems.find((s) => s.frozen) ?? systems[0];
    setSystem(sys?.id ?? '');
    setModel(info.models.find((m) => m.frozen)?.id ?? info.models[0]?.id ?? '');
    setReps(1);
    // A sensible default inside the mode's limit: for each workflow in turn, its first benign task and its first attack.
    const pick: string[] = [];
    for (const wf of [...new Set(offered.map((c) => c.workflow))]) {
      for (const kind of ['benign', 'attack'] as const) {
        const c = offered.find((o) => o.workflow === wf && o.kind === kind);
        if (c && pick.length < maxPairs) pick.push(c.id);
      }
    }
    setCases(pick);
    setError(null);
  }, [mode]);
  const pairs = cases.length * reps;
  const over = pairs > maxPairs;
  const selectedModel = info.models.find((m) => m.id === model);
  const toggle = (id: string) => setCases((cs) => (cs.includes(id) ? cs.filter((c) => c !== id) : [...cs, id]));
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const job = await submitRun({ mode, system, rendering, cases, repetitions: reps, ...(info.live ? { model } : {}), ...(mode === 'own_key' ? { api_key: key } : {}) }, token || undefined);
      setKey('');
      onStarted(job.id);
    } catch (e) { setError(String((e as Error).message)); } finally { setBusy(false); }
  };
  return (
    <Reveal className="stack-24">
      <div className="field"><span>Mode</span>
        <div className="segmented" role="group" aria-label="Mode">
          {MODE_ORDER.map((m) => (
            <button key={m} aria-pressed={mode === m} disabled={!catalog.modes[m].available} onClick={() => setMode(m)}>{MODE_TITLE[m]}</button>
          ))}
        </div>
        <p className="small ink-2">{info.label}.{mode === 'hosted' && info.remaining_pairs_today !== undefined ? ` ${info.remaining_pairs_today} shared pairs left today.` : ''}
          {MODE_ORDER.filter((m) => !catalog.modes[m].available).map((m) => ` ${MODE_TITLE[m]}: ${catalog.modes[m].reason}.`).join('')}</p>
      </div>
      <div className="controls">
        <label className="field"><span>Defense</span>
          <select className="select" value={system} onChange={(e) => setSystem(e.target.value)}>{systems.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        {info.live && <label className="field"><span>Model</span>
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>{info.models.map((m) => <option key={m.id} value={m.id}>{short(m.id)}{m.frozen ? ' (frozen)' : ''} · {m.provider}</option>)}</select></label>}
        <label className="field"><span>Attack wording</span>
          <select className="select" value={rendering} onChange={(e) => setRendering(e.target.value)}>{catalog.renderings.map((r) => <option key={r} value={r}>{r.replaceAll('_', ' ')}</option>)}</select></label>
        <label className="field"><span>Repetitions</span>
          <select className="select" value={reps} onChange={(e) => setReps(Number(e.target.value))}>{Array.from({ length: info.limits.max_repetitions }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
      </div>
      {mode === 'own_key' && (
        <label className="field live-key"><span>Your {selectedModel?.provider ?? ''} API key ({selectedModel?.key_env})</span>
          <input className="input" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="used for this run only, never stored" />
          <span className="small ink-2">Sent once to this service, passed to the runner for this run, then dropped. It is not saved, logged or shown again.</span>
        </label>
      )}
      {catalog.access_token_required && (
        <label className="field"><span>Access token</span><input className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
      )}
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend><span>Cases ({cases.length} selected · {pairs} paired runs of at most {maxPairs})</span></legend>
        <div className="live-cases">
          {offered.map((c) => (
            <label key={c.id} className="live-case"><input type="checkbox" checked={cases.includes(c.id)} onChange={() => toggle(c.id)} />
              <span className="live-case-text"><span>{c.id}</span><span className="small ink-2">{c.kind} · {c.workflow.replaceAll('_', ' ')}</span></span></label>
          ))}
        </div>
      </fieldset>
      {error && <p className="body" role="alert">{error}</p>}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" disabled={busy || !cases.length || over || (mode === 'own_key' && key.length < 16)} onClick={submit}>
          {busy ? 'Starting…' : `Run ${pairs} paired run${pairs === 1 ? '' : 's'}`}</button>
        <span className="small ink-2">{over ? `Too many for this mode: at most ${maxPairs}.` : info.live ? 'Live runs take one to four minutes per pair.' : 'Scripted runs finish in seconds.'}</span>
      </div>
      <p className="small ink-2">Agent under test: {catalog.agents.trustbench_baseline.label}. Connecting your own agent (LangGraph or any tool-calling agent) is planned:{' '}
        {Object.entries(catalog.agents).filter(([, a]) => a.status !== 'available').map(([k, a]) => `${a.label} (${a.tasks})`).join('; ')}.</p>
    </Reveal>
  );
}

function SessionNote({ who, catalog }: { who: Me; catalog: Catalog }) {
  return who.kind === 'account'
    ? <p className="small ink-2">Signed in as {who.email}. Your runs are kept for {who.retention_days} days. <Link to="/account">Account</Link></p>
    : <p className="small ink-2">You are a guest: no sign-up needed. Runs are kept for {catalog.auth?.retention_hours ?? who.retention_hours} hours in this browser.{' '}
        <Link to="/account">Create an account</Link> to keep them for {catalog.auth?.accounts.retention_days ?? 30} days on any device.</p>;
}

function History({ onOpen }: { onOpen: (id: string) => void }) {
  const [runs, setRuns] = useState<Job[]>([]);
  const load = () => myRuns().then(setRuns).catch(() => setRuns([]));
  useEffect(() => { load(); }, []);
  if (!runs.length) return null;
  return (
    <div className="stack-8">
      <h2 className="headline" style={{ fontSize: 28 }}>Your recent runs</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Started</th><th>Status</th><th>Defense</th><th>Model</th><th>Pairs</th><th /></tr></thead>
        <tbody>{runs.slice(0, 10).map((j) => (
          <tr key={j.id}><td>{j.created_at.replace('T', ' ').slice(0, 16)}</td><td>{j.status}</td><td>{j.system}</td><td>{j.model ? short(j.model.id) : 'scripted'}</td><td>{j.pairs}</td>
            <td><div className="row" style={{ gap: 8 }}><button className="btn btn-secondary btn-sm" onClick={() => onOpen(j.id)}>Open</button>
              <button className="btn btn-secondary btn-sm" onClick={async () => { await deleteRun(j.id); load(); }}>Delete</button></div></td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function Result({ id, onNew }: { id: string; onNew: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const j = await getJob(id);
        if (stop) return;
        setJob(j);
        if (j.status === 'done' || j.status === 'done_with_parity_warnings') setReport(await getReport(id));
        else if (j.status !== 'failed') setTimeout(tick, 1500);
      } catch (e) { setError(String((e as Error).message)); }
    };
    tick();
    return () => { stop = true; };
  }, [id]);
  const [note, setNote] = useState<string | null>(null);
  const shared = Boolean(shareFromHash());
  const copyShare = async () => {
    const { share_token } = await shareRun(id);
    const link = `${window.location.origin}/live?run=${id}#share=${share_token}`;
    await navigator.clipboard?.writeText(link).catch(() => undefined);
    setNote(`Share link copied. Anyone with it can read this run (not change or delete it): ${link}`);
  };
  if (error) return <div className="panel"><p className="body">{error}</p><button className="btn btn-secondary" onClick={onNew}>Start a new run</button></div>;
  if (!job) return <p className="body ink-2" aria-live="polite">Loading the run…</p>;
  const s = job.summary;
  return (
    <div className="stack-24" aria-live="polite">
      <div className="panel stack-8">
        <p className="body"><strong>{job.status === 'queued' ? `Queued (position ${job.queue_position ?? '…'})` : job.status === 'running' ? 'Running' : job.status === 'failed' ? 'Failed' : 'Done'}</strong>
          {' · '}{job.system} · {job.model ? short(job.model.id) : 'scripted'} · {job.rendering.replaceAll('_', ' ')} · {job.pairs} paired runs · key: {job.key_source ?? 'none'}</p>
        {(job.status === 'running' || job.status === 'queued') && (
          <div className="ratebar-track" role="progressbar" aria-valuemin={0} aria-valuemax={job.progress.total} aria-valuenow={job.progress.done}>
            <div className="ratebar-fill" style={{ width: `${(job.progress.done / Math.max(1, job.progress.total)) * 100}%`, background: 'var(--ink)' }} />
          </div>
        )}
        {job.status === 'running' && <p className="small ink-2">{job.progress.done} of {job.progress.total} pairs finished.</p>}
        {job.error && <p className="body" role="alert">{job.error}</p>}
      </div>
      {s && s.invalid_pairs > 0 && (
        <div className="panel stack-8" role="alert">
          <p className="body"><strong>{s.valid_pairs === 0 ? 'No valid runs.' : `${s.invalid_pairs} of ${s.valid_pairs + s.invalid_pairs} pairs are invalid and not counted.`}</strong></p>
          {s.invalid_reasons?.map((r) => <p key={r.code} className="small">{r.message} <span className="ink-2">({r.code}, {r.runs} run{r.runs === 1 ? '' : 's'})</span></p>)}
        </div>
      )}
      {s && (
        <>
          <div className="verdicts">
            <Verdict label="Unsafe effect, baseline" r={s.unsafe_committed_effect.baseline} />
            <Verdict label="Unsafe effect, defended" r={s.unsafe_committed_effect.defended} />
            <Verdict label="Task success, baseline" r={s.benign_utility_pass.baseline} />
            <Verdict label="Task success, defended" r={s.benign_utility_pass.defended} />
            <div><span className="small ink-2">Valid pairs</span><span className="num">{s.valid_pairs}</span><span className="small ink-2">{s.invalid_pairs} invalid</span></div>
            <div><span className="small ink-2">Response model</span><span className="body">{s.observed_response_models?.join(', ') ?? 'scripted'}</span></div>
          </div>
          {report && <CaseTable report={report} />}
          <p className="small ink-2">Rates with Wilson 95% intervals. One small live run is a demonstration, not an estimate: the study's numbers are on <Link to="/">the overview</Link>.</p>
        </>
      )}
      {note && <p className="small" role="status" style={{ overflowWrap: 'anywhere' }}>{note}</p>}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        {s && <button className="btn btn-secondary" onClick={() => download(id, 'report').catch((e) => setNote(String(e.message)))}>Download report JSON</button>}
        {s && <button className="btn btn-secondary" onClick={() => download(id, 'evaluation').catch((e) => setNote(String(e.message)))}>Download metrics and intervals</button>}
        {!shared && <button className="btn btn-secondary" onClick={() => copyShare().catch((e) => setNote(String(e.message)))}>Copy share link</button>}
        {!shared && <button className="btn btn-secondary" onClick={async () => { await deleteRun(id); onNew(); }}>Delete run</button>}
        <button className="btn btn-primary" onClick={onNew}>New run</button>
      </div>
    </div>
  );
}

function Verdict({ label, r }: { label: string; r: { numerator: number; denominator: number; rate: number | null; wilson95: [number, number] | null } }) {
  return <div><span className="small ink-2">{label}</span><span className="num">{r.denominator ? pct(r.rate) : '—'}</span><span className="small ink-2">{r.numerator}/{r.denominator} · {ci(r.wilson95)}</span></div>;
}

function CaseTable({ report }: { report: any }) {
  const rows = useMemo(() => report.cases.map((c: any) => ({ id: `${c.case_id} r${c.repetition}`, kind: c.kind,
    b: c.baseline, d: c.defended })), [report]);
  const verdict = (a: any, kind: string) => a.invalid ? 'invalid' : kind === 'attack' ? (a.evaluation.security_pass ? 'safe' : 'UNSAFE') + (a.evaluation.utility_pass ? ', task done' : '') : a.evaluation.utility_pass ? 'task done' : 'task failed';
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Case</th><th>Kind</th><th>Baseline</th><th>Defended</th><th>Denied calls</th></tr></thead>
        <tbody>{rows.map((r: any) => (
          <tr key={r.id}><td>{r.id}</td><td>{r.kind}</td><td>{verdict(r.b, r.kind)}</td><td>{verdict(r.d, r.kind)}</td>
            <td>{r.d.policy_decisions?.filter((x: any) => x.decision === 'deny').length ?? 0}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function CliGuide({ origin, catalog }: { origin: string; catalog: Catalog | null }) {
  // Every value comes from the service catalog; offline, neutral placeholders stand in.
  const system = catalog?.frozen.system ?? '<system>';
  const model = catalog?.frozen.model ?? '<provider:model>';
  const keyEnv = catalog?.modes.own_key.models.find((m) => m.id === model)?.key_env ?? '<KEY_ENV>';
  const blocks: [string, string][] = [
    ['Install the client once (git and uv; see the README)', 'git clone https://github.com/mhrj7/TrustBench-AI.git && cd TrustBench-AI && sh scripts/setup-python.sh'],
    ['See what this service offers', `sh bin/trustbench remote catalog --url ${origin}`],
    ['Instant run, no model and no key', `sh bin/trustbench remote run --url ${origin} --mode scripted --system gateway_capability --cases doc-benign,doc-attack --wait`],
    ['Live run with the project key', `sh bin/trustbench remote run --url ${origin} --mode hosted --system ${system} --model ${model} --cases doc-benign,doc-attack --wait`],
    ['Live run with your own key (read from an environment variable, never a flag)', `${keyEnv}=... sh bin/trustbench remote run --url ${origin} --mode own_key --key-env ${keyEnv} --system ${system} --model ${model} --cases doc-benign,doc-attack --wait`],
    ['Fetch a finished run', 'sh bin/trustbench remote report <run-id> --url ' + origin + ' --out report.json'],
    ['The same over plain HTTP: a guest session, then the run', `TOKEN=$(curl -s -X POST ${origin}/api/session | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')\ncurl -s -X POST ${origin}/api/runs -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"mode":"scripted","system":"gateway_capability","cases":["doc-benign","doc-attack"]}'`],
    ['Everything locally, from the checkout (README, Install)', 'export TRUSTBENCH_STORAGE_ROOT="$(dirname "$PWD")" npm_config_cache="$(dirname "$PWD")/.cache/npm"\ncp .env.example .env && npm ci && npm run setup && sh bin/trustbench smoke --check'],
  ];
  return (
    <Reveal className="stack-24">
      <p className="body ink-2">The command-line client is in the repository (<code>bin/trustbench</code>). It talks to this service, or runs everything locally. API reference: <a href={`${origin}/api/docs`}>{origin}/api/docs</a>.</p>
      {blocks.map(([title, cmd]) => (
        <div key={title} className="stack-8">
          <span className="small ink-2">{title}</span>
          <pre className="json" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}><code>{cmd}</code></pre>
        </div>
      ))}
    </Reveal>
  );
}
