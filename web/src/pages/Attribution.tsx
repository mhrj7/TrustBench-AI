import { motion, useReducedMotion } from 'motion/react';
import { Link } from 'react-router';
import { useDataset } from '../lib/data';
import { pct } from '../lib/format';
import { EASE_OUT, Reveal } from '../components/Motion';
import { Loading, PageHead } from './Common';

export function Attribution() {
  const data = useDataset();
  const reduce = useReducedMotion();
  if (data.state !== 'ready') return <Loading state={data} />;
  const a = data.value.store.attribution;
  const rounds = Object.entries(a.rounds);
  return (
    <>
      <PageHead title="The localizer, audited round by round">
        Each failed run is attributed to the first step where it left its task contract. Every audit round draws fresh cases, so no version is scored on the cases it was fixed against. Reviewer: {a.reviewer}.
      </PageHead>
      <section className="wrap stack-48">
        <div className="att-chart" role="img" aria-label="Audit accuracy by round, with 95% Wilson intervals">
          {rounds.map(([r, v], i) => {
            const s = v.summary.all;
            return (
              <Reveal key={r} i={i} className="att-col">
                <div className="att-col-bar">
                  {s.wilson95 && <motion.span className="att-ci" style={{ bottom: `${s.wilson95[0] * 100}%`, height: `${(s.wilson95[1] - s.wilson95[0]) * 100}%` }}
                    initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} transition={{ duration: 0.5, delay: 0.6 + i * 0.08 }} />}
                  <motion.span className="att-col-fill" style={{ height: `${(s.accuracy ?? 0) * 100}%`, background: Number(r) === a.measured.round ? 'var(--signal)' : 'var(--ink-2)' }}
                    initial={{ scaleY: reduce ? 1 : 0 }} whileInView={{ scaleY: 1 }} viewport={{ once: true }} transition={{ duration: 0.9, ease: EASE_OUT, delay: i * 0.08 }} />
                </div>
                <p className="figure-sm num">{pct(s.accuracy)}</p>
                <p className="small">Round {r} · localizer {v.localizer_version}</p>
                <p className="small ink-2">{s.correct} of {s.judged} checks · {v.cases} cases{v.corrections ? ` · ${v.corrections} labels corrected for consistency` : ''}</p>
                <p className="small ink-3">{v.note}</p>
              </Reveal>
            );
          })}
        </div>
        <div className="grid" style={{ rowGap: 32 }}>
          <Reveal className="span-6 stack-16">
            <h2 className="statement">What the latest round shows</h2>
            <p className="body ink-2">Round {a.measured.round} measured localizer {a.measured.localizer_version} at {a.measured.all.correct} of {a.measured.all.judged} failed checks ({pct(a.measured.all.accuracy)}, 95% Wilson {a.measured.all.wilson95 ? `${pct(a.measured.all.wilson95[0])}–${pct(a.measured.all.wilson95[1])}` : '—'}).</p>
            {a.notes.map((note) => <p key={note} className="body ink-2">{note}</p>)}
          </Reveal>
          <Reveal i={1} className="start-8 stack-16">
            <h2 className="statement">Checked two other ways</h2>
            <p className="body ink-2">{a.constructed.correct} of {a.constructed.cases} constructed trajectories, each with one injected violation at a known step, are localized exactly. Every case and verdict is in <code>docs/attribution-audit.md</code>; failed runs carry their attribution on each <Link to="/runs">run page</Link>.</p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
