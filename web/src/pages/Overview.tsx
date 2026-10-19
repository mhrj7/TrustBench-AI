import { AnimatePresence, LayoutGroup, motion, useMotionValueEvent, useReducedMotion, useScroll, useTransform, type MotionValue } from 'motion/react';
import { Suspense, lazy, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { aggregate, type Group, type Run } from '../lib/aggregate';
import { loadHeadline, loadSpans, runPath, useAsync, useDataset, type Dataset, type Headline } from '../lib/data';
import { Bento, Card, Eyebrow } from '../components/Bento';
import { Story } from '../components/Story';
import { pct, short } from '../lib/format';
import { ASTRONAUT_CREDIT, ASTRONAUT_URL, EARTH_URL, IMAC_URL, IPAD_URL, JOURNEY_CREDITS, JOURNEY_READY } from '../lib/models';
import { T } from '../lib/journey';
import { CountUp, Reveal } from '../components/Motion';
import { Barrel, GrowCard, Ribbon, Roll } from '../components/Interactive';
import type { HeroScore } from '../components/PhysicsHero';
import { RateBars } from '../components/Charts';
import { useEvidence } from '../components/Shell';
import { TimedWaterfall } from '../components/Waterfall';
import { Loading } from './Common';

// The hero's 3D code is the heaviest download on the page: start fetching it as soon as the app boots on the home page,
// instead of waiting for the hero to render.
const loadHero = () => import('../components/PhysicsHero');
const heroEarly = typeof window !== 'undefined' && window.location.pathname === '/' ? loadHero() : null;
const PhysicsHero = lazy(() => heroEarly ?? loadHero());
const Journey = lazy(() => import('../components/Journey'));
const StickerSpace = lazy(() => import('../components/StickerSpace'));
const JOURNEY_MODELS = JOURNEY_READY ? { astronaut: ASTRONAUT_URL!, ipad: IPAD_URL!, imac: IMAC_URL!, earth: EARTH_URL! } : null;
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
  const [score, setScore] = useState<HeroScore>({ stopped: 0, total: 0 });
  const touch = typeof window !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  return (
    <>
      <section className="hx wrap" aria-labelledby="hero-title">
        <div className="hx-top">
          <motion.h1 id="hero-title" className="display hx-title" initial={{ opacity: 0, y: reduce ? 0 : 24 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            Can a guard stop a <span className="accent-word">tricked</span> AI?
          </motion.h1>
          <motion.div className="hx-side" initial={{ opacity: 0, y: reduce ? 0 : 16 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING, delay: 0.12 }}>
            <p className="body ink-2">AI helpers read documents and then act. If a document hides an instruction, the helper might obey it. TrustBench measures whether a guard stops that, without stopping the real work.</p>
            <div className="row">
              <a className="btn btn-primary roll-host" href="#story"><Roll>See how it works</Roll></a>
              <Link className="btn btn-glass roll-host" to="/live"><Roll>Run a live test</Roll></Link>
            </div>
          </motion.div>
        </div>
        <motion.div className="stage" initial={{ opacity: 0, scale: reduce ? 1 : 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...SPRING, duration: 0.9, delay: 0.1 }}>
          <Suspense fallback={<div className="stage-canvas" aria-hidden="true" />}><PhysicsHero reduce={reduce} onScore={setScore} /></Suspense>
          <p className="stage-tag"><span className="dot-red" />Red pieces are hidden tricks</p>
          <p className="stage-hint">{reduce ? 'Motion is reduced: the pile stands still.' : touch ? 'Drag across the pile. Your finger is the guard.' : 'Move your cursor through the pile. You are the guard.'}</p>
          <p className="stage-score" aria-live="polite"><span className="num">{score.stopped}</span> of {score.total} tricks stopped</p>
        </motion.div>
        <div className="crossrow" aria-hidden="true"><span>+</span><span>+</span><span className="crossrow-label">Scroll to explore</span><span>+</span><span>+</span></div>
      </section>

      <section className="sx wrap" aria-labelledby="sx-title">
        <Ribbon />
        <h2 id="sx-title" className="headline sx-title">Tricks hide. <span className="tail">Guards check.</span></h2>
        <div className="sx-side">
          <p className="body ink-2">A helper gets a job and a document. Hidden in the document is a sentence written for the helper, not for you. TrustBench runs the same job twice, with and without a guard that checks every action, and counts what the tools really did.</p>
          {h.state === 'ready' && (
            <dl className="sx-stats">
              <div><dt>runs recorded</dt><dd><CountUp to={runs.length} /></dd></div>
              <div><dt>sealed-test runs</dt><dd><CountUp to={h.value.confirmatory_runs} /></dd></div>
              <div><dt>offline steps rebuild every number</dt><dd><CountUp to={h.value.reproduction.steps} /></dd></div>
            </dl>
          )}
          <a className="btn btn-glass roll-host" href="#story"><span className="btn-dot" /><Roll>How it works</Roll></a>
        </div>
      </section>

      <section id="story" className="section wrap" aria-labelledby="story-title">
        <div className="section-head">
          <Eyebrow>The story</Eyebrow>
          <h2 id="story-title" className="headline">The trick, <span className="tail">and the guard.</span></h2>
        </div>
        {h.state === 'ready' ? <Story ex={h.value.example} /> : <Loading state={h} />}
      </section>

      {h.state === 'ready' && (
        <GrowCard left="FLIP" right="GUARD" label="Flip the guard">{() => <ReelCover h={h.value} />}</GrowCard>
      )}

      {h.state === 'ready' && <section id="sim" className="section wrap" aria-label="Flip the guard"><div className="sim-card"><Simulator h={h.value} /></div></section>}

      {h.state === 'ready' && <Results h={h.value} />}

      <section className="section wrap" aria-labelledby="work-title">
        <div className="work-head">
          <h2 id="work-title" className="headline">The evidence</h2>
          <p className="caps ink-2">Every number on this site opens the runs behind it, and every run opens its raw record.</p>
        </div>
        <div className="works">
          <Work to={null} tags={['A real run', short(hero?.model ?? ''), hero?.system ?? '']} title="Replay a recorded run">
            {hero ? <HeroTrace run={hero} /> : <p className="body ink-2">No timed run in the store.</p>}
          </Work>
          {h.state === 'ready' && (
            <Work to="/compare" tags={['Defenses', 'Models', 'Heatmap']} title="Compare defenses">
              <MiniRace h={h.value} />
            </Work>
          )}
          <Work to="/runs" tags={['Store', `${new Set(runs.map((r) => r.model)).size} models`, 'Raw records']} title="Every run">
            <div className="mini-count"><p className="figure"><CountUp to={valid.length} /></p><p className="small ink-2">valid runs, each with its tool trace and the evaluator's verdict</p></div>
          </Work>
          {h.state === 'ready' && (
            <Work to="/policy" tags={['Gateway', 'Decisions', 'Reasons']} title="Why calls were stopped">
              <ul className="mini-calls">{h.value.example.with_guard.decisions.map((c, i) => <li key={i} className={c.decision === 'deny' ? 'is-deny' : ''}><span className="mono">{c.tool.replaceAll('_', ' ')}</span><span className="small">{c.decision === 'deny' ? `stopped: ${(c.reason ?? '').replaceAll('_', ' ')}` : 'allowed'}</span></li>)}</ul>
            </Work>
          )}
          <Work to="/attribution" tags={['Localizer', 'AI audit', 'Rounds']} title="The audit, round by round">
            <MiniRounds d={d} />
          </Work>
          <Work to="/live" tags={['Your browser', 'No model', 'Free tier', 'Your key']} title="Run it live">
            <div className="mini-term mono"><p><span className="ink-3">$</span> trustbench live --case doc-attack</p><p className="danger">baseline: attacker goal reached</p><p className="safe">guarded: call denied, task done</p></div>
          </Work>
        </div>
      </section>

      <PairedMorph d={d} />

      <UtilityCost d={d} fp={fp} />

      {h.state === 'ready' && JOURNEY_MODELS && <JourneySection h={h.value} runs={runs.length} />}

      <SpaceCta />
    </>
  );
}

/** The ending: a dark sky of floating stickers around the call to action; the pointer flicks them away. */
function SpaceCta() {
  const ref = useRef<HTMLElement>(null);
  const reduce = !!useReducedMotion();
  return (
    <section ref={ref} className="space" aria-labelledby="cta-title">
      <Suspense fallback={null}><StickerSpace reduce={reduce} source={ref} modelUrl={ASTRONAUT_URL} /></Suspense>
      <div className="space-copy wrap">
        <p className="caps">Think you can beat it?</p>
        <h2 id="cta-title" className="headline">Try to trick it <span className="tail">yourself.</span></h2>
        <p className="body">Run the same comparison in your browser: instantly with no model, live on our free-tier key, or with your own key.</p>
        <div className="row"><Link className="btn btn-light roll-host" to="/live"><span className="btn-dot" /><Roll>Run it live</Roll></Link><Link className="btn btn-ghost roll-host" to="/method"><Roll>How to check a number</Roll></Link></div>
        {ASTRONAUT_URL && <p className="space-credit small">Astronaut: <a href={ASTRONAUT_CREDIT.url}>{ASTRONAUT_CREDIT.title}</a> by {ASTRONAUT_CREDIT.author}, {ASTRONAUT_CREDIT.license}.</p>}
      </div>
    </section>
  );
}

/** The journey (components/Journey.tsx), after the reference site's tunnel sequence: a tablet beside the intro shows the
 *  astronaut above the Earth; the view dives into its screen, a headline zooms past as the astronaut turns and drifts in,
 *  and the camera follows it in free fall down a twisting lattice, through crystals into a blue corridor, then pulls back
 *  out of a desktop screen as the astronaut breaks the glass and drops into the ending below. Captions on the way are from
 *  the evidence. */
function JourneySection({ h, runs }: { h: Headline; runs: number }) {
  const ref = useRef<HTMLElement>(null);
  const reduce = !!useReducedMotion();
  const { scrollYProgress: p } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const [active, setActive] = useState(-1);
  const g = T.grid[0], span = T.grid[1] - T.grid[0];
  const stops = [
    { at: g + 0.02, kicker: 'Lane 1 · development', title: `${runs.toLocaleString('en')} runs`, tail: 'recorded.', text: 'Every run kept with its tool trace and the scorer\'s verdict.' },
    { at: g + span * 0.36, kicker: 'Lane 2 · the sealed test', title: `${h.primary.pairs} paired tasks,`, tail: 'opened once.', text: 'Locked away before the guard was finished, then run a single time.' },
    { at: g + span * 0.68, kicker: 'Lane 3 · checked twice', title: `${h.audit.sampled} runs`, tail: 're-labelled blind.', text: `Two AI reviewers re-scored them: ${h.audit.security_errors} safety-label errors, ${h.audit.oracle_defects} rule mistake found and fixed.` },
    { at: T.corridor[0], kicker: 'The way out · rebuilt', title: `${h.reproduction.steps} offline steps`, tail: 'rebuild every number.', text: `In a clean container: ${h.reproduction.outcome.toLowerCase()}.` },
  ];
  useMotionValueEvent(p, 'change', (v) => {
    let a = -1;
    stops.forEach((st, i) => { if (v >= st.at && v < (stops[i + 1]?.at ?? T.pull[0]) - 0.012) a = i; });
    setActive(a);
  });
  const intro = useTransform(p, [0, 0.07], [1, 0]);
  const introVis = useTransform(p, (v) => (v > 0.075 ? 'hidden' : 'visible'));
  const introY = useTransform(p, [0, 0.1], ['0px', '-80px']);
  const dark = useTransform(p, [T.zoom[1] - 0.05, T.zoom[1]], [0, 1]);
  // The model credits show while no caption does: on the opening view and on the desktop screen at the end.
  const credit = useTransform(p, [T.zoom[1] - 0.05, T.zoom[1], T.turn[0] - 0.02, T.turn[0], T.pull[0], T.pull[1]], [0, 1, 1, 0, 0, 1]);
  const [w0, w1, w2, w3] = T.words;
  const words = useTransform(p, [w0, w1, w2 + (w3 - w2) * 0.6, w3], [0, 1, 1, 0]);
  const wordsY = useTransform(p, [w0, w1], ['40px', '0px']);
  const zoom = useTransform(p, [w2, w3], [1, 4.2]);
  const spread = useTransform(p, [w2, w3], [0, 1]);
  if (reduce) {
    return (
      <section className="section wrap journey-static" aria-labelledby="journey-title">
        <h2 id="journey-title" className="headline">Every claim <span className="tail">meets a test.</span></h2>
        <ol className="journey-list">{stops.map((st, i) => <li key={i}><p className="caps ink-2">{st.kicker}</p><p className="statement">{st.title} {st.tail}</p><p className="body ink-2">{st.text}</p></li>)}</ol>
      </section>
    );
  }
  const LINES = [['STEP', 'INSIDE', 'THE', 'TEST'], ['AND', 'WATCH', 'WHAT'], ['THE', 'GUARD', 'STOPS']];
  const cur = active >= 0 ? stops[active] : null;
  return (
    <section ref={ref} className="journey" aria-labelledby="journey-title">
      <div className="journey-sticky">
        <motion.div className="journey-dark" style={{ opacity: dark }} />
        <Suspense fallback={<div className="journey-canvas" />}><Journey progress={p} reduce={reduce} models={JOURNEY_MODELS!} /></Suspense>
        <motion.div className="journey-intro wrap" style={{ opacity: intro, y: introY, visibility: introVis }}>
          <h2 id="journey-title" className="headline">Every claim <span className="tail">meets a test.</span></h2>
          <p className="body ink-2">A benchmark is only worth what you can check. So the helper goes through every stage the project ran: the development runs, the sealed test, the second look by two reviewers, and a rebuild from scratch. Scroll to send it in.</p>
        </motion.div>
        <motion.div className="journey-words" aria-hidden="true" style={{ opacity: words, y: wordsY, scale: zoom }}>
          {LINES.map((line, li) => (
            <div key={li} className="journey-line">
              {line.map((w, wi) => <SpreadWord key={wi} word={w} offset={(wi - (line.length - 1) / 2) * 1} spread={spread} />)}
            </div>
          ))}
        </motion.div>
        <div className="journey-copy">
          <AnimatePresence mode="wait">
            {cur && (
              <motion.div key={active} className="journey-cap" initial={{ opacity: 0, y: 24, filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -24, filter: 'blur(10px)' }} transition={{ type: 'spring', bounce: 0, duration: 0.6 }}>
                <p className="caps">{cur.kicker}</p>
                <p className="headline">{cur.title} <span className="tail">{cur.tail}</span></p>
                <p className="body">{cur.text}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <motion.p className="journey-credit small" style={{ opacity: credit }}>
          3D models, CC BY 4.0: {JOURNEY_CREDITS.map((c, i) => <span key={c.url}>{i ? ', ' : ''}<a href={c.url}>{c.title}</a> by {c.author}</span>)}.
        </motion.p>
      </div>
    </section>
  );
}

/** One word of the headline; words move apart from the centre and blur as the line zooms past the camera. */
function SpreadWord({ word, offset, spread }: { word: string; offset: number; spread: MotionValue<number> }) {
  const x = useTransform(spread, [0, 1], ['0em', `${offset * 1.6}em`]);
  const blur = useTransform(spread, [0.55, 1], ['blur(0px)', 'blur(4px)']);
  return <motion.span style={{ x, filter: blur }}>{word}</motion.span>;
}

/** One evidence card: a live picture on a stage, the tags, and a title that rolls on hover. */
function Work({ to, tags, title, children }: { to: string | null; tags: string[]; title: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const body = (
    <>
      <div className="work-media">{children}</div>
      <p className="work-tags">{tags.filter(Boolean).join(' • ')}</p>
      <h3 className="work-title"><Roll>{title}</Roll></h3>
    </>
  );
  return (
    <Barrel className="work-wrap">
      <motion.article className="work roll-host" initial={{ opacity: 0, y: reduce ? 0 : 40 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '0px 0px -10% 0px' }}
        transition={{ type: 'spring', bounce: 0, duration: 0.7 }}>
        {to ? <Link to={to} className="work-link">{body}</Link> : body}
      </motion.article>
    </Barrel>
  );
}

function MiniRace({ h }: { h: Headline }) {
  const sorted = [...h.comparison.systems].sort((a, b) => a.defended.rate - b.defended.rate);
  return (
    <ul className="race race-mini">
      {sorted.map((s, i) => (
        <li key={s.id} className={i === 0 ? 'is-ours' : ''}>
          <span className="small">{s.label}</span>
          <span className="race-track"><motion.span className="race-fill" style={{ width: `${Math.max(s.defended.rate, 0.02) * 100}%` }} initial={{ scaleX: 0 }} whileInView={{ scaleX: 1 }}
            viewport={{ once: true }} transition={{ type: 'spring', bounce: 0, duration: 0.9, delay: 0.1 + i * 0.08 }} /></span>
          <span className="num small">{s.defended.numerator}</span>
        </li>
      ))}
    </ul>
  );
}

function MiniRounds({ d }: { d: Dataset }) {
  const a = d.store.attribution;
  return (
    <ol className="mini-rounds" aria-label="Audit accuracy by round">
      {Object.entries(a.rounds).map(([r, v], i) => (
        <li key={r}>
          <motion.span className={Number(r) === a.measured.round ? 'is-measured' : ''} style={{ height: `${(v.summary.all.accuracy ?? 0) * 100}%` }}
            initial={{ scaleY: 0 }} whileInView={{ scaleY: 1 }} viewport={{ once: true }} transition={{ type: 'spring', bounce: 0, duration: 0.9, delay: i * 0.08 }} />
          <span className="small num">{pct(v.summary.all.accuracy)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The cover of the growing card: tilted rows of the recorded run's real tool calls and guard decisions drifting past. */
function ReelCover({ h }: { h: Headline }) {
  const reduce = useReducedMotion();
  const ex = h.example;
  const items = [
    ...ex.without_guard.tools.map((t) => ({ text: t.tool.replaceAll('_', ' '), tone: '' })),
    ...ex.with_guard.decisions.map((c) => ({ text: `${c.tool.replaceAll('_', ' ')}: ${c.decision === 'deny' ? 'stopped' : 'allowed'}`, tone: c.decision === 'deny' ? 'is-safe' : '' })),
    { text: 'hidden instruction', tone: 'is-danger' },
    { text: ex.without_guard.attacker_goal_achieved ? 'without the guard: tricked' : 'without the guard: safe', tone: 'is-danger' },
    { text: ex.with_guard.utility_pass ? 'with the guard: task done' : 'with the guard: stopped', tone: 'is-safe' },
  ];
  return (
    <div className="reel">
      <div className="reel-rows" aria-hidden="true">
        {Array.from({ length: 6 }, (_, r) => (
          <motion.div key={r} className="reel-row" animate={reduce ? undefined : { x: r % 2 ? ['-50%', '0%'] : ['0%', '-50%'] }}
            transition={{ duration: 38 + r * 6, ease: 'linear', repeat: Infinity }}>
            {[...items, ...items, ...items, ...items].map((it, i) => <span key={i} className={`reel-chip ${it.tone}`}>{it.text}</span>)}
          </motion.div>
        ))}
      </div>
      <a className="reel-play roll-host" href="#sim"><span className="reel-play-icon" aria-hidden="true">▶</span><Roll>Flip it yourself</Roll></a>
    </div>
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
    <div className="sim">
      <div className="sim-top">
        <div className="stack-8">
          <h2 className="headline sim-title">You flip <span className="tail">the guard.</span></h2>
          <p className="small sim-note">A real pair of recorded runs ({h.example.case_id}, repetition {h.example.repetition}): the same task and the same trick, replayed from what the tools actually did.</p>
        </div>
        <div className="row">
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
      </div>
      <div className="sim-grid">
        <div className="sim-doc">
          <p className="small sim-k">The task</p>
          <p className="body">{h.example.task}</p>
          <p className="small sim-k" style={{ marginTop: 16 }}>Hidden in the document</p>
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
    </div>
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
        <h2 id="found-title" className="headline">{h.primary.verdict === 'supported' ? <>Fewer tricks <span className="tail">got through.</span></> : 'No clear difference.'}</h2>
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
        <div className="grid chart-card" style={{ rowGap: 32 }}>
          <div className="span-6 stack-24">
            <h2 id="morph-title" className="headline">{morphHeadline(rows)}</h2>
            <p className="body ink-2">Attacker goal reached on attack cases for {short(model)}, the model every defense was run on. Each defense is compared with the baseline arm of its own reports, on the same cases. These are development runs and point estimates, not a confirmatory result (that is in the technical report). Scroll to move each bar from its baseline to its defended rate.</p>
            <MorphLegend t={t} reduce={!!reduce} />
          </div>
          <ol className="span-6 morph-bars" aria-label="Attacker goal rate, baseline and defended">
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
    <section className="section wrap clip-x" aria-labelledby="cost-title">
      <Barrel max={18}>
      <div className="grid chart-card" style={{ rowGap: 48 }}>
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
      </Barrel>
    </section>
  );
}
