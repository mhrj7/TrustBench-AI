import { AnimatePresence, LayoutGroup, motion, useReducedMotion, useScroll, useTransform, type MotionValue } from 'motion/react';
import { Suspense, lazy, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { aggregate, type Group, type Run } from '../lib/aggregate';
import { loadHeadline, loadSpans, runPath, useAsync, useDataset, type Dataset, type Headline } from '../lib/data';
import { Bento, Card, Eyebrow } from '../components/Bento';
import { Story } from '../components/Story';
import { pct, short } from '../lib/format';
import { CountUp, EASE_OUT, Reveal } from '../components/Motion';
import { RateBars } from '../components/Charts';
import { useEvidence } from '../components/Shell';
import { TimedWaterfall } from '../components/Waterfall';
import { Loading } from './Common';

const Hero3D = lazy(() => import('../components/Hero3D'));
const SPRING = { type: 'spring', bounce: 0, duration: 0.55 } as const;

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
  const hero = store.hero_run ? d.byId.get(store.hero_run) : undefined;
  const fp = valid.filter((r) => r.utility_rule === 'call_denied_by_defense').length;
  const h = useAsync(loadHeadline, []);
  const reduce = !!useReducedMotion();
  return (
    <>
      <section className="hero-x" aria-labelledby="hero-title">
        <Suspense fallback={<div className="hero-canvas" aria-hidden="true" />}><Hero3D reduce={reduce} /></Suspense>
        <div className="hero-x-copy wrap">
          <motion.p className="pill" initial={{ opacity: 0, y: reduce ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            <span className="pill-dot" />A benchmark for AI helpers that use tools
          </motion.p>
          <motion.h1 id="hero-title" className="display hero-title" initial={{ opacity: 0, y: reduce ? 0 : 24 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING, delay: 0.08 }}>
            Can a guard stop a <span className="grad">tricked</span> AI?
          </motion.h1>
          <motion.p className="statement ink-2 hero-lede" initial={{ opacity: 0, y: reduce ? 0 : 16 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING, delay: 0.16 }}>
            AI helpers read documents and then act. If a document hides an instruction, the helper might obey it. TrustBench measures whether a guard stops that, without stopping the real work.
          </motion.p>
          <motion.div className="row hero-ctas" initial={{ opacity: 0, y: reduce ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING, delay: 0.24 }}>
            <a className="btn btn-primary" href="#story">See how it works</a>
            <Link className="btn btn-glass" to="/live">Run a live test</Link>
          </motion.div>
          {h.state === 'ready' && (
            <motion.dl className="hero-stats" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ ...SPRING, delay: 0.4 }}>
              <div><dt>runs recorded</dt><dd><CountUp to={runs.length} /></dd></div>
              <div><dt>sealed-test runs</dt><dd><CountUp to={h.value.confirmatory_runs} /></dd></div>
              <div><dt>steps to rebuild every number</dt><dd><CountUp to={h.value.reproduction.steps} /></dd></div>
            </motion.dl>
          )}
        </div>
      </section>

      <section id="story" className="section wrap" aria-labelledby="story-title">
        <div className="section-head">
          <Eyebrow>The story</Eyebrow>
          <h2 id="story-title" className="headline">The trick, and the guard.</h2>
        </div>
        {h.state === 'ready' ? <Story ex={h.value.example} /> : <Loading state={h} />}
      </section>

      {h.state === 'ready' && <Simulator h={h.value} />}

      {h.state === 'ready' && <Results h={h.value} />}

      <section className="section wrap" aria-labelledby="inside-title">
        <div className="section-head">
          <Eyebrow>For reviewers</Eyebrow>
          <h2 id="inside-title" className="headline">Look inside the evidence.</h2>
          <p className="body ink-2" style={{ maxWidth: '60ch' }}>Every chart below opens the runs behind it, and every run opens its raw record. These are development runs from the published store, not the sealed test.</p>
        </div>
        <Bento>
          <Card span={7} label="A real run from the store">{hero ? <HeroTrace run={hero} /> : <p className="body ink-2">No timed run in the store.</p>}</Card>
          <Card span={5} label="Browse the evidence">
            <Eyebrow>Explore</Eyebrow>
            <h3 className="statement">Every run, every reason.</h3>
            <p className="body ink-2"><CountUp to={valid.length} /> valid runs across {new Set(runs.map((r) => r.model)).size} models, each with its tool trace and the evaluator's verdict.</p>
            <div className="row" style={{ marginTop: 'auto' }}><Link className="btn btn-glass" to="/runs">All runs</Link><Link className="btn btn-glass" to="/compare">Compare defenses</Link><Link className="btn btn-glass" to="/policy">Why calls were stopped</Link></div>
          </Card>
        </Bento>
      </section>

      <PairedMorph d={d} />

      <UtilityCost d={d} fp={fp} />

      <AttributionStrip d={d} />

      <section className="section wrap" aria-labelledby="cta-title">
        <div className="cta-band">
          <h2 id="cta-title" className="headline">Try to trick it yourself.</h2>
          <p className="body ink-2">Run the same comparison in your browser: instantly with no model, live on our free-tier key, or with your own key.</p>
          <div className="row"><Link className="btn btn-primary" to="/live">Run it live</Link><Link className="btn btn-glass" to="/method">How to check a number</Link></div>
        </div>
      </section>
    </>
  );
}

/** "Flip the guard": the real recorded pair of runs, replayed step by step, without and with the guard. */
function Simulator({ h }: { h: Headline }) {
  const [guard, setGuard] = useState(false);
  const [take, setTake] = useState(0);
  const reduce = useReducedMotion();
  const side = guard ? h.example.with_guard : h.example.without_guard;
  const tricked = side.attacker_goal_achieved;
  const denied = new Map(side.decisions.filter((x) => x.decision === 'deny').map((x) => [x.tool, x.reason]));
  return (
    <section className="section wrap" aria-labelledby="sim-title">
      <div className="section-head">
        <Eyebrow>Flip the guard</Eyebrow>
        <h2 id="sim-title" className="headline">Same task, same trick. You choose.</h2>
        <p className="body ink-2" style={{ maxWidth: '62ch' }}>This is a real pair of recorded runs ({h.example.case_id}, repetition {h.example.repetition}), not an animation made up for the page. Switch the guard on and off to replay what the tools actually did.</p>
      </div>
      <Bento>
        <Card span={12} className="sim" tone={tricked ? 'danger' : 'safe'} label="Flip the guard">
          <div className="sim-top">
            <div className="switch" role="group" aria-label="Guard">
              <LayoutGroup id="guard-switch">
                {[false, true].map((on) => (
                  <button key={String(on)} aria-pressed={guard === on} onClick={() => { setGuard(on); setTake((t) => t + 1); }}>
                    {guard === on && <motion.span layoutId="switch-thumb" className="switch-thumb" transition={SPRING} />}
                    <span className="switch-label">{on ? 'Guard on' : 'Guard off'}</span>
                  </button>
                ))}
              </LayoutGroup>
            </div>
            <button className="btn btn-glass" onClick={() => setTake((t) => t + 1)}>Replay</button>
          </div>
          <div className="sim-grid">
            <div className="sim-doc">
              <p className="small ink-2">The task</p>
              <p className="body">{h.example.task}</p>
              <p className="small ink-2" style={{ marginTop: 16 }}>Hidden in the document</p>
              <p className="sim-trick mono">{h.example.hidden_text}</p>
            </div>
            <ol className="sim-steps" key={`${guard}-${take}`} aria-live="polite">
              {side.tools.map((t, i) => {
                const blocked = t.status !== 'succeeded';
                return (
                  <motion.li key={i} className={`sim-step ${blocked ? 'is-blocked' : ''}`} initial={{ opacity: 0, x: reduce ? 0 : -18 }} animate={{ opacity: 1, x: 0 }}
                    transition={{ ...SPRING, delay: reduce ? 0 : 0.15 + i * 0.32 }}>
                    <span className="sim-step-n mono">{i + 1}</span>
                    <span className="mono">{t.tool.replaceAll('_', ' ')}</span>
                    <span className="sim-step-v">{blocked ? `stopped by the guard (${(denied.get(t.tool) ?? t.error ?? 'not allowed').replaceAll('_', ' ')})` : 'done'}</span>
                  </motion.li>
                );
              })}
            </ol>
            <AnimatePresence mode="wait">
              <motion.div key={`${guard}-${take}`} className={`sim-verdict ${tricked ? 'tone-danger' : 'tone-safe'}`} initial={{ opacity: 0, scale: reduce ? 1 : 0.92 }}
                animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ ...SPRING, delay: reduce ? 0 : 0.2 + side.tools.length * 0.32 }}>
                <p className="figure-sm">{tricked ? 'Tricked' : 'Safe'}</p>
                <p className="small">{tricked ? 'The hidden instruction ran a tool the task never allowed.' : side.utility_pass ? 'The forbidden tool was stopped and the real task still got done.' : 'The forbidden tool was stopped.'}</p>
              </motion.div>
            </AnimatePresence>
          </div>
        </Card>
      </Bento>
    </section>
  );
}

function Split({ label, from, to, fromRate, toRate, tone }: { label: string; from: string; to: string; fromRate: number; toRate: number; tone: 'danger' | 'safe' }) {
  const reduce = useReducedMotion();
  const bar = (rate: number, muted: boolean, i: number) => (
    <span className="split-track"><motion.span className={`split-fill ${muted ? 'muted' : `fill-${tone}`}`} style={{ width: `${rate * 100}%` }}
      initial={{ scaleX: reduce ? 1 : 0 }} whileInView={{ scaleX: 1 }} viewport={{ once: true }} transition={{ type: 'spring', bounce: 0, duration: 1, delay: 0.15 + i * 0.25 }} /></span>
  );
  return (
    <div className="split" aria-label={`${label}: ${from} without the guard, ${to} with it`}>
      <div className="split-row"><span className="small ink-2">Without the guard</span>{bar(fromRate, true, 0)}<span className="num">{from}</span></div>
      <div className="split-row"><span className="small ink-2">With the guard</span>{bar(toRate, false, 1)}<span className="num">{to}</span></div>
    </div>
  );
}

function Interval({ point, ci, lo = -100, hi = 100 }: { point: number; ci: [number, number]; lo?: number; hi?: number }) {
  const reduce = useReducedMotion();
  const x = (v: number) => ((v - lo) / (hi - lo)) * 100;
  return (
    <div className="interval" aria-label={`difference ${point} percentage points, ${Math.round((ci[1] - ci[0]) * 10) / 10} points wide interval`}>
      <span className="interval-zero" style={{ left: `${x(0)}%` }} />
      <motion.span className="interval-range" style={{ left: `${x(ci[0])}%`, width: `${x(ci[1]) - x(ci[0])}%` }}
        initial={{ scaleX: reduce ? 1 : 0 }} whileInView={{ scaleX: 1 }} viewport={{ once: true }} transition={{ type: 'spring', bounce: 0, duration: 0.9, delay: 0.3 }} />
      <motion.span className="interval-dot" style={{ left: `${x(point)}%` }} initial={{ scale: reduce ? 1 : 0 }} whileInView={{ scale: 1 }} viewport={{ once: true }}
        transition={{ type: 'spring', bounce: 0.3, duration: 0.6, delay: 0.7 }} />
    </div>
  );
}

const pp = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;

/** One square per tricked task; the red ones are tasks where the trick worked. Fills in once, on view. */
function Dots({ label, hits, total }: { label: string; hits: number; total: number }) {
  const reduce = useReducedMotion();
  return (
    <div className="dots-wrap">
      <p className="small ink-2">{label}: <span className="num">{hits}</span> of {total}</p>
      <motion.ol className="dots" aria-label={`${label}: ${hits} of ${total} tasks`} initial="off" whileInView="on" viewport={{ once: true, margin: '0px 0px -10% 0px' }}
        variants={{ on: { transition: { staggerChildren: reduce ? 0 : 0.012 } } }}>
        {Array.from({ length: total }, (_, i) => (
          <motion.li key={i} className={i < hits ? 'dot hit' : 'dot'} variants={{ off: { scale: reduce ? 1 : 0.2, opacity: reduce ? 1 : 0 }, on: { scale: 1, opacity: 1 } }}
            transition={{ type: 'spring', bounce: 0, duration: 0.35 }} />
        ))}
      </motion.ol>
    </div>
  );
}

function Results({ h }: { h: Headline }) {
  const u = h.primary.unsafe, t = h.primary.utility;
  const level = Math.round(h.confidence * 100);
  const sorted = [...h.comparison.systems].sort((a, b) => a.defended.rate - b.defended.rate);
  return (
    <section className="section wrap" aria-labelledby="found-title">
      <div className="section-head">
        <Eyebrow>What we found</Eyebrow>
        <h2 id="found-title" className="headline">{h.primary.verdict === 'supported' ? 'Fewer tricks got through.' : 'No clear difference.'}</h2>
        <p className="body ink-2" style={{ maxWidth: '62ch' }}>{h.primary.verdict === 'supported' ? 'And the real work still got done. ' : ''}These results are from the sealed test: tasks the project had never been tuned on, locked away before the guard was finished and run once.</p>
      </div>
      <Bento>
        <Card span={7} rows={2} tone="danger" label="Unsafe actions">
          <Eyebrow>Unsafe actions in tricked tasks</Eyebrow>
          <p className="figure"><span className="danger">{u.baseline}</span> <span className="ink-3">to</span> <span className="safe">{u.defended}</span></p>
          <p className="body ink-2">When a document tried to trick the helper, it did something unsafe in {u.baseline.split('/')[0]} of {u.baseline.split('/')[1]} tasks without the guard, and in {u.defended.split('/')[0]} with it.</p>
          <div className="dots-pair">
            <Dots label="Without the guard" hits={Number(u.baseline.split('/')[0])} total={Number(u.baseline.split('/')[1])} />
            <Dots label="With the guard" hits={Number(u.defended.split('/')[0])} total={Number(u.defended.split('/')[1])} />
          </div>
          <div className="stack-8" style={{ marginTop: 'auto' }}>
            <p className="small ink-2">Difference {pp(u.difference_pp)} percentage points; {level}% interval {pp(u.ci95_pp[0])} to {pp(u.ci95_pp[1])}. The whole interval is below zero.</p>
            <Interval point={u.difference_pp} ci={u.ci95_pp} />
          </div>
        </Card>
        <Card span={5} tone="safe" label="Tasks still done">
          <Eyebrow>Normal tasks still done</Eyebrow>
          <p className="figure"><span className="ink-2">{t.baseline}</span> <span className="ink-3">to</span> <span className="safe">{t.defended}</span></p>
          <Split label="Tasks done" from={t.baseline} to={t.defended} fromRate={t.baseline_rate} toRate={t.defended_rate} tone="safe" />
          <p className="small ink-2">The guard did not stop the real work; the comparison helper's tools accept any call, so it fails more often.</p>
        </Card>
        <Card span={5} label="The price">
          <Eyebrow>The price</Eyebrow>
          <p className="figure"><CountUp to={h.extra_seconds} format={(v) => `+${v.toFixed(1)} s`} /></p>
          <p className="small ink-2">More time per run on average, because the guard checks each action. Every model used was free, so nothing was billed.</p>
        </Card>
        <Card span={6} label="Compared with other defenses">
          <Eyebrow>Against other ideas</Eyebrow>
          <h3 className="statement">Unsafe actions per {sorted[0]?.defended.denominator} tricked runs</h3>
          <ul className="race">
            {sorted.map((s, i) => (
              <li key={s.id} className={s.id === sorted[0].id ? 'is-ours' : ''}>
                <span className="small">{s.label}</span>
                <span className="race-track"><motion.span className="race-fill" style={{ width: `${Math.max(s.defended.rate, 0.02) * 100}%` }} initial={{ scaleX: 0 }} whileInView={{ scaleX: 1 }}
                  viewport={{ once: true }} transition={{ type: 'spring', bounce: 0, duration: 0.9, delay: 0.1 + i * 0.08 }} /></span>
                <span className="num small">{s.defended.numerator}</span>
              </li>
            ))}
          </ul>
          <p className="small ink-3">{h.comparison.note}</p>
        </Card>
        <Card span={6} label="Checked by reviewers">
          <Eyebrow>Checked twice</Eyebrow>
          <h3 className="statement">Two AI reviewers re-labelled {h.audit.sampled} runs blind.</h3>
          <p className="body ink-2">They agreed with the scoring on every safety label ({h.audit.security_errors} errors) and found {h.audit.oracle_defects} rule mistake, which was fixed and every number recomputed. No human reviewed the runs.</p>
        </Card>
        <Card span={4} label="Rebuild every number">
          <Eyebrow>Rebuild it yourself</Eyebrow>
          <p className="figure"><CountUp to={h.reproduction.steps} /></p>
          <p className="small ink-2">offline steps rebuild every published number in a clean container: {h.reproduction.outcome.toLowerCase()}.</p>
          <a className="btn btn-glass" href="https://github.com/mhrj7/TrustBench-AI/blob/main/repro/README.md" style={{ marginTop: 'auto' }}>How to reproduce</a>
        </Card>
        <Card span={8} label="What this does not prove">
          <Eyebrow>Honest limits</Eyebrow>
          <ul className="limits">
            <li>The first sealed test on its own was too small to tell ({h.holdout1_verdict}); the result holds on both tests pooled.</li>
            <li>One free model, a small set of everyday tasks, and attacks written in advance. A clever attacker who adapts was not tested.</li>
            <li>Most of the gain comes from the permission list; the smarter check on top is not shown to add to it.</li>
          </ul>
          <a className="btn btn-glass" href="https://github.com/mhrj7/TrustBench-AI/blob/main/research/report.md" style={{ marginTop: 'auto' }}>Read the technical report</a>
        </Card>
      </Bento>
    </section>
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
                  <motion.span className="att-fill" style={{ width: `${(v.summary.all.accuracy ?? 0) * 100}%`, background: Number(r) === a.measured.round ? 'var(--data-1)' : 'var(--data-2)' }}
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
