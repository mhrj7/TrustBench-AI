// The live test bench (Fig 1 on the How it works page). Static art comes from iso/bench.ts; this component moves the
// parts. One tour loops: each tool call of the real recorded guarded run leaves the reader head as a puck, rides the belt
// to the guard's gates, and either drops into its tool socket or, at the gate whose layer refused it, the blade drops and
// the puck is flipped into the reject tray. Then the scorer's gauges read that run's verdicts and the big dial shows the
// sealed-test unsafe rate (baseline ghost needle, defended needle). Hovering the bench takes it apart into its stages.
// Everything shown is read from pipeline.json and headline.json. Stops off screen; still under reduced motion.
import { useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef } from 'react';
import type { Headline, Pipeline } from '../lib/data';
import * as B from '../iso/bench';

const pretty = (s: string) => s.replaceAll('_', ' ');
const SPEED = 90;      // belt speed, units per second
const LIFT = [26, 34, 58, 44, 30, 36, 40, 28]; // how far each stage rises when the bench comes apart

type Leg = { t0: number; t1: number; from: [number, number, number]; to: [number, number, number] };
type Puck = { tool: string; blocked: number; reason: string | null; legs: Leg[]; born: number; done: number };

function layerOf(reason: string | null, layers: Pipeline['guard_layers']) {
  if (!reason) return -1;
  const direct = layers.findIndex((l) => l.denies_with === reason);
  if (direct >= 0) return direct;
  if (reason === 'resource_denied') return layers.findIndex((l) => l.id === 'contract_scope');
  return layers.length - 1;   // flow-guard and approval refusals stop at the last gate
}

function schedule(h: Headline, pl: Pipeline): { pucks: Puck[]; total: number } {
  const side = h.example.with_guard;
  const pucks: Puck[] = [];
  let t = 0.6, trayN = 0;
  side.decisions.forEach((d, i) => {
    const blocked = d.decision === 'deny' ? Math.max(0, layerOf(d.reason, pl.guard_layers)) : -1;
    const legs: Leg[] = [];
    const push = (from: [number, number, number], to: [number, number, number], dur: number) => { legs.push({ t0: t, t1: t + dur, from, to }); t += dur; };
    const start: [number, number, number] = [B.AGENT_X, 0, 34];
    push(start, [B.AGENT_X, 0, 0], 0.45);
    if (blocked >= 0) {
      const gx = B.GATES[blocked] - 10;
      push([B.AGENT_X, 0, 0], [gx, 0, 0], (gx - B.AGENT_X) / SPEED);
      t += 0.45;                                                       // the blade drops
      const ty = B.TRAY.y + B.TRAY.d / 2 - 6 + (trayN % 2) * 10, tx = B.TRAY.x + 14 + trayN * 12;
      push([gx, 0, 0], [tx, ty, -4], 0.7);
      trayN++;
    } else {
      push([B.AGENT_X, 0, 0], [B.BELT.to - 6, 0, 0], (B.BELT.to - 6 - B.AGENT_X) / SPEED);
      const k = Math.max(0, pl.tools.indexOf(d.tool));
      const [sx, sy] = B.rackSockets(pl.tools.length)[k];
      push([B.BELT.to - 6, 0, 0], [sx, sy, 7 + 4], 0.8);
    }
    pucks.push({ tool: d.tool, blocked, reason: d.reason, legs, born: legs[0].t0, done: t });
    t += 0.35 + i * 0;
  });
  return { pucks, total: t + 3.6 };
}

const ease = (x: number) => x * x * (3 - 2 * x);

export function Anatomy({ pl, h, active, onStage }: { pl: Pipeline; h: Headline; active: number; onStage?: (i: number) => void }) {
  const reduce = !!useReducedMotion();
  const host = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const art = useMemo(() => B.buildBench({ renderings: pl.renderings.length, providers: pl.providers.length, models: pl.models.length, tools: pl.tools.length, drawers: 6 }), [pl]);
  const plan = useMemo(() => schedule(h, pl), [h, pl]);
  const puckArt = useMemo(() => ({ ok: B.puckSvg('hi'), bad: B.puckSvg('hi') }), []);
  const side = h.example.with_guard;
  const verdicts = [side.utility_pass, side.security_pass, !side.attacker_goal_achieved];
  const unsafe = h.primary.unsafe;

  useEffect(() => {
    const svg = svgRef.current, el = host.current;
    if (!svg || !el) return;
    const q = <T extends Element>(s: string) => [...svg.querySelectorAll<T>(s)];
    const stages = q<SVGGElement>('[data-stage]');
    const pucks = q<SVGGElement>('[data-puck]');
    const blades = q<SVGGElement>('[data-blade]');
    const sockets = q<SVGPathElement>('[data-socket]');
    const gauges = q<SVGPathElement>('[data-gauge]');
    const dialNeedle = svg.querySelector<SVGPathElement>('[data-dial]');
    let apart = 0, want = 0, t = 0, last = 0, frame = 0, visible = false;
    const shares = gauges.map(() => 0.5);
    const set = (text: string) => { if (readout.current && readout.current.textContent !== text) readout.current.textContent = text; };
    const draw = () => {
      const on = activeRef.current;
      stages.forEach((g, i) => {
        g.setAttribute('transform', B.along(0, 0, apart * LIFT[Number(g.dataset.index)]));
        if (Number(g.dataset.index) === on) g.setAttribute('data-on', ''); else g.removeAttribute('data-on');
      });
      let text = 'Waiting for the next tool call';
      plan.pucks.forEach((p, i) => {
        const g = pucks[i];
        if (!g) return;
        if (t < p.born) { g.style.opacity = '0'; return; }
        g.style.opacity = '1';
        const leg = p.legs.find((l) => t < l.t1) ?? p.legs[p.legs.length - 1];
        const u = ease(Math.min(1, Math.max(0, (t - leg.t0) / (leg.t1 - leg.t0))));
        const pos = leg.from.map((v, j) => v + (leg.to[j] - v) * u) as [number, number, number];
        // A puck at rest rises with the assembly it sits in: the reject tray (stage 4) or the tool rack (stage 5).
        const liftZ = apart * (t > p.done ? (p.blocked >= 0 ? LIFT[3] : LIFT[4]) : 0);
        g.setAttribute('transform', B.along(pos[0], pos[1], pos[2] + liftZ));
        if (p.blocked >= 0 && t > p.legs[1].t1) g.setAttribute('data-bad', ''); else g.removeAttribute('data-bad');
        if (t >= p.born && t < p.done + 0.8) text = p.blocked >= 0
          ? `${pretty(p.tool)} · stopped at ${pl.guard_layers[p.blocked].label.toLowerCase()} (${pretty(p.reason ?? '')})`
          : `${pretty(p.tool)} · passed all ${pl.guard_layers.length} gates`;
      });
      blades.forEach((g, gi) => {
        const closing = plan.pucks.some((p) => p.blocked === gi && t > p.legs[1].t1 - 0.05 && t < p.done + 0.6);
        const cur = Number(g.dataset.z ?? 13);
        // Open, the blade sits up inside the crossbar with a puck's height of clearance; closed, it rests on the belt.
        const next = cur + ((closing ? 0 : 13) - cur) * 0.25;
        g.dataset.z = String(next);
        g.setAttribute('transform', B.along(0, 0, B.BELT.z + next + apart * LIFT[3]));
      });
      sockets.forEach((s) => {
        const hit = plan.pucks.some((p) => p.blocked < 0 && pl.tools[Number(s.dataset.socket)] === p.tool && t > p.done);
        if (hit) s.setAttribute('data-on', ''); else s.removeAttribute('data-on');
        s.setAttribute('transform', B.along(0, 0, apart * LIFT[4]));
      });
      const scored = t > plan.pucks[plan.pucks.length - 1].done + 0.4;
      gauges.forEach((g, i) => {
        shares[i] += ((scored ? (verdicts[i] ? 0.86 : 0.14) : 0.5) - shares[i]) * 0.12;
        const [x, y] = B.GAUGES[i];
        g.setAttribute('d', B.needle(x, y, 7.5, 16, shares[i]));
        g.setAttribute('transform', B.along(0, 0, apart * LIFT[5]));
      });
      if (dialNeedle) {
        const share = scored ? unsafe.defended_rate : unsafe.baseline_rate;
        const cur = Number(dialNeedle.dataset.share ?? unsafe.baseline_rate);
        const next = cur + (share - cur) * 0.08;
        dialNeedle.dataset.share = String(next);
        dialNeedle.setAttribute('d', B.needle(B.DIAL[0], B.DIAL[1], 22, 33, next));
        dialNeedle.setAttribute('transform', B.along(0, 0, apart * LIFT[7]));
      }
      if (scored) text = `run scored: utility ${side.utility_pass ? 'pass' : 'fail'}, security ${side.security_pass ? 'pass' : 'fail'} · unsafe ${unsafe.baseline} → ${unsafe.defended}`;
      set(text);
    };
    const tick = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
      last = now;
      t = (t + dt) % plan.total;
      apart += (want - apart) * (1 - Math.exp(-dt / 0.22));
      draw();
      frame = visible ? requestAnimationFrame(tick) : 0;
    };
    const run = () => { if (!frame && visible && !reduce) { last = 0; frame = requestAnimationFrame(tick); } };
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) run(); }, { rootMargin: '120px 0px' });
    io.observe(el);
    const enter = () => { want = 1; }, leave = () => { want = 0; };
    el.addEventListener('pointerenter', enter); el.addEventListener('pointerleave', leave);
    el.addEventListener('focus', enter); el.addEventListener('blur', leave);
    const key = (e: KeyboardEvent) => {
      if (!onStage) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); onStage(Math.min(B.STAGE_ORDER.length - 1, activeRef.current + 1)); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); onStage(Math.max(0, activeRef.current - 1)); }
    };
    el.addEventListener('keydown', key);
    if (reduce) { t = plan.total - 0.1; apart = 0; draw(); }
    else draw();
    return () => { cancelAnimationFrame(frame); io.disconnect(); el.removeEventListener('pointerenter', enter); el.removeEventListener('pointerleave', leave); el.removeEventListener('focus', enter); el.removeEventListener('blur', leave); el.removeEventListener('keydown', key); };
  }, [plan, pl, reduce, onStage, side, unsafe, verdicts]);

  useEffect(() => { /* re-highlight when the page's active stage changes, even while still */
    const svg = svgRef.current;
    if (!svg) return;
    svg.querySelectorAll<SVGGElement>('[data-stage]').forEach((g) => { if (Number(g.dataset.index) === active) g.setAttribute('data-on', ''); else g.removeAttribute('data-on'); });
  }, [active]);

  const sockets = B.rackSockets(pl.tools.length);
  const stageIdx = (id: B.StageId) => B.STAGE_ORDER.indexOf(id);
  return (
    <figure className="iso-figure anatomy">
      <div className="iso-plate">
        <div className="iso-plate-corners" aria-hidden="true">
          <span className="iso-plate-corner" data-corner="fig">Fig 1</span>
          <span className="iso-plate-corner" data-corner="title">The test bench</span>
          <span className="iso-plate-corner" data-corner="hint">Hover to take it apart · arrow keys step</span>
          <span className="iso-plate-corner" data-corner="readout" ref={readout}>Waiting for the next tool call</span>
        </div>
        <div ref={host} className="iso-stage" tabIndex={0} role="group" aria-label="The TrustBench pipeline as a test bench. Arrow keys move between stages.">
          <svg ref={svgRef} className="iso-svg" viewBox={`0 0 ${B.WIDTH} ${B.HEIGHT}`} role="img" aria-label="Isometric test bench: task hoppers, a stamping drum, the reader head, three guard gates, a tool rack, three gauges, a filing cabinet and a dial">
            <g dangerouslySetInnerHTML={{ __html: art.base }} />
            {art.stages.map((s) => (
              <g key={`b-${s.id}`} className="iso-assy" data-stage={s.id} data-index={stageIdx(s.id)} dangerouslySetInnerHTML={{ __html: s.back }} />
            ))}
            {sockets.map(([x, y], i) => (
              <path key={i} className="iso-line socket-lamp" data-socket={i} d={B.k.ring(x, y, 3, 14.2, B.P, 16)} />
            ))}
            {plan.pucks.map((p, i) => (
              <g key={i} data-puck={i} className="puck" style={{ opacity: 0 }} dangerouslySetInnerHTML={{ __html: p.blocked >= 0 ? puckArt.bad : puckArt.ok }} />
            ))}
            {B.GATES.map((x, i) => <g key={i} data-blade={i} className="blade" dangerouslySetInnerHTML={{ __html: B.bladeSvg(x) }} />)}
            {art.stages.map((s) => (
              <g key={`f-${s.id}`} className="iso-assy" data-stage={s.id} data-index={stageIdx(s.id)} dangerouslySetInnerHTML={{ __html: s.front }} />
            ))}
            {B.GAUGES.map((_, i) => <path key={i} className="iso-line" data-tone="lit" data-gauge={i} d="" />)}
            <path className="iso-line ghost-needle" data-tone="red" data-dashed="" d={B.needle(B.DIAL[0], B.DIAL[1], 22, 33, unsafe.baseline_rate)} />
            <path className="iso-line" data-tone="lit" data-dial="" d={B.needle(B.DIAL[0], B.DIAL[1], 22, 33, unsafe.baseline_rate)} />
          </svg>
        </div>
      </div>
      <figcaption className="iso-legend">
        <span className="iso-keys">
          <span className="iso-key"><svg className="iso-swatch" data-mark="lit" viewBox="0 0 16 10" aria-hidden="true"><path d="M2 4.5 8 1.5 14 4.5 14 6 8 9 2 6Z" /></svg>Highlighted: the stage described beside the figure</span>
          <span className="iso-key"><svg className="iso-swatch" data-mark="red" viewBox="0 0 16 10" aria-hidden="true"><path d="M1.5 5h13" /></svg>Red: a refused call, and the baseline needle</span>
        </span>
        <span className="iso-caption">The pucks replay the tool calls of a real recorded run with the guard on ({h.example.case_id}, repetition {h.example.repetition}). The dial reads the sealed test's unsafe rate: {unsafe.baseline} without the guard (red, dashed) and {unsafe.defended} with it. Drawn with the Anatomy kit (MIT).</span>
      </figcaption>
    </figure>
  );
}
