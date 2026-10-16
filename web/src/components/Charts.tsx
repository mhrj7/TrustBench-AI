import { motion, useReducedMotion } from 'motion/react';
import type { Group, MetricSpec } from '../lib/aggregate';
import { ci, dimLabel, pct, value } from '../lib/format';
import { EASE_OUT } from './Motion';

/** Colour for a rate: ink ramp for good outcomes, signal ramp for attacker success. Interpolated in sRGB between tone-2 and the end colour. */
export function rampColor(rate: number | null, bad: boolean) {
  if (rate === null) return 'var(--tone-2)';
  const a = [0x1e, 0x21, 0x25], b = bad ? [0xff, 0xb2, 0x1f] : [0xed, 0xeb, 0xe6];
  const t = Math.pow(rate, 0.85);
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(',')})`;
}
const textOn = (rate: number | null) => (rate !== null && rate > 0.55 ? 'var(--ground)' : 'var(--ink)');

export function Heatmap({ groups, dims, metric, spec, onSelect }: {
  groups: Group[]; dims: [string, string]; metric: string; spec: MetricSpec; onSelect: (g: Group) => void;
}) {
  const reduce = useReducedMotion();
  const rows = [...new Set(groups.map((g) => String(g.key[dims[0]])))].sort();
  const cols = [...new Set(groups.map((g) => String(g.key[dims[1]])))].sort();
  const at = new Map(groups.map((g) => [`${g.key[dims[0]]}\u0000${g.key[dims[1]]}`, g]));
  const bad = spec.field === 'attacker_goal';
  return (
    <div className="heatmap-scroll" data-lenis-prevent-horizontal>
      <div className="heatmap" role="grid" aria-label={`${spec.label} by ${dimLabel(dims[0])} and ${dimLabel(dims[1])}`}
        style={{ gridTemplateColumns: `minmax(150px, 220px) repeat(${cols.length}, minmax(96px, 1fr))` }}>
        <div role="row" className="heatmap-row-contents">
          <span role="columnheader" className="heatmap-corner small ink-3">{dimLabel(dims[0])} \ {dimLabel(dims[1])}</span>
          {cols.map((c) => <span role="columnheader" key={c} className="heatmap-col small ink-2" title={c}>{value(dims[1], c)}</span>)}
        </div>
        {rows.map((r, ri) => (
          <div role="row" className="heatmap-row-contents" key={r}>
            <span role="rowheader" className="heatmap-rowhead small" title={r}>{value(dims[0], r)}</span>
            {cols.map((c, ci_) => {
              const g = at.get(`${r}\u0000${c}`);
              const m = g?.metrics[metric];
              if (!g || !m || !m.n) return <span role="gridcell" key={c} className="heatmap-empty" aria-label="not run" />;
              return (
                <motion.button role="gridcell" key={c} className="heatmap-cell" onClick={() => onSelect(g)}
                  style={{ background: rampColor(m.rate, bad), color: textOn(m.rate) }}
                  aria-label={`${value(dims[0], r)}, ${value(dims[1], c)}: ${spec.label} ${pct(m.rate)}, ${m.k} of ${m.n} runs. Open the evidence.`}
                  initial={{ opacity: 0, scale: reduce ? 1 : 0.94 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true, margin: '0px 0px -8% 0px' }}
                  transition={{ duration: 0.5, ease: EASE_OUT, delay: Math.min((ri + ci_) * 0.035, 0.45) }}>
                  <span className="heatmap-rate num">{pct(m.rate)}</span>
                  <span className="heatmap-kn num">{m.k}/{m.n}</span>
                </motion.button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Horizontal rate bars with Wilson whiskers; one row per group. The bar grows from its origin; the interval draws after. */
export function RateBars({ groups, dim, metric, spec, onSelect, muted, reference }: {
  groups: Group[]; dim: string; metric: string; spec: MetricSpec; onSelect: (g: Group) => void; muted?: (g: Group) => boolean; reference?: number;
}) {
  const reduce = useReducedMotion();
  const rows = groups.filter((g) => g.metrics[metric].n).sort((a, b) => (b.metrics[metric].rate ?? 0) - (a.metrics[metric].rate ?? 0));
  const bad = spec.field === 'attacker_goal';
  return (
    <ol className="ratebars" aria-label={`${spec.label} by ${dimLabel(dim)}`}>
      {rows.map((g, i) => {
        const m = g.metrics[metric];
        const mute = muted?.(g);
        return (
          <li key={String(g.key[dim])}>
            <button className="ratebar" onClick={() => onSelect(g)} aria-label={`${value(dim, g.key[dim])}: ${pct(m.rate)}, ${m.k} of ${m.n}, interval ${ci(m.ci)}. Open the evidence.`}>
              <span className={`ratebar-label small ${mute ? 'ink-2' : ''}`}>{value(dim, g.key[dim])}{mute ? ' (reference)' : ''}</span>
              <span className="ratebar-track">
                <motion.span className="ratebar-fill" style={{ background: bad ? 'var(--signal)' : mute ? 'var(--ink-3)' : 'var(--ink)', width: `${(m.rate ?? 0) * 100}%` }}
                  initial={{ scaleX: reduce ? 1 : 0, opacity: reduce ? 0 : 1 }} whileInView={{ scaleX: 1, opacity: 1 }} viewport={{ once: true }}
                  transition={{ duration: 0.8, ease: EASE_OUT, delay: Math.min(i * 0.04, 0.45) }} />
                {m.ci && (
                  <motion.span className="ratebar-ci" style={{ left: `${m.ci[0] * 100}%`, width: `${(m.ci[1] - m.ci[0]) * 100}%` }}
                    initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} transition={{ duration: 0.4, delay: 0.5 + Math.min(i * 0.04, 0.45) }} />
                )}
                {reference !== undefined && <span className="ratebar-ref" style={{ left: `${reference * 100}%` }} aria-hidden="true" />}
              </span>
              <span className="ratebar-value num">{pct(m.rate)}<span className="ink-3 kn">{m.k}/{m.n}</span></span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export type Segment = { label: string; count: number; color: string; runIds: string[] };

/** One stacked bar per row; segments draw left to right. */
export function StackBars({ rows, onSelect }: { rows: { label: string; total: number; segments: Segment[] }[]; onSelect: (row: string, s: Segment) => void }) {
  const reduce = useReducedMotion();
  return (
    <ol className="stackbars">
      {rows.map((row, i) => (
        <li key={row.label} className="stackbar-row">
          <span className="ratebar-label small">{row.label}</span>
          <span className="stackbar-track">
            {row.segments.map((s, j) => (
              <motion.button key={s.label} className="stackbar-seg" style={{ width: `${(s.count / row.total) * 100}%`, background: s.color }}
                onClick={() => onSelect(row.label, s)} aria-label={`${row.label}: ${s.label} ${s.count} of ${row.total} runs. Open the evidence.`}
                initial={{ scaleX: reduce ? 1 : 0, opacity: reduce ? 0 : 1 }} whileInView={{ scaleX: 1, opacity: 1 }} viewport={{ once: true }}
                transition={{ duration: 0.6, ease: EASE_OUT, delay: Math.min(i * 0.04 + j * 0.08, 0.6) }} />
            ))}
          </span>
          <span className="ratebar-value num">{row.total.toLocaleString('en')}</span>
        </li>
      ))}
    </ol>
  );
}
