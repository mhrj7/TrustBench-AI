import { motion, useReducedMotion } from 'motion/react';
import { useMemo } from 'react';
import type { Span, TraceStep } from '../lib/data';
import { EASE_OUT } from './Motion';

const COLOR: Record<string, string> = { 'agent.run': 'var(--tone-3)', 'model.call': 'var(--ink-2)', 'tool.call': 'var(--ink)', 'policy.decision': 'var(--signal)' };

export function spanLabel(s: Span) {
  const a = s.attributes;
  if (s.name === 'agent.run') return `Run · ${a['run.outcome']}`;
  if (s.name === 'model.call') return `Model · ${a['model.finish_reason'] ?? a['model.role']}`;
  if (s.name === 'tool.call') return `${a['tool.name']}${a['tool.error_code'] ? ` · ${a['tool.error_code']}` : ''}`;
  if (s.name === 'policy.decision') return `Gateway ${a['policy.decision']}${a['policy.reason'] ? ` · ${a['policy.reason']}` : ''}`;
  return s.name;
}

/** Timed waterfall from TB-027 spans: each bar starts at its offset from the run start and draws in time order. */
export function TimedWaterfall({ spans, play = true, speed = 1 }: { spans: Span[]; play?: boolean; speed?: number }) {
  const reduce = useReducedMotion();
  const t0 = useMemo(() => Math.min(...spans.map((s) => s.start_ms)), [spans]);
  const total = useMemo(() => Math.max(...spans.map((s) => s.end_ms)) - t0 || 1, [spans, t0]);
  const ordered = useMemo(() => [...spans].sort((a, b) => a.start_ms - b.start_ms), [spans]);
  return (
    <div className="waterfall" role="img" aria-label={`Trace waterfall: ${ordered.length} spans over ${(total / 1000).toFixed(1)} seconds`}>
      {ordered.map((s, i) => {
        const left = ((s.start_ms - t0) / total) * 100;
        const width = Math.max((s.duration_ms / total) * 100, 0.35);
        const deny = s.name === 'policy.decision' && s.attributes['policy.decision'] === 'deny';
        const fail = s.name === 'tool.call' && s.attributes['tool.status'] === 'failed';
        return (
          <div className="wf-row" key={i}>
            <span className={`wf-label small ${deny || fail ? 'signal' : s.name === 'agent.run' ? 'ink-3' : 'ink-2'}`}>{spanLabel(s)}</span>
            <span className="wf-track">
              <motion.span className="wf-bar" style={{ left: `${left}%`, width: `${width}%`, background: deny || fail ? 'var(--signal)' : COLOR[s.name] }}
                initial={{ scaleX: reduce ? 1 : 0, opacity: reduce ? 0 : 1 }} animate={play ? { scaleX: 1, opacity: 1 } : undefined}
                transition={{ duration: reduce ? 0.3 : Math.max(0.25, Math.min(0.9, (width / 100) * 2.4)) / speed, ease: EASE_OUT,
                              delay: reduce ? 0 : (((s.start_ms - t0) / total) * 2.2) / speed }} />
            </span>
            <span className="wf-ms small ink-3 num">{s.duration_ms >= 1000 ? `${(s.duration_ms / 1000).toFixed(1)} s` : `${Math.round(s.duration_ms)} ms`}</span>
          </div>
        );
      })}
      <div className="wf-axis small ink-3 num" aria-hidden="true"><span>0 s</span><span>{(total / 2000).toFixed(1)} s</span><span>{(total / 1000).toFixed(1)} s</span></div>
    </div>
  );
}

/** Untimed waterfall for runs recorded before TB-027 spans existed: one block per tool call, in order. */
export function StepWaterfall({ steps, marks, isDenial }: { steps: TraceStep[]; marks: Record<number, string[]>; isDenial: (c: string) => boolean }) {
  const reduce = useReducedMotion();
  return (
    <div className="waterfall waterfall-steps" role="img" aria-label={`Step order: ${steps.length} tool calls, untimed`}>
      {steps.map((s, i) => {
        const deny = !!s.error && isDenial(s.error);
        const fail = s.status !== 'succeeded';
        return (
          <div className="wf-row" key={i}>
            <span className={`wf-label small ${deny ? 'signal' : 'ink-2'}`}>{i} · {s.tool}</span>
            <span className="wf-track">
              <motion.span className="wf-bar" style={{ left: `${(i / steps.length) * 100}%`, width: `${100 / steps.length}%`,
                background: deny ? 'var(--signal)' : fail ? 'var(--ink-3)' : 'var(--ink)' }}
                initial={{ scaleX: reduce ? 1 : 0, opacity: reduce ? 0 : 1 }} whileInView={{ scaleX: 1, opacity: 1 }} viewport={{ once: true }}
                transition={{ duration: 0.45, ease: EASE_OUT, delay: reduce ? 0 : i * 0.09 }} />
            </span>
            <span className="wf-ms small num">{s.error ? <span className={deny ? 'signal' : 'ink-2'}>{s.error}</span> : <span className="ink-3">ok</span>}
              {marks[i] && <span className="wf-mark"> · {marks[i].join(', ')}</span>}</span>
          </div>
        );
      })}
    </div>
  );
}
