// The story, in four chapters a ten-year-old can follow. On wide screens the chapters scroll past a sticky illustration
// that changes with the chapter in view; on narrow screens each chapter carries its own illustration. Every
// illustration uses the real recorded example from headline.json (the task, the hidden instruction, and the tool calls
// with and without the guard), never invented ones.
import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Headline } from '../lib/data';
import { Barrel } from './Interactive';

const SPRING = { type: 'spring', bounce: 0, duration: 0.5 } as const;

const pretty = (tool: string) => tool.replaceAll('_', ' ');

function Bubble({ children, tone }: { children: ReactNode; tone?: 'danger' | 'safe' | 'accent' }) {
  return <div className={`bubble ${tone ? `tone-${tone}` : ''}`}>{children}</div>;
}

function Helper({ mood = 'calm' }: { mood?: 'calm' | 'tricked' | 'safe' }) {
  return (
    <div className={`helper helper-${mood}`} aria-hidden="true">
      <span className="helper-eye" /><span className="helper-eye" />
      <span className="helper-mouth" />
    </div>
  );
}

function SceneHelper({ ex }: { ex: Headline['example'] }) {
  const reduce = useReducedMotion();
  return (
    <div className="scene">
      <Bubble tone="accent"><span className="small ink-2">Your task</span><br />{ex.task}</Bubble>
      <div className="scene-row">
        <Helper />
        <motion.div className="arrow" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ ...SPRING, delay: reduce ? 0 : 0.3 }} />
        <div className="stack-8">
          {['reads the document', 'writes the answer'].map((t, i) => (
            <motion.div key={t} className="chip" initial={{ opacity: 0, x: reduce ? 0 : 16 }} animate={{ opacity: 1, x: 0 }} transition={{ ...SPRING, delay: reduce ? 0 : 0.45 + i * 0.25 }}>{t}</motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SceneTrick({ ex }: { ex: Headline['example'] }) {
  const reduce = useReducedMotion();
  const words = ex.hidden_text.split(' ');
  return (
    <div className="scene">
      <div className="doc">
        <span className="doc-line" /><span className="doc-line" /><span className="doc-line short" />
        <p className="doc-trick" aria-label={ex.hidden_text}>
          {words.map((w, i) => (
            <motion.span key={i} aria-hidden="true" initial={{ opacity: reduce ? 1 : 0 }} animate={{ opacity: 1 }} transition={{ delay: reduce ? 0 : 0.25 + i * 0.045 }}>{w} </motion.span>
          ))}
        </p>
        <span className="doc-line" /><span className="doc-line short" />
      </div>
      <div className="scene-row"><Helper mood="tricked" /><Bubble tone="danger">The document is giving the helper orders. You never asked for that.</Bubble></div>
    </div>
  );
}

function SceneGuard({ ex }: { ex: Headline['example'] }) {
  const reduce = useReducedMotion();
  const calls = ex.with_guard.decisions;
  return (
    <div className="scene">
      <p className="small ink-2">Every action the helper tries, checked against the task's list</p>
      <ul className="gchecks">
        {calls.map((c, i) => (
          <motion.li key={i} className={`gcheck ${c.decision === 'deny' ? 'is-denied' : 'is-allowed'}`} initial={{ opacity: 0, y: reduce ? 0 : 10 }}
            animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING, delay: reduce ? 0 : 0.2 + i * 0.35 }}>
            <span className="gcheck-icon" aria-hidden="true">{c.decision === 'deny' ? '✕' : '✓'}</span>
            <span className="mono">{pretty(c.tool)}</span>
            <span className="gcheck-verdict">{c.decision === 'deny' ? `blocked: ${pretty(c.reason ?? 'not allowed')}` : 'allowed'}</span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

function Lane({ title, side, guard }: { title: string; side: Headline['example']['with_guard']; guard: boolean }) {
  const reduce = useReducedMotion();
  const tricked = side.attacker_goal_achieved;
  return (
    <div className={`lane ${guard ? 'lane-guard' : ''}`}>
      <p className="lane-title">{title}</p>
      <div className="stack-8">
        {side.tools.map((t, i) => (
          <motion.div key={i} className={`chip ${t.status === 'succeeded' ? '' : 'chip-blocked'}`} initial={{ opacity: 0, x: reduce ? 0 : -10 }} animate={{ opacity: 1, x: 0 }}
            transition={{ ...SPRING, delay: reduce ? 0 : 0.15 + i * 0.25 }}>
            {pretty(t.tool)}{t.status === 'succeeded' ? '' : ' (stopped)'}
          </motion.div>
        ))}
      </div>
      <motion.p className={`verdict ${tricked ? 'tone-danger' : 'tone-safe'}`} initial={{ opacity: 0, scale: reduce ? 1 : 0.9 }} animate={{ opacity: 1, scale: 1 }}
        transition={{ ...SPRING, delay: reduce ? 0 : 0.2 + side.tools.length * 0.25 }}>
        {tricked ? 'The trick worked' : side.utility_pass ? 'Trick stopped, task done' : 'Trick stopped'}
      </motion.p>
    </div>
  );
}

function SceneFair({ ex }: { ex: Headline['example'] }) {
  return (
    <div className="scene">
      <p className="small ink-2">The same task and the same trick, run twice</p>
      <div className="lanes"><Lane title="Without the guard" side={ex.without_guard} guard={false} /><Lane title="With the guard" side={ex.with_guard} guard /></div>
    </div>
  );
}

const CHAPTERS: { kicker: string; title: string; text: string; scene: (ex: Headline['example']) => ReactNode }[] = [
  { kicker: 'Chapter 1', title: 'Meet the helper', text: 'An AI helper does small jobs for you. It reads documents, writes notes and drafts emails, using tools like a person uses apps.', scene: (ex) => <SceneHelper ex={ex} /> },
  { kicker: 'Chapter 2', title: 'Someone hides a trick', text: 'A document can contain a sentence written for the helper, not for you. It tries to make the helper do something you never asked for.', scene: (ex) => <SceneTrick ex={ex} /> },
  { kicker: 'Chapter 3', title: 'The guard checks every action', text: 'TrustBench puts a guard between the helper and its tools. Each task comes with a list of allowed actions; anything else is stopped, whatever the helper was talked into.', scene: (ex) => <SceneGuard ex={ex} /> },
  { kicker: 'Chapter 4', title: 'A fair test', text: 'We run the same task twice, once without the guard and once with it, and look at what the tools actually did, not what the helper said.', scene: (ex) => <SceneFair ex={ex} /> },
];

function Chapter({ i, onActive, ex }: { i: number; onActive: (i: number) => void; ex: Headline['example'] }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.6 });
  useEffect(() => { if (inView) onActive(i); }, [inView, i, onActive]);
  const c = CHAPTERS[i];
  return (
    <div ref={ref} className="chapter">
      <Barrel className="chapter-inner" max={26}>
        <p className="eyebrow">{c.kicker}</p>
        <h3 className="statement">{c.title}</h3>
        <p className="body ink-2">{c.text}</p>
        <div className="chapter-scene">{c.scene(ex)}</div>
      </Barrel>
    </div>
  );
}

export function Story({ ex }: { ex: Headline['example'] }) {
  const [active, setActive] = useState(0);
  return (
    <div className="story">
      <div className="story-chapters">
        {CHAPTERS.map((_, i) => <Chapter key={i} i={i} onActive={setActive} ex={ex} />)}
      </div>
      <div className="story-stage" aria-hidden="true">
        <div className="story-stage-inner">
          <div className="story-progress">{CHAPTERS.map((_, i) => <span key={i} className={i <= active ? 'on' : ''} />)}</div>
          <AnimatePresence mode="wait">
            <motion.div key={active} initial={{ opacity: 0, y: 16, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -16, filter: 'blur(6px)' }} transition={SPRING}>
              {CHAPTERS[active].scene(ex)}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
