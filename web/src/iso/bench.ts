// Fig 1, the test bench: the TrustBench pipeline built as one machine on a surface plate, with the Anatomy kit
// (iso-kit.ts). Tool calls leave the helper's reader head as pucks on a belt, pass the guard's three gates (allow-list,
// contract scope, exact-argument approval), and either drop into the tool rack or are flipped into the reject tray; the
// scorer's three gauges read the run, the filing cabinet keeps it, and the big dial shows the paired result. Static parts
// are built once here as SVG strings, split into a back and a front layer around the belt so pucks pass between them;
// the gate blades and pucks are moved by the live component (components/Anatomy.tsx).
import * as k from './iso-kit';

export const WIDTH = 760;
export const HEIGHT = 470;

export type StageId = 'tasks' | 'render' | 'agent' | 'guard' | 'tools' | 'score' | 'store' | 'analysis';
export const STAGE_ORDER: StageId[] = ['tasks', 'render', 'agent', 'guard', 'tools', 'score', 'store', 'analysis'];

// World layout (units ~ px of the real thing; x along the line, y across it, z up).
export const PLATE = { x: -300, y: -92, w: 600, d: 184, r: 10 };
const PLATE_H = 12, FOOT_H = 6;
export const BELT = { from: -170, to: 150, y: 0, half: 13, z: 7 };
export const AGENT_X = -128;
export const GATES = [-62, -22, 18];        // allow-list, contract scope, approval
export const RACK = { x: 66, y: -66, w: 92, d: 36 };
export const TRAY = { x: -86, y: 34, w: 52, d: 38, r: 2 };
export const SCORER = [196, 50] as const;
export const CABINET = { x: 214, y: -86, w: 56, d: 60 };
export const DIAL = [-226, 40] as const;

export const P = k.fitProjection(
  [...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0), [AGENT_X, 0, 86], [CABINET.x + CABINET.w, CABINET.y, 96], [-262, -66, 70]],
  WIDTH, HEIGHT, { pad: 22, azimuth: 38 },
);

const at = (p: k.Point3) => k.iso(p, P);
const S = (paths: k.SolidPaths, style?: k.SolidStyle) => k.solidSvg(paths, style);
const L = (d: string, style?: k.LineStyle) => k.lineSvg(d, style);
const D = (points: k.Flat[], style?: { size?: number; tone?: k.Tone }) => k.dotsSvg(points, style);
const byDepth = (points: k.Plane[]) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
const screws = (plan: k.Plan, z: number, inset = 4) => D(k.corners(plan, inset).map(([x, y]) => at([x, y, z])), { size: 0.45 });

/** A box with a bevel, its inset groove, and screws at the corners. */
function block(plan: k.Plan, z: number, h: number, { tone = 'mid' as k.Tone, groove = true, lit = false } = {}) {
  return S(k.slabOf(plan, z, h, P, 6, 0.6), { tone, lit }) + (groove ? L(k.planOutline(k.insetPlan(plan, 3), z + h, P), { tone: 'faint' }) : '') + screws(plan, z + h, 3.2);
}

function base() {
  const out = [`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`];
  for (const [x, y] of byDepth(k.corners(PLATE, 26))) {
    out.push(S(k.cylinder(x, y, 8, -PLATE_H - FOOT_H, 1.6, P, 28), { tone: 'lo' }));
    out.push(S(k.cylinder(x, y, 6, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: 'mid' }));
  }
  out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.6), { tone: 'mid' }));
  out.push(L(k.planOutline(k.insetPlan(PLATE, 6), 0, P), { tone: 'lo' }));
  const cs = k.corners(PLATE, 12);
  out.push(L(cs.map(([x, y]) => k.ring(x, y, 2.4, 0, P, 16)).join(''), { tone: 'lo' }), D(cs.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
  // Ruler strip along the front edge, ticks every 5 with a major every 25.
  const strip = { x: PLATE.x + 40, y: PLATE.y + PLATE.d - 16, w: PLATE.w - 80, d: 7, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: 'lo', crease: 'none' }));
  const t = k.topTicks(strip.x + 4, strip.x + strip.w - 4, 5, 5, strip.y + 0.8, 0.6, [2, 3.8], P);
  out.push(L(t.minor, { tone: 'lo' }), L(t.major, { tone: 'mid' }));
  // Label plate with three rule lines (the engraved maker's plate).
  const label = { x: PLATE.x + 14, y: PLATE.y + 14, w: 40, d: 22, r: 2 };
  out.push(S(k.slabOf(label, 0, 0.8, P, 4), { tone: 'lo' }), screws(label, 0.8, 2.4));
  for (const dy of [6, 11, 16]) out.push(L(k.lineOnTop([label.x + 6, label.y + dy], [label.x + label.w - 6, label.y + dy], 0.8, P), { tone: 'faint', free: true }));
  return out.join('');
}

/** The belt between its rails, with rollers at both ends and a flow line that moves. */
function belt() {
  const out: string[] = [];
  const len = BELT.to - BELT.from;
  for (const y of [-BELT.half - 5, BELT.half]) {
    out.push(S(k.slabOf({ x: BELT.from - 8, y, w: len + 16, d: 5, r: 1 }, 0, BELT.z - 1, P, 3, 0.4), { tone: 'mid' }));
    out.push(D([BELT.from - 2, BELT.from + len / 2, BELT.to + 2].map((x) => at([x, y + 2.5, BELT.z - 1])), { size: 0.4 }));
  }
  const strip = { x: BELT.from, y: -BELT.half, w: len, d: BELT.half * 2, r: 2 };
  out.push(S(k.slabOf(strip, 2, BELT.z - 3, P, 4), { tone: 'lo', crease: 'none' }));
  const ticks = k.topTicks(strip.x + 4, strip.x + strip.w - 4, 8, 100, -BELT.half + 1, BELT.z - 1, [BELT.half * 2 - 2, BELT.half * 2 - 2], P);
  out.push(L(ticks.minor, { tone: 'faint' }));
  out.push(L(k.lineOnTop([BELT.from + 4, 0], [BELT.to - 4, 0], BELT.z - 1, P), { tone: 'mid', flow: true }));
  for (const x of [BELT.from - 4, BELT.to + 4]) out.push(S(k.slabOf({ x: x - 4, y: -BELT.half - 1, w: 8, d: BELT.half * 2 + 2, r: 3.5 }, 1, BELT.z - 1, P, 6), { tone: 'mid' }));
  return out.join('');
}

/** Stage 1: two card hoppers at the back-left, everyday tasks and attack documents, each card a thin slab. */
function hoppers() {
  const out: string[] = [];
  for (const [i, x] of [-268, -232].entries()) {
    const tray = { x, y: -70, w: 30, d: 40, r: 2 };
    out.push(block(tray, 0, 6, { groove: false }));
    for (let c = 0; c < 9; c++) {
      const card = { x: x + 3 + (c % 2) * 0.6, y: -67 + (c % 3) * 0.4, w: 24, d: 34, r: 1 };
      out.push(S(k.slabOf(card, 6 + c * 2.2, 1.6, P, 2), { tone: c === 8 ? 'hi' : 'lo', crease: 'none' }));
    }
    const top = 6 + 9 * 2.2;
    // The top card shows what it carries: rule lines of text, and on the attack card one red hidden line.
    for (const dy of [8, 13, 18, 23]) out.push(L(k.lineOnTop([x + 7, -67 + dy], [x + 22, -67 + dy], top, P), { tone: i === 1 && dy === 18 ? 'red' : 'faint', free: true }));
    out.push(S(k.slabOf({ x: x + 4, y: -73, w: 22, d: 3, r: 0.8 }, 0, 30, P, 2), { tone: 'mid' }));
  }
  out.push(L(k.lineOnTop([-238 + 15, -30], [-205, -8], 0.2, P), { tone: 'lo', dotted: true }));
  return out.join('');
}

/** Stage 2: the stamping drum, nine print faces (one per way of writing an attack) around its top. */
function drum(faces: number) {
  const [cx, cy] = [-196, -44];
  const out = [block({ x: cx - 18, y: cy - 18, w: 36, d: 36, r: 3 }, 0, 8)];
  out.push(S(k.cylinder(cx, cy, 15, 8, 26, P, 40, 0.6), { tone: 'mid' }));
  const t = k.radialTicks(cx, cy, 15, faces, 1, 34, [4, 4], P);
  out.push(L(t.minor + t.major, { tone: 'lo' }));
  out.push(L([14, 20, 26].map((z) => k.sideArc(cx, cy, 15, 8 + z, P, 24)).join(''), { tone: 'faint' }));
  out.push(S(k.cylinder(cx, cy, 5, 34, 4, P, 24), { tone: 'mid' }), L(k.knurl(cx, cy, 5, 34, 38, 24, P), { tone: 'lo' }));
  out.push(D([at([cx, cy, 38])], { size: 0.6, tone: 'hi' }));
  return out.join('');
}

/** Stage 3, back half: the gantry post behind the belt. */
function agentBack() {
  return block({ x: AGENT_X - 6, y: -BELT.half - 22, w: 12, d: 10, r: 2 }, 0, 70, { groove: false });
}

/** Stage 3, front half: the near post, the crossbar and the reader head (the model) with its provider knob and model lamps. */
function agentFront(providers: number, models: number) {
  const out = [block({ x: AGENT_X - 6, y: BELT.half + 12, w: 12, d: 10, r: 2 }, 0, 70, { groove: false })];
  out.push(block({ x: AGENT_X - 9, y: -BELT.half - 24, w: 18, d: BELT.half * 2 + 48, r: 2 }, 70, 8));
  const head = { x: AGENT_X - 16, y: -12, w: 32, d: 24, r: 3 };
  out.push(block(head, 44, 26, { lit: false }));
  out.push(S(k.slabOf({ x: AGENT_X - 4, y: -4, w: 8, d: 8, r: 1.5 }, 30, 14, P, 4), { tone: 'mid' }));
  out.push(S(k.slabOf({ x: AGENT_X - 6, y: -6, w: 12, d: 12, r: 2 }, 26, 4, P, 4), { tone: 'hi', crease: 'none' }));
  const knob = [AGENT_X + 8, 4] as const;
  out.push(S(k.cylinder(knob[0], knob[1], 5, 70, 4, P, 28), { tone: 'mid' }), L(k.knurl(knob[0], knob[1], 5, 70, 74, 30, P), { tone: 'lo' }));
  const t = k.radialTicks(knob[0], knob[1], 7.4, providers, 1, 70, [1.6, 1.6], P, -Math.PI * 0.75, Math.PI * 0.5);
  out.push(L(t.minor + t.major, { tone: 'mid' }));
  out.push(D(Array.from({ length: models }, (_, i) => at([AGENT_X - 12 + i * 4, -8, 70])), { size: 0.7, tone: 'hi' }));
  return out.join('');
}

/** Stage 4: each gate is two posts across the belt with a crossbar; the blade between them is drawn by the live layer. */
function gateHalf(x: number, near: boolean) {
  const y = near ? BELT.half + 8 : -BELT.half - 16;
  const out = [block({ x: x - 4, y, w: 8, d: 8, r: 1.5 }, 0, 44, { groove: false })];
  if (near) {
    out.push(block({ x: x - 5, y: -BELT.half - 17, w: 10, d: BELT.half * 2 + 34, r: 1.5 }, 44, 6));
    const plate = { x: x - 4, y: BELT.half + 18, w: 8, d: 10, r: 1 };
    out.push(S(k.slabOf(plate, 0, 2, P, 3), { tone: 'lo' }));
  }
  return out.join('');
}

export function bladeSvg(x: number) {
  return S(k.slabOf({ x: x - 1.6, y: -BELT.half + 1, w: 3.2, d: BELT.half * 2 - 2, r: 0.6 }, 0, 24, P, 2), { tone: 'hi' });
}

function tray() {
  const out = [block(TRAY, 0, 3, { groove: false })];
  const wall = 1.6;
  for (const pl of [{ x: TRAY.x, y: TRAY.y, w: TRAY.w, d: wall }, { x: TRAY.x, y: TRAY.y, w: wall, d: TRAY.d }, { x: TRAY.x + TRAY.w - wall, y: TRAY.y, w: wall, d: TRAY.d }, { x: TRAY.x, y: TRAY.y + TRAY.d - wall, w: TRAY.w, d: wall }])
    out.push(S(k.slabOf({ ...pl, r: 0.4 }, 3, 9, P, 2), { tone: 'mid', crease: 'none' }));
  out.push(L(k.lineOnTop([TRAY.x + 8, TRAY.y + TRAY.d / 2], [TRAY.x + TRAY.w - 8, TRAY.y + TRAY.d / 2], 3, P), { tone: 'red', free: true }));
  return out.join('');
}

/** Stage 5: the tool rack, one socket per tool in two rows. */
export function rackSockets(n: number) {
  const per = Math.ceil(n / 2);
  return Array.from({ length: n }, (_, i) => [RACK.x + 10 + (i % per) * ((RACK.w - 20) / Math.max(1, per - 1)), RACK.y + (i < per ? 11 : 25)] as k.Plane);
}
function rack(n: number) {
  const out = [block({ ...RACK, r: 3 }, 0, 14)];
  for (const [x, y] of rackSockets(n)) out.push(L(k.ring(x, y, 4.2, 14, P, 18), { tone: 'mid' }), L(k.ring(x, y, 2.4, 14, P, 14), { tone: 'lo' }));
  return out.join('');
}

/** Stage 6: three dial gauges on a riser (utility pass, security pass, attacker goal). */
export const GAUGES = [-26, 0, 26].map((dx) => [SCORER[0] + dx, SCORER[1]] as k.Plane);
function scorer() {
  const out = [block({ x: SCORER[0] - 42, y: SCORER[1] - 14, w: 84, d: 28, r: 3 }, 0, 10)];
  for (const [x, y] of GAUGES) {
    out.push(S(k.cylinder(x, y, 10, 10, 6, P, 36, 0.5), { tone: 'mid' }));
    const t = k.radialTicks(x, y, 9, 20, 5, 16, [1.4, 2.6], P, -Math.PI * 0.8, Math.PI * 1.6);
    out.push(L(t.minor, { tone: 'lo' }), L(t.major, { tone: 'mid' }), D([at([x, y, 16])], { size: 0.6, tone: 'hi' }));
  }
  return out.join('');
}

/** Stage 7: the filing cabinet, drawers with handles; one drawer per row of reports. */
function cabinet(drawers: number) {
  const out = [S(k.slabOf({ ...CABINET, r: 2 }, 0, 96, P, 6, 0.8), { tone: 'mid' })];
  const h = 96 / drawers;
  for (let i = 1; i < drawers; i++) out.push(L(k.sideSeam({ ...CABINET, r: 2 }, i * h, P, 6), { tone: 'lo' }));
  for (let i = 0; i < drawers; i++) {
    const z = i * h + h / 2;
    out.push(D([at([CABINET.x + CABINET.w / 2 - 6, CABINET.y + CABINET.d, z]), at([CABINET.x + CABINET.w / 2 + 6, CABINET.y + CABINET.d, z])], { size: 0.55, tone: 'hi' }));
    out.push(L(k.segment([CABINET.x + CABINET.w / 2 - 6, CABINET.y + CABINET.d, z], [CABINET.x + CABINET.w / 2 + 6, CABINET.y + CABINET.d, z], P), { tone: 'mid' }));
  }
  out.push(L(k.planOutline(k.insetPlan({ ...CABINET, r: 2 }, 4), 96, P), { tone: 'faint' }), screws({ ...CABINET, r: 2 }, 96, 3));
  return out.join('');
}

/** Stage 8: the big dial on a stand at the front-left: the paired result. */
function dialStand() {
  const [cx, cy] = DIAL;
  const out = [block({ x: cx - 20, y: cy - 20, w: 40, d: 40, r: 4 }, 0, 8)];
  out.push(S(k.cylinder(cx, cy, 6, 8, 18, P, 28), { tone: 'mid' }));
  out.push(S(k.cylinder(cx, cy, 28, 26, 7, P, 56, 0.8), { tone: 'mid' }));
  const t = k.radialTicks(cx, cy, 26, 40, 5, 33, [2, 4], P, -Math.PI * 0.8, Math.PI * 1.6);
  out.push(L(t.minor, { tone: 'lo' }), L(t.major, { tone: 'mid' }), L(k.ring(cx, cy, 20, 33, P, 40), { tone: 'faint' }));
  out.push(D([at([cx, cy, 33])], { size: 0.9, tone: 'hi' }));
  return out.join('');
}

/** A needle on a horizontal dial face: angle from `from` across `span` at share 0..1. */
export function needle(cx: number, cy: number, r: number, z: number, share: number, from = -Math.PI * 0.8, span = Math.PI * 1.6) {
  const a = from + span * Math.max(0, Math.min(1, share));
  return k.lineOnTop([cx, cy], [cx + Math.cos(a) * r, cy + Math.sin(a) * r], z, P);
}

export function puckSvg(tone: k.Tone = 'hi') {
  return S(k.cylinder(0, 0, 6, BELT.z, 4, P, 28, 0.5), { tone, halo: false }) + L(k.ring(0, 0, 3.2, BELT.z + 4, P, 16), { tone: 'lo' });
}
export const along = (x: number, y = 0, z = 0) => k.translateAlong(P, [x, y, z]);
export const at3 = at;

export interface BenchCounts { renderings: number; providers: number; models: number; tools: number; drawers: number }

/** Assemblies by stage, each split into the layer behind the belt and the layer in front of it. */
export function buildBench(c: BenchCounts) {
  const stage = (id: StageId, back: string, front = '') => ({ id, back, front });
  return {
    base: base() + belt(),
    stages: [
      stage('tasks', hoppers()),
      stage('render', drum(c.renderings)),
      stage('agent', agentBack(), agentFront(c.providers, c.models)),
      stage('guard', GATES.map((x) => gateHalf(x, false)).join(''), GATES.map((x) => gateHalf(x, true)).join('') + tray()),
      stage('tools', rack(c.tools)),
      stage('score', '', scorer()),
      stage('store', cabinet(c.drawers)),
      stage('analysis', '', dialStand()),
    ],
  };
}

export { k };
