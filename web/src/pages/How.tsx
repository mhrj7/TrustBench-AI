// How it works: the whole pipeline as one machine (Fig 1, components/Anatomy.tsx), with the eight stages beside it. As a
// stage card scrolls into the middle of the screen, its part of the bench lights up. Every number is read from
// pipeline.json and headline.json (scripts/export-site-data.py); every stage names the files that implement it.
import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import '../iso/iso.css';
import { Anatomy } from '../components/Anatomy';
import { Barrel, Roll } from '../components/Interactive';
import { CountUp } from '../components/Motion';
import { loadHeadline, loadPipeline, useAsync, type Headline, type Pipeline } from '../lib/data';
import { Loading } from './Common';

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

function stageText(id: string, pl: Pipeline, h: Headline): { lead: string; facts: ReactNode[] } {
  const ex = h.example;
  switch (id) {
    case 'tasks': return { lead: 'Every test starts as two piles of cards: ordinary jobs a helper should finish, and documents with a trick hidden inside.',
      facts: [<><b>{pl.tasks}</b> everyday tasks, each with a contract of what the job allows</>, <><b>{pl.attacks}</b> attacks, each with an oracle that says what success for the attacker looks like ({pl.oracles} oracles)</>, <><b>{pl.case_groups}</b> case groups split once, with <b>{Object.values(pl.holdouts).reduce((a, b) => a + b, 0)}</b> cases sealed away in {Object.keys(pl.holdouts).length} holdout suites</>] };
    case 'render': return { lead: 'The same trick can be written in different voices. The drum stamps one of them onto the document before the helper reads it.',
      facts: [<><b>{pl.renderings.length}</b> renderings, from the attack as written to published templates</>, <>{pl.renderings.map(pretty).join(', ')}</>] };
    case 'agent': return { lead: 'The helper is a real language model. It reads the task and the document and decides which tools to call. It never sees the guard\'s rules.',
      facts: [<><b>{pl.models.length}</b> models through <b>{pl.providers.length}</b> free providers ({pl.providers.join(', ')})</>, <>{pl.models.map(short).join(', ')}</>, <>Example task: “{ex.task}”</>] };
    case 'guard': return { lead: 'Every tool call passes three gates before it can do anything. A call that fails one is refused, whatever the helper was talked into.',
      facts: pl.guard_layers.map((l) => <><b>{l.label}</b>: refuses with <code>{l.denies_with}</code></>) };
    case 'tools': return { lead: 'Calls that pass reach real tools: a small document store, contacts, customer records, notes and email drafts, all on a test server.',
      facts: [<><b>{pl.tools.length}</b> tools: {pl.tools.map(pretty).join(', ')}</>] };
    case 'score': return { lead: 'The scorer reads what the tools actually did, not what the helper said, and gives three verdicts.',
      facts: [<>Did the job get done (<b>utility</b>)? Did anything unsafe happen (<b>security</b>)? Did the attacker get what they wanted (<b>attacker goal</b>)?</>,
        <>This run: utility {ex.with_guard.utility_pass ? 'pass' : 'fail'}, security {ex.with_guard.security_pass ? 'pass' : 'fail'}, attacker goal {ex.with_guard.attacker_goal_achieved ? 'reached' : 'not reached'}</>] };
    case 'store': return { lead: 'Every run is filed: its tool trace, the gate decisions and the verdicts, in a report with a hash, so nothing can change quietly.',
      facts: [<><b>{pl.runs.toLocaleString('en')}</b> runs in <b>{pl.reports}</b> reports ({pl.valid_runs.toLocaleString('en')} valid)</>, <><b>{pl.systems.length}</b> systems compared, the guard among them</>] };
    default: return { lead: 'The same tasks run with and without the guard, and the pairs are compared. The sealed test was opened once, at the end.',
      facts: [<>Unsafe actions in tricked tasks: <b>{h.primary.unsafe.baseline}</b> without the guard, <b>{h.primary.unsafe.defended}</b> with it</>, <>Normal tasks still done: <b>{h.primary.utility.baseline}</b> → <b>{h.primary.utility.defended}</b></>, <>{h.primary.pairs} paired tasks, verdict: {h.primary.verdict}</>] };
  }
}

function HowBody({ pl, h }: { pl: Pipeline; h: Headline }) {
  const reduce = !!useReducedMotion();
  const [active, setActive] = useState(0);
  const cards = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
    }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
    cards.current.forEach((c) => c && io.observe(c));
    return () => io.disconnect();
  }, []);
  const go = useCallback((i: number) => { setActive(i); cards.current[i]?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' }); }, [reduce]);
  const counts: [number, string][] = [[pl.tasks, 'everyday tasks'], [pl.attacks, 'hidden tricks'], [pl.renderings.length, 'ways to write a trick'], [pl.models.length, 'models'], [pl.tools.length, 'tools'], [pl.runs, 'runs recorded']];
  const total = Object.values(pl.outcomes).reduce((a, b) => a + b, 0);
  return (
    <>
      <section className="section wrap page-head how-head" aria-labelledby="how-title">
        <div className="grid">
          <h1 id="how-title" className="display span-7 how-title">How it <span className="tail">works.</span></h1>
          <p className="start-8 statement ink-2 how-lede">The whole pipeline is one machine on a bench. Follow a single tool call from the card it started on to the dial that reports the result.</p>
        </div>
        <dl className="how-counts">
          {counts.map(([n, label]) => <div key={label}><dd className="figure"><CountUp to={n} /></dd><dt>{label}</dt></div>)}
        </dl>
      </section>

      <section className="section wrap how-anatomy" aria-label="The pipeline, stage by stage">
        <div className="how-figure"><Anatomy pl={pl} h={h} active={active} onStage={go} /></div>
        <ol className="how-stages">
          {pl.stages.map((st, i) => {
            const t = stageText(st.id, pl, h);
            return (
              <li key={st.id} ref={(el) => { cards.current[i] = el; }} data-i={i} className={`how-stage ${i === active ? 'is-on' : ''}`} onClick={() => go(i)}>
                <Barrel max={14}>
                  <p className="caps ink-2">Stage {i + 1}</p>
                  <h2 className="how-stage-title">{st.title}</h2>
                  <p className="body">{t.lead}</p>
                  <ul className="how-facts">{t.facts.map((f, j) => <li key={j}>{f}</li>)}</ul>
                  <p className="how-code small">{st.code.map((c) => <a key={c} href={REPO + c} className="mono">{c}</a>)}</p>
                </Barrel>
              </li>
            );
          })}
        </ol>
      </section>

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
