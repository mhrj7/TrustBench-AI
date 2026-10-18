import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { aggregate, type Group, type Run } from '../lib/aggregate';
import { loadSpans, runPath, useAsync, useDataset, type Dataset } from '../lib/data';
import { pct, short } from '../lib/format';
import { CountUp, EASE_OUT, Reveal } from '../components/Motion';
import { RateBars } from '../components/Charts';
import { useEvidence } from '../components/Shell';
import { TimedWaterfall } from '../components/Waterfall';
import { Loading } from './Common';

/** The defended system each report evaluates, read from its defended runs (baseline runs carry "baseline"). */
export function reportSystems(runs: Run[]) {
  const m = new Map<number, string>();
  for (const r of runs) if (r.arm === 'defended') m.set(r.report, r.system);
  return m;
}

/** The model on which the most defended systems were run: the fairest single-model comparison in the store. */
export function comparisonModel(runs: Run[]) {
  const per = new Map<string, Set<string>>();
  for (const r of runs) if (r.arm === 'defended') (per.get(r.model) ?? per.set(r.model, new Set()).get(r.model)!).add(r.system);
  return [...per.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))[0][0];
}

export default function Overview() {
  const data = useDataset();
  if (data.state !== 'ready') return <Loading state={data} />;
  return <OverviewBody d={data.value} />;
}

function OverviewBody({ d }: { d: Dataset }) {
  const { store, runs } = d;
  const valid = runs.filter((r) => !r.invalid);
  const models = new Set(runs.map((r) => r.model));
  const systems = new Set(runs.filter((r) => r.arm === 'defended').map((r) => r.system));
  const hero = store.hero_run ? d.byId.get(store.hero_run) : undefined;
  const fp = valid.filter((r) => r.utility_rule === 'call_denied_by_defense').length;
  return (
    <>
      <section className="section wrap hero" aria-labelledby="hero-title">
        <div className="grid" style={{ rowGap: 56 }}>
          <Reveal i={0} className="span-12"><h1 id="hero-title" className="display hero-title">Does the defense hold?</h1></Reveal>
          <div className="span-5 stack-32 hero-copy">
            <Reveal i={1}><p className="statement ink-2">TrustBench ran {runs.length.toLocaleString('en')} agent runs against prompt injection, each paired with and without a defense. Every number here opens to the hashed record behind it.</p></Reveal>
            <Reveal i={2}><div className="row"><Link className="btn btn-primary" to="/compare">Compare defenses</Link>{hero && <Link className="btn btn-secondary" to={runPath(hero.run_id)}>Open this run</Link>}</div></Reveal>
          </div>
          <div className="start-7">{hero && <HeroTrace run={hero} />}</div>
        </div>
      </section>

      <section className="section wrap" aria-labelledby="count-title">
        <Reveal><h2 id="count-title" className="headline" style={{ maxWidth: '16ch' }}>Counted, hashed, and redacted.</h2></Reveal>
        <div className="figures">
          {[[runs.length, 'runs in the store, each with its tool trace and evaluator verdict'], [store.reports.length, 'live evidence reports, pinned by SHA-256'],
            [models.size, 'models, all on free tiers or local hardware'], [systems.size, 'defended configurations, each against its own paired baseline'],
            [runs.filter((r) => r.timed).length, 'runs with timed spans, replayable as waterfalls'], [runs.length - valid.length, 'runs the reports marked invalid and never counted']].map(([v, label], i) => (
            <Reveal key={String(label)} i={i % 3} className="figure-cell">
              <CountUp className={`figure ${i === 5 ? 'signal' : ''}`} to={Number(v)} />
              <p className="small ink-2">{label}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <PairedMorph d={d} />

      <UtilityCost d={d} fp={fp} />

      <AttributionStrip d={d} />
    </>
  );
}

function HeroTrace({ run }: { run: Run }) {
  const spans = useAsync(() => loadSpans(run), [run.run_id]);
  const [take, setTake] = useState(0);
  return (
    <Reveal i={2} className="hero-trace panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="small"><span className="ink-2">A real run from the store</span><br />{short(run.model)} · {run.system} · {run.case_id}</p>
        <button className="btn btn-secondary" onClick={() => setTake((t) => t + 1)} aria-label="Replay the trace">Replay</button>
      </div>
      {spans.state === 'ready' && spans.value.length > 0 ? <TimedWaterfall key={take} spans={spans.value} speed={0.55} /> : <div className="hero-trace-empty" />}
      <p className="small ink-2">Gateway denials and failed calls in signal. Outcome: {run.outcome}; utility {run.utility_pass ? 'passed' : 'failed'}, security {run.security_pass ? 'passed' : 'failed'}.</p>
    </Reveal>
  );
}

type Pair = { system: string; base: Group['metrics'][string]; def: Group['metrics'][string]; baseIds: string[]; defIds: string[] };

function pairs(d: Dataset, model: string, metric: 'attacker_goal' | 'utility_pass', kind: string): Pair[] {
  const sys = reportSystems(d.runs);
  const runs = d.runs.filter((r) => !r.invalid && r.model === model && r.kind === kind);
  const tagged = runs.map((r) => ({ ...r, system: sys.get(r.report) ?? r.system }));
  const spec = { [metric]: d.store.metrics[metric] };
  const out: Pair[] = [];
  for (const g of aggregate(tagged as Run[], ['system'], spec, d.store.wilson_z)) {
    const members = tagged.filter((r) => r.system === g.key.system);
    const [b] = aggregate(members.filter((r) => r.arm === 'baseline') as Run[], [], spec, d.store.wilson_z);
    const [x] = aggregate(members.filter((r) => r.arm === 'defended') as Run[], [], spec, d.store.wilson_z);
    if (b && x && b.metrics[metric].n && x.metrics[metric].n)
      out.push({ system: String(g.key.system), base: b.metrics[metric], def: x.metrics[metric], baseIds: b.run_ids, defIds: x.run_ids });
  }
  return out.sort((a, b) => (a.def.rate ?? 0) - (b.def.rate ?? 0));
}

/** The section's claim, chosen from the data so it never says more than the rows show. */
export function morphHeadline(rows: Pair[]) {
  // Point estimates on small development run sets: the headline counts, never says a defense works; the paragraph states the data (TB-048).
  const lower = rows.filter((p) => (p.def.rate ?? 0) < (p.base.rate ?? 0)).length;
  const noneZero = rows.every((p) => (p.def.rate ?? 0) > 0);
  if (lower === rows.length) return noneZero ? 'Fewer attacker wins each time; none at zero.' : 'Fewer attacker wins for every defense.';
  return `Fewer attacker wins for ${lower} of ${rows.length} defenses.`;
}

function PairedMorph({ d }: { d: Dataset }) {
  const model = useMemo(() => comparisonModel(d.runs), [d]);
  const rows = useMemo(() => pairs(d, model, 'attacker_goal', 'attack'), [d, model]);
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const t = useTransform(scrollYProgress, [0.12, 0.72], [0, 1], { clamp: true });
  const open = useEvidence();
  // Height from the viewport measured once, so a later resize (or a full-page capture) does not stretch the scroll track.
  const [vh] = useState(() => window.innerHeight);
  return (
    <section ref={ref} className="morph" style={{ height: reduce ? 'auto' : Math.round((vh * Math.max(180, 120 + rows.length * 6)) / 100) }} aria-labelledby="morph-title">
      <div className="morph-sticky wrap" style={reduce ? { position: 'static' } : undefined}>
        <div className="grid" style={{ rowGap: 32 }}>
          <div className="span-5 stack-24">
            <h2 id="morph-title" className="headline">{morphHeadline(rows)}</h2>
            <p className="body ink-2">Attacker goal reached on attack cases for {short(model)}, the model every defense was run on. Each defense is compared with the baseline arm of its own reports, on the same cases. These are development runs and point estimates, not a confirmatory result (that is in the technical report). Scroll to move each bar from its baseline to its defended rate.</p>
            <MorphLegend t={t} reduce={!!reduce} />
          </div>
          <ol className="span-7 morph-bars" aria-label="Attacker goal rate, baseline and defended">
            {rows.map((p) => <MorphBar key={p.system} p={p} t={t} reduce={!!reduce}
              onOpen={() => open({ title: `${p.system} on ${short(model)}`, summary: <>Attacker goal reached: baseline {p.base.k}/{p.base.n} ({pct(p.base.rate)}), defended {p.def.k}/{p.def.n} ({pct(p.def.rate)}).</>,
                runIds: [...p.defIds, ...p.baseIds], counted: Object.fromEntries([...p.def.hit_ids, ...p.base.hit_ids].map((id) => [id, 'yes' as const]).concat([...p.def.miss_ids, ...p.base.miss_ids].map((id) => [id, 'no' as const]))) })} />)}
          </ol>
        </div>
      </div>
    </section>
  );
}

function MorphLegend({ t, reduce }: { t: MotionValue<number>; reduce: boolean }) {
  const base = useTransform(t, [0, 0.5], [1, 0.35]);
  const def = useTransform(t, [0.5, 1], [0.35, 1]);
  return (
    <div className="legend" aria-hidden="true">
      <motion.span style={{ opacity: reduce ? 1 : base }}><i style={{ background: 'var(--ink-2)' }} />Baseline arm</motion.span>
      <motion.span style={{ opacity: reduce ? 1 : def }}><i style={{ background: 'var(--signal)' }} />Defended arm</motion.span>
    </div>
  );
}

function MorphBar({ p, t, reduce, onOpen }: { p: Pair; t: MotionValue<number>; reduce: boolean; onOpen: () => void }) {
  const b = p.base.rate ?? 0, x = p.def.rate ?? 0;
  const scale = useTransform(t, [0, 1], [b, x]);
  const label = useTransform(t, (v) => pct(b + (x - b) * v));
  return (
    <li>
      <button className="ratebar" onClick={onOpen} aria-label={`${p.system}: baseline ${pct(b)} (${p.base.k}/${p.base.n}), defended ${pct(x)} (${p.def.k}/${p.def.n}). Open the evidence.`}>
        <span className="ratebar-label small">{p.system}</span>
        <span className="ratebar-track">
          <span className="ratebar-ghost" style={{ width: `${b * 100}%` }} />
          {reduce ? <span className="ratebar-fill" style={{ width: `${x * 100}%`, background: 'var(--signal)' }} />
            : <motion.span className="ratebar-fill ratebar-fill-full" style={{ scaleX: scale, background: 'var(--signal)' }} />}
        </span>
        <span className="ratebar-value num">{reduce ? pct(x) : <motion.span>{label}</motion.span>}<span className="ink-3"> of {p.def.n}</span></span>
      </button>
    </li>
  );
}

function UtilityCost({ d, fp }: { d: Dataset; fp: number }) {
  const model = useMemo(() => comparisonModel(d.runs), [d]);
  const sys = useMemo(() => reportSystems(d.runs), [d]);
  const open = useEvidence();
  const groups = useMemo(() => {
    const runs = d.runs.filter((r) => !r.invalid && r.model === model && r.kind === 'benign').map((r) => ({ ...r, system: r.arm === 'baseline' ? 'baseline' : sys.get(r.report) ?? r.system }));
    return aggregate(runs as Run[], ['system'], { utility_pass: d.store.metrics.utility_pass }, d.store.wilson_z);
  }, [d, model, sys]);
  return (
    <section className="section wrap" aria-labelledby="cost-title">
      <div className="grid" style={{ rowGap: 48 }}>
        <div className="span-5 stack-24">
          <Reveal><h2 id="cost-title" className="headline">Some defenses also refuse correct work.</h2></Reveal>
          <Reveal i={1}><p className="body ink-2">Benign utility on {short(model)}: the share of benign cases the agent completed. The baseline bar pools the baseline arms of every report on this model; bars below it are the cost of the defense.</p></Reveal>
          <Reveal i={2} className="stack-8"><CountUp className="figure signal" to={fp} /><p className="small ink-2">failed runs where a defense denied a write that broke no rule, a defense false positive by the TB-029 localizer. <Link to="/policy">See the policy reasons</Link>.</p></Reveal>
        </div>
        <div className="start-7">
          <RateBars groups={groups} dim="system" metric="utility_pass" spec={d.store.metrics.utility_pass} muted={(g) => g.key.system === 'baseline'}
            reference={groups.find((g) => g.key.system === 'baseline')?.metrics.utility_pass.rate ?? undefined}
            onSelect={(g) => open({ title: `Benign utility, ${g.key.system}`, summary: <>{g.metrics.utility_pass.k} of {g.metrics.utility_pass.n} benign runs passed ({pct(g.metrics.utility_pass.rate)}).</>,
              runIds: g.run_ids, counted: Object.fromEntries(g.metrics.utility_pass.hit_ids.map((i) => [i, 'yes' as const]).concat(g.metrics.utility_pass.miss_ids.map((i) => [i, 'no' as const]))) })} />
        </div>
      </div>
    </section>
  );
}

function AttributionStrip({ d }: { d: Dataset }) {
  const a = d.store.attribution;
  const reduce = useReducedMotion();
  const rounds = Object.entries(a.rounds);
  return (
    <section className="section wrap" aria-labelledby="att-title">
      <div className="att panel">
        <div className="grid" style={{ rowGap: 40 }}>
          <div className="span-5 stack-24">
            <Reveal><h2 id="att-title" className="headline">Where each failed run went wrong.</h2></Reveal>
            <Reveal i={1}><p className="body ink-2">A deterministic localizer names the first step that left the task contract. An AI audit (an AI model, not a human) scored each version on fresh cases it was never fixed against.</p></Reveal>
            <Reveal i={2}><Link className="btn btn-secondary" to="/attribution">Read the audit</Link></Reveal>
          </div>
          <ol className="start-7 att-rounds" aria-label="Audit accuracy by round">
            {rounds.map(([r, v], i) => (
              <li key={r} className="att-round">
                <span className="small ink-2">Round {r} · localizer {v.localizer_version}</span>
                <span className="att-track">
                  <motion.span className="att-fill" style={{ width: `${(v.summary.all.accuracy ?? 0) * 100}%`, background: Number(r) === a.measured.round ? 'var(--signal)' : 'var(--ink-2)' }}
                    initial={{ scaleX: reduce ? 1 : 0 }} whileInView={{ scaleX: 1 }} viewport={{ once: true }} transition={{ duration: 0.8, ease: EASE_OUT, delay: i * 0.08 }} />
                </span>
                <span className="figure-sm num">{pct(v.summary.all.accuracy)}<span className="small ink-3 kn">{v.summary.all.correct}/{v.summary.all.judged}</span></span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
