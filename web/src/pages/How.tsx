// How it works: a 3D model of what happens when you press Run on the Live page (components/SystemModel.tsx). The section
// is pinned while you scroll: the camera starts on the whole system, then visits each part in the order a run flows
// through it, with a caption naming what happens there and the files that do it. Every number is read from
// pipeline.json and headline.json (scripts/export-site-data.py).
import { AnimatePresence, motion, useReducedMotion, useScroll } from 'motion/react';
import { useLite3D } from '../lib/lite3d';
import { Suspense, lazy, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Barrel, Roll } from '../components/Interactive';
import { CountUp } from '../components/Motion';
import { loadHeadline, loadPipeline, useAsync, type Headline, type Pipeline } from '../lib/data';
import { Loading } from './Common';
import type { StepId } from '../components/SystemModel';

const SystemModel = lazy(() => import('../components/SystemModel'));

const REPO = 'https://github.com/mhrj7/TrustBench-AI/tree/main/';
const pretty = (s: string) => s.replaceAll('_', ' ');
const short = (m: string) => m.split(':').slice(1).join(':').split('/').pop() ?? m;

export default function How() {
  const pl = useAsync(loadPipeline, []);
  const h = useAsync(loadHeadline, []);
  if (pl.state !== 'ready') return <Loading state={pl} />;
  if (h.state !== 'ready') return <Loading state={h} />;
  return <HowBody pl={pl.value} h={h.value} />;
}

function stepFacts(id: StepId, pl: Pipeline, h: Headline): ReactNode[] {
  const L = pl.live;
  switch (id) {
    case 'browser': return L.modes.map((m) => <><b>{pretty(m.id)}</b>: {m.label}, up to {m.max_pairs_per_run} pairs a run</>);
    case 'service': return [<><b>{L.systems.length}</b> defenses offered: {L.systems.map(pretty).join(', ')}</>, <>A key you bring is used for that run only, never stored or logged</>];
    case 'queue': return Object.entries(L.workers).map(([lane, n]) => <><b>{lane}</b> lane: {n} worker{n > 1 ? 's' : ''}</>);
    case 'runner': return [<>Starts a tool server and the guard for each arm, then the agent</>, <>The sealed holdout suites are excluded from live runs</>];
    case 'fixtures': return [<><b>{pl.tasks}</b> everyday tasks and <b>{pl.attacks}</b> attacks</>, <><b>{pl.renderings.length}</b> ways to write the trick: {pl.renderings.map(pretty).join(', ')}</>];
    case 'agent': return [<><b>{pl.models.length}</b> models through {pl.providers.join(', ')}</>, ...L.agents.map((a) => <>{a.label}: <b>{a.status}</b></>)];
    case 'arms': return [<>Baseline: the agent's calls go straight to the tools</>, <>Defended: the same calls pass the guard first</>];
    case 'gateway': return [...pl.guard_layers.map((l) => <><b>{l.label}</b>: refuses with <code>{l.denies_with}</code></>), <><b>Flow guard</b>: refuses with <code>untrusted_flow:…</code> when untrusted text steers a call</>];
    case 'tools': return [<><b>{pl.tools.length}</b> tools: {pl.tools.map(pretty).join(', ')}</>];
    case 'score': return [<><b>{pl.oracles}</b> attack oracles say what success for each attacker looks like</>, <>Sealed test: unsafe {h.primary.unsafe.baseline} without the guard, {h.primary.unsafe.defended} with it</>];
    default: return [<><b>{pl.runs.toLocaleString('en')}</b> runs kept in <b>{pl.reports}</b> reports so far</>, <>Every report is hashed, so a changed number would show</>];
  }
}

function HowBody({ pl, h }: { pl: Pipeline; h: Headline }) {
  const reduce = useLite3D();
  const [step, setStep] = useState(-1);
  const counts: [number, string][] = [[pl.tasks, 'everyday tasks'], [pl.attacks, 'hidden tricks'], [pl.renderings.length, 'ways to write a trick'], [pl.models.length, 'models'], [pl.tools.length, 'tools'], [pl.runs, 'runs recorded']];
  const total = Object.values(pl.outcomes).reduce((a, b) => a + b, 0);
  return (
    <>
      <section className="section wrap page-head how-head" aria-labelledby="how-title">
        <div className="grid">
          <h1 id="how-title" className="display span-7 how-title">How it <span className="tail">works.</span></h1>
          <p className="start-8 statement ink-2 how-lede">Press Run on the Live page and a run travels through eleven parts of the system. Scroll to follow it, from the whole system down into each part.</p>
        </div>
        <dl className="how-counts">
          {counts.map(([n, label]) => <div key={label}><dd className="figure"><CountUp to={n} /></dd><dt>{label}</dt></div>)}
        </dl>
      </section>

      {reduce ? <StaticFlow pl={pl} h={h} /> : <FlowSection pl={pl} h={h} step={step} setStep={setStep} />}

      <section className="section wrap" aria-labelledby="layers-title">
        <div className="section-head">
          <p className="eyebrow">Inside stage 4</p>
          <h2 id="layers-title" className="headline">Three gates, <span className="tail">one rule each.</span></h2>
        </div>
        <div className="how-layers">
          {pl.guard_layers.map((l, i) => (
            <Barrel key={l.id} max={16}>
              <article className="how-layer">
                <p className="how-layer-n mono">0{i + 1}</p>
                <h3 className="statement">{l.label}</h3>
                <p className="body ink-2">{l.what}</p>
                <p className="small">Refuses with <code>{l.denies_with}</code> · <a href={REPO + l.source} className="mono">{l.source}</a></p>
              </article>
            </Barrel>
          ))}
        </div>
      </section>

      <section className="section wrap" aria-labelledby="ends-title">
        <Barrel max={14}>
          <div className="chart-card how-ends">
            <h2 id="ends-title" className="headline">How every run <span className="tail">ended.</span></h2>
            <p className="body ink-2">All {total.toLocaleString('en')} recorded runs, by how they finished. A failure is a run that ended without finishing the job; a timeout or an exhausted budget is reported, never dropped.</p>
            <div className="how-bar" role="img" aria-label={Object.entries(pl.outcomes).map(([o, n]) => `${pretty(o)} ${n}`).join(', ')}>
              {Object.entries(pl.outcomes).sort((a, b) => b[1] - a[1]).map(([o, n], i) => (
                <motion.span key={o} className={`how-seg seg-${o}`} style={{ flexGrow: n }} initial={{ scaleX: reduce ? 1 : 0 }} whileInView={{ scaleX: 1 }} viewport={{ once: true }}
                  transition={{ type: 'spring', bounce: 0, duration: 0.9, delay: 0.1 + i * 0.12 }} />
              ))}
            </div>
            <ul className="legend how-legend">{Object.entries(pl.outcomes).sort((a, b) => b[1] - a[1]).map(([o, n]) => <li key={o}><i className={`seg-${o}`} />{pretty(o)} <b className="num">{n.toLocaleString('en')}</b></li>)}</ul>
          </div>
        </Barrel>
      </section>

      <section className="section wrap" aria-labelledby="how-next">
        <div className="cta-x">
          <p className="caps ink-2">Check it yourself</p>
          <h2 id="how-next" className="headline">Open any part <span className="tail">of the machine.</span></h2>
          <div className="row"><Link className="btn btn-primary roll-host" to="/runs"><Roll>Browse every run</Roll></Link><Link className="btn btn-glass roll-host" to="/method"><Roll>The evidence index</Roll></Link></div>
        </div>
      </section>
    </>
  );
}

/** The pinned 3D section: the model fills the screen, the caption follows the camera. */
function FlowSection({ pl, h, step, setStep }: { pl: Pipeline; h: Headline; step: number; setStep: (i: number) => void }) {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const cur = step >= 0 && step < pl.flow.length ? pl.flow[step] : null;
  return (
    <section ref={ref} className="sm" aria-labelledby="sm-title">
      <div className="sm-sticky">
        <Suspense fallback={<div className="sm-canvas" />}><SystemModel pl={pl} progress={scrollYProgress} reduce={false} onStep={setStep} /></Suspense>
        <h2 id="sm-title" className="sr-only">One live run, part by part</h2>
        <div className="sm-copy wrap">
          <AnimatePresence mode="wait">
            <motion.div key={step} className="sm-cap" initial={{ opacity: 0, y: 24, filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -16, filter: 'blur(8px)' }} transition={{ type: 'spring', bounce: 0, duration: 0.55 }}>
              {cur ? (
                <>
                  <p className="caps">Step {step + 1} of {pl.flow.length}</p>
                  <p className="sm-title">{cur.title}</p>
                  <p className="body">{cur.what}</p>
                  <ul className="sm-facts">{stepFacts(cur.id as StepId, pl, h).map((x, i) => <li key={i} className={i > 1 ? 'sm-more' : ''}>{x}</li>)}</ul>
                  <p className="sm-code small">{cur.code.map((c) => <a key={c} href={REPO + c} className="mono">{c}</a>)}</p>
                </>
              ) : (
                <>
                  <p className="caps">The whole system</p>
                  <p className="sm-title">One run, eleven parts.</p>
                  <p className="body">Keep scrolling: the camera flies to each part in the order a live run reaches it.</p>
                </>
              )}
            </motion.div>
          </AnimatePresence>
          <ol className="sm-dots" aria-hidden="true">{pl.flow.map((_, i) => <li key={i} className={i <= step ? 'on' : ''} />)}</ol>
        </div>
      </div>
    </section>
  );
}

/** Reduced motion: the same steps as a list, no flight. */
function StaticFlow({ pl, h }: { pl: Pipeline; h: Headline }) {
  return (
    <section className="section wrap" aria-labelledby="sm-title">
      <h2 id="sm-title" className="headline">One run, <span className="tail">eleven parts.</span></h2>
      <ol className="sm-list">{pl.flow.map((st, i) => (
        <li key={st.id}><p className="caps ink-2">Step {i + 1}</p><p className="statement">{st.title}</p><p className="body ink-2">{st.what}</p>
          <ul className="sm-facts">{stepFacts(st.id as StepId, pl, h).map((x, j) => <li key={j}>{x}</li>)}</ul></li>
      ))}</ol>
    </section>
  );
}

