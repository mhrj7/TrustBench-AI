// How it works: a 3D model of what really happens when you press Run on the Live page (react-three-fiber). Each part of
// the system is a module on a dark grid floor, laid out in the order a run flows through them: the browser, the live
// service, the job queue, the runner, the fixtures, the agent and its model providers, the two arms, the guard's layers,
// the tool service, the scorer and the report. One scroll value drives the camera: it starts on the whole system, then
// flies to each module in turn; the module in focus opens up (its parts move apart and come alive). Packets flow along
// the links all the time; in the defended arm one packet is refused at the guard. Labels and counts come from
// pipeline.json. No external assets. Pauses off screen; one still frame under reduced motion.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Grid, Html, Lightformer, RoundedBox } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MotionValue } from 'motion/react';
import * as THREE from 'three';
import type { Pipeline } from '../lib/data';

export const STEPS = ['browser', 'service', 'queue', 'runner', 'fixtures', 'agent', 'arms', 'gateway', 'tools', 'score', 'report'] as const;
export type StepId = (typeof STEPS)[number];

const POS: Record<StepId, [number, number, number]> = {
  browser: [-34, 0, 6], service: [-23, 0, 0], queue: [-12, 0, -4], runner: [-1, 0, 0], fixtures: [9, 0, -6], agent: [19, 0, 0],
  arms: [28, 0, -1], gateway: [30, 0, 5], tools: [41, 0, 0], score: [51, 0, -4], report: [61, 0, 2],
};
const BLUE = '#2433ff', RED = '#ef3b24', GLOW = '#5b6bff';
const GATE_GAP = 3.4, GATE_Y = 2.2;
const gateX = (i: number, n: number) => POS.gateway[0] + (i - (n - 1) / 2) * GATE_GAP;
const smooth = (t: number) => t * t * (3 - 2 * t);
type F = React.MutableRefObject<number[]>;   // per-step focus 0..1, written by the rig each frame

const metal = (color = '#d9dcea', rough = 0.22) => new THREE.MeshPhysicalMaterial({ color, metalness: 0.9, roughness: rough, clearcoat: 0.6, clearcoatRoughness: 0.2 });
const plastic = (color: string) => new THREE.MeshPhysicalMaterial({ color, metalness: 0.1, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.15 });
const glow = (color: string) => new THREE.MeshBasicMaterial({ color, toneMapped: false });

function Label({ text, sub, planned, y = 3.4 }: { text: string; sub?: string; planned?: boolean; y?: number }) {
  return (
    <Html position={[0, y, 0]} center distanceFactor={18} zIndexRange={[5, 0]} className="sm-label-wrap">
      <div className={`sm-label ${planned ? 'is-planned' : ''}`}><b>{text}</b>{sub && <span>{sub}</span>}</div>
    </Html>
  );
}

function Node({ id, f, children }: { id: StepId; f: F; children: (open: () => number) => React.ReactNode }) {
  const i = STEPS.indexOf(id);
  return <group position={POS[id]}>{children(() => f.current[i] ?? 0)}</group>;
}

/** 1. The browser: a laptop showing the Live page; the Run button lights when it is pressed. */
function Browser({ open, modes }: { open: () => number; modes: Pipeline['live']['modes'] }) {
  const tex = useMemo(() => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 320; const x = c.getContext('2d')!;
    x.fillStyle = '#f0f1fa'; x.fillRect(0, 0, 512, 320);
    x.fillStyle = '#0d0e13'; x.font = '600 30px sans-serif'; x.fillText('Run it live', 28, 54);
    x.font = '16px sans-serif'; x.fillStyle = '#4b4e5f'; x.fillText('Mode', 28, 92);
    modes.forEach((m, i) => { x.fillStyle = i === 0 ? '#2b2e3a' : '#e4e6ef'; x.beginPath(); x.roundRect(28 + i * 150, 104, 140, 38, 19); x.fill();
      x.fillStyle = i === 0 ? '#fff' : '#0d0e13'; x.font = '14px sans-serif'; x.fillText(m.id.replace('_', ' '), 44 + i * 150, 128); });
    x.fillStyle = '#4b4e5f'; x.font = '16px sans-serif'; x.fillText('Defense · rendering · cases', 28, 178);
    [0, 1, 2].forEach((i) => { x.fillStyle = '#ffffff'; x.fillRect(28, 192 + i * 22, 300, 14); });
    x.fillStyle = BLUE; x.beginPath(); x.roundRect(352, 240, 130, 46, 23); x.fill(); x.fillStyle = '#fff'; x.font = '600 18px sans-serif'; x.fillText('Run', 398, 270);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  }, [modes]);
  const lid = useRef<THREE.Group>(null), btn = useRef<THREE.Mesh>(null);
  const mats = useMemo(() => ({ body: metal('#c9ccd8', 0.3), key: plastic('#2b2e3a') }), []);
  useFrame(({ clock }) => {
    const o = open();
    if (lid.current) lid.current.rotation.x = -0.24 - o * 0.06;   // open laptop: lid up, tipped back a little
    if (btn.current) (btn.current.material as THREE.MeshBasicMaterial).opacity = 0.25 + (Math.sin(clock.elapsedTime * 4) * 0.5 + 0.5) * 0.6 * (0.3 + o);
  });
  return (
    <group rotation={[0, 0.5, 0]}>
      <RoundedBox args={[6, 0.3, 4.2]} radius={0.12} position={[0, 0.15, 0]} material={mats.body} />
      {Array.from({ length: 24 }, (_, i) => <mesh key={i} position={[-2.4 + (i % 8) * 0.68, 0.32, -1.4 + Math.floor(i / 8) * 0.6]} material={mats.key}><boxGeometry args={[0.5, 0.06, 0.42]} /></mesh>)}
      <group ref={lid} position={[0, 0.3, -2.05]}>
        <RoundedBox args={[6, 4, 0.18]} radius={0.12} position={[0, 2, 0]} material={mats.body} />
        <mesh position={[0, 2, 0.1]}><planeGeometry args={[5.6, 3.5]} /><meshBasicMaterial map={tex} toneMapped={false} /></mesh>
        <mesh ref={btn} position={[1.75, 0.7, 0.12]}><planeGeometry args={[1.5, 0.55]} /><meshBasicMaterial color={GLOW} transparent opacity={0.4} toneMapped={false} /></mesh>
      </group>
    </group>
  );
}

/** 2. The live service: a server tower with blinking lamps; its three mode drawers slide out, and a key vault sits beside it. */
function Service({ open, modes }: { open: () => number; modes: Pipeline['live']['modes'] }) {
  const drawers = useRef<(THREE.Mesh | null)[]>([]), leds = useRef<THREE.InstancedMesh>(null);
  const mats = useMemo(() => ({ body: metal('#3a3d4a', 0.35), drawer: metal('#d9dcea', 0.2), vault: metal('#9a9ca6', 0.25) }), []);
  const tmp = useMemo(() => new THREE.Object3D(), []), col = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }) => {
    const o = open(), t = clock.elapsedTime;
    drawers.current.forEach((d, i) => { if (d) d.position.z = 1.6 + o * (0.9 + i * 0.25); });
    const im = leds.current; if (!im) return;
    for (let i = 0; i < 30; i++) {
      tmp.position.set(-1.1 + (i % 6) * 0.44, 1.2 + Math.floor(i / 6) * 0.9, 1.62); tmp.scale.setScalar(1); tmp.updateMatrix(); im.setMatrixAt(i, tmp.matrix);
      im.setColorAt(i, col.set(Math.sin(t * 3 + i * 1.7) > 0.3 ? GLOW : '#20233a'));
    }
    im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
  });
  return (
    <group>
      <RoundedBox args={[3.4, 6.4, 3.2]} radius={0.18} position={[0, 3.2, 0]} material={mats.body} />
      <instancedMesh ref={leds} args={[undefined, undefined, 30]}><boxGeometry args={[0.26, 0.08, 0.04]} /><meshBasicMaterial toneMapped={false} /></instancedMesh>
      {modes.map((m, i) => (
        <mesh key={m.id} ref={(el) => { drawers.current[i] = el; }} position={[0, 5.9 - i * 0.7 - 0.0, 1.6]} material={mats.drawer}><boxGeometry args={[3, 0.5, 0.4]} /></mesh>
      ))}
      <group position={[3, 0, 1]}>
        <RoundedBox args={[1.6, 1.6, 1.6]} radius={0.15} position={[0, 0.8, 0]} material={mats.vault} />
        <mesh position={[0, 0.85, 0.81]}><torusGeometry args={[0.38, 0.07, 12, 32]} /><meshStandardMaterial color="#2b2e3a" metalness={0.8} roughness={0.3} /></mesh>
      </group>
    </group>
  );
}

/** 3. The queue: a track of job tokens feeding two lanes of workers (scripted and live). */
function Queue({ open, workers }: { open: () => number; workers: Record<string, number> }) {
  const tokens = useRef<THREE.Group>(null);
  const mats = useMemo(() => ({ rail: metal('#9a9ca6', 0.3), token: plastic('#e9eaf2'), worker: metal('#d9dcea', 0.2), live: plastic(BLUE) }), []);
  const lanes = Object.entries(workers);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    tokens.current?.children.forEach((c, i) => { c.position.x = -4 + (((t * 0.8 + i * 1.1) % 6.6)); c.position.y = 0.5 + open() * 0.15; });
  });
  return (
    <group>
      <mesh position={[-1, 0.15, 0]} material={mats.rail}><boxGeometry args={[7, 0.3, 1.2]} /></mesh>
      <group ref={tokens}>{Array.from({ length: 6 }, (_, i) => <mesh key={i} material={i % 3 === 0 ? mats.live : mats.token}><cylinderGeometry args={[0.38, 0.38, 0.22, 24]} /></mesh>)}</group>
      {lanes.map(([lane, n], li) => (
        <group key={lane} position={[3.2, 0, (li - 0.5) * 3]}>
          {Array.from({ length: n }, (_, wi) => (
            <group key={wi} position={[wi * 1.6, 0, 0]}>
              <RoundedBox args={[1.2, 1.8, 1.2]} radius={0.12} position={[0, 0.9, 0]} material={lane === 'live' ? mats.live : mats.worker} />
              <mesh position={[0, 1.95, 0]}><cylinderGeometry args={[0.35, 0.35, 0.1, 20]} /><meshBasicMaterial color={GLOW} toneMapped={false} /></mesh>
            </group>
          ))}
          <Label text={`${lane} lane`} sub={`${n} worker${n > 1 ? 's' : ''}`} y={2.8} />
        </group>
      ))}
    </group>
  );
}

/** 4. The runner: one process that spawns its children (tool server, gateway, agent) as a group. */
function Runner({ open }: { open: () => number }) {
  const kids = useRef<(THREE.Group | null)[]>([]);
  const mats = useMemo(() => ({ main: metal('#d9dcea', 0.18), kid: metal('#9a9ca6', 0.25) }), []);
  useFrame(({ clock }) => {
    const o = open(), t = clock.elapsedTime;
    kids.current.forEach((k, i) => { if (!k) return; const a = (i / 3) * Math.PI * 2 + t * 0.2; k.position.set(Math.cos(a) * (1.4 + o * 1.6), 2.6 + o * 1.2 + Math.sin(t + i) * 0.1, Math.sin(a) * (1.4 + o * 1.6)); });
  });
  return (
    <group>
      <RoundedBox args={[3, 2.2, 3]} radius={0.25} position={[0, 1.1, 0]} material={mats.main} />
      <mesh position={[0, 2.25, 0]}><torusGeometry args={[1.0, 0.06, 12, 48]} /><meshBasicMaterial color={GLOW} toneMapped={false} /></mesh>
      {['tool server', 'gateway', 'agent'].map((n, i) => (
        <group key={n} ref={(el) => { kids.current[i] = el; }}>
          <RoundedBox args={[1, 0.8, 1]} radius={0.1} material={mats.kid} />
        </group>
      ))}
    </group>
  );
}

/** 5. The fixtures: a fresh small world per case; its pages fan out, one carrying the hidden instruction. */
function Fixtures({ open, tasks, attacks }: { open: () => number; tasks: number; attacks: number }) {
  const pages = useRef<(THREE.Group | null)[]>([]);
  const mats = useMemo(() => ({ page: plastic('#ffffff'), line: glow('#b9bccb'), trick: glow(RED), base: metal('#9a9ca6', 0.3) }), []);
  // Pages stand on edge facing the viewer, stacked one behind another; in focus they fan out side by side.
  useFrame(() => { const o = open(); pages.current.forEach((p, i) => { if (!p) return; p.position.set((i - 2) * (0.35 + o * 2.0), 1.95, -i * 0.25 * (1 - o)); p.rotation.set(Math.PI / 2 - 0.12, (i - 2) * -0.12 * o, 0); }); });
  return (
    <group>
      <RoundedBox args={[11, 0.4, 3]} radius={0.12} position={[0, 0.2, 0]} material={mats.base} />
      {Array.from({ length: 5 }, (_, i) => (
        <group key={i} ref={(el) => { pages.current[i] = el; }}>
          <mesh material={mats.page}><boxGeometry args={[2.2, 0.03, 2.9]} /></mesh>
          {[0, 1, 2, 3, 4].map((l) => <mesh key={l} position={[-0.1, 0.03, -1 + l * 0.45]} material={i === 3 && l === 2 ? mats.trick : mats.line}><boxGeometry args={[1.6, 0.01, 0.1]} /></mesh>)}
        </group>
      ))}
      <Label text="Fixtures" sub={`${tasks} tasks · ${attacks} attacks`} y={4.4} />
    </group>
  );
}

/** 6. The agent: the core that asks a model what to do, cabled to its providers; a dashed socket for external agents (planned). */
function Agent({ open, providers, agents }: { open: () => number; providers: string[]; agents: Pipeline['live']['agents'] }) {
  const core = useRef<THREE.Mesh>(null), ring = useRef<THREE.Mesh>(null);
  const mats = useMemo(() => ({ core: plastic(BLUE), tower: metal('#d9dcea', 0.2), ghost: new THREE.MeshBasicMaterial({ color: '#9aa4ff', wireframe: true, transparent: true, opacity: 0.35 }) }), []);
  const planned = agents.filter((a) => a.status !== 'available');
  useFrame(({ clock }) => {
    const t = clock.elapsedTime, o = open();
    if (core.current) { core.current.position.y = 2.4 + Math.sin(t * 1.4) * 0.15; core.current.scale.setScalar(1 + o * 0.15); }
    if (ring.current) ring.current.rotation.z = t * 0.6;
  });
  return (
    <group>
      <mesh ref={core} material={mats.core}><sphereGeometry args={[1.3, 48, 48]} /></mesh>
      <mesh ref={ring} position={[0, 2.4, 0]} rotation={[Math.PI / 2.4, 0, 0]}><torusGeometry args={[2.0, 0.05, 12, 64]} /><meshBasicMaterial color={GLOW} toneMapped={false} /></mesh>
      {providers.map((p, i) => {
        const a = -0.9 + i * 0.9, x = Math.sin(a) * 5, z = -Math.cos(a) * 5;
        return (
          <group key={p} position={[x, 0, z]}>
            <RoundedBox args={[1.4, 4.4, 1.4]} radius={0.15} position={[0, 2.2, 0]} material={mats.tower} />
            {[0, 1, 2, 3].map((l) => <mesh key={l} position={[0, 1 + l * 0.9, 0.72]}><boxGeometry args={[0.9, 0.08, 0.02]} /><meshBasicMaterial color={GLOW} toneMapped={false} /></mesh>)}
            <Label text={p} sub="model provider" y={5.2} />
          </group>
        );
      })}
      {planned.length > 0 && (
        <group position={[0, 0, 5]}>
          <mesh position={[0, 1.4, 0]} material={mats.ghost}><boxGeometry args={[2.2, 2.8, 2.2]} /></mesh>
          <Label text="External agent" sub={`planned · ${planned.length} adapters`} planned y={3.4} />
        </group>
      )}
    </group>
  );
}

/** 7. The two arms: the same task, one path straight to the tools (baseline), one through the guard (defended). */
function Arms() {
  return (
    <group>
      <group position={[0, 0, -6.5]}><Label text="Baseline arm" sub="straight to the tools" y={1.2} /></group>
      <group position={[2, 0, 10]}><Label text="Defended arm" sub="through the guard" y={1.2} /></group>
    </group>
  );
}

/** 8. The guard: one ring per layer along the defended lane; the rings spread apart when in focus. */
function Gateway({ open, layers }: { open: () => number; layers: string[] }) {
  const rings = useRef<(THREE.Group | null)[]>([]);
  const mats = useMemo(() => ({ ring: metal('#d9dcea', 0.15) }), []);
  useFrame(({ clock }) => {
    const o = open(), t = clock.elapsedTime;
    // Fixed, equal spacing on the defended lane (GATE_GAP), so the flow line runs through every ring's centre; in focus
    // the rings turn gently.
    rings.current.forEach((r, i) => { if (!r) return; r.position.x = (i - (layers.length - 1) / 2) * GATE_GAP; r.rotation.x = Math.sin(t * 0.5 + i) * 0.06 * (0.3 + o); });
  });
  return (
    <group>
      {layers.map((l, i) => (
        <group key={l} ref={(el) => { rings.current[i] = el; }} position={[0, GATE_Y, 0]}>
          <mesh rotation={[0, Math.PI / 2, 0]} material={mats.ring}><torusGeometry args={[1.8, 0.16, 20, 64]} /></mesh>
          <mesh rotation={[0, Math.PI / 2, 0]}><torusGeometry args={[1.55, 0.03, 8, 64]} /><meshBasicMaterial color={i === 0 ? RED : GLOW} toneMapped={false} /></mesh>
          <Label text={l} y={i % 2 ? 3.9 : 2.7} />
        </group>
      ))}
    </group>
  );
}

/** 9. The tool service: the case's database with one block per tool around it. */
function Tools({ open, tools }: { open: () => number; tools: string[] }) {
  const blocks = useRef<(THREE.Mesh | null)[]>([]);
  const mats = useMemo(() => ({ db: metal('#9a9ca6', 0.25), block: plastic('#e9eaf2'), lit: plastic(BLUE) }), []);
  useFrame(({ clock }) => {
    const o = open(), t = clock.elapsedTime;
    blocks.current.forEach((b, i) => { if (!b) return; const a = (i / tools.length) * Math.PI * 2; const r = 3 + o * 1.2; b.position.set(Math.cos(a) * r, 0.6 + o * 0.8 + Math.sin(t * 2 + i) * 0.05 * o, Math.sin(a) * r); });
  });
  return (
    <group>
      {[0, 1, 2].map((l) => <mesh key={l} position={[0, 0.6 + l * 1.0, 0]} material={mats.db}><cylinderGeometry args={[1.5, 1.5, 0.8, 40]} /></mesh>)}
      {tools.map((t, i) => (
        <mesh key={t} ref={(el) => { blocks.current[i] = el; }} material={i % 4 === 0 ? mats.lit : mats.block}>
          <boxGeometry args={[1, 0.8, 1]} />
          <Html position={[0, 0.9, 0]} center distanceFactor={14} zIndexRange={[4, 0]} className="sm-label-wrap"><div className="sm-tag">{t.replaceAll('_', ' ')}</div></Html>
        </mesh>
      ))}
      <Label text="Tool service" sub={`${tools.length} tools over the case's database`} y={4.4} />
    </group>
  );
}

/** 10. The scorer: an arch the trace passes through, with one lamp per verdict. */
function Score({ open }: { open: () => number }) {
  const lamps = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const mats = useMemo(() => ({ arch: metal('#d9dcea', 0.18) }), []);
  useFrame(({ clock }) => { const t = clock.elapsedTime; lamps.current.forEach((m, i) => { if (m) m.color.set(Math.sin(t * 2 - i) > 0 ? (i === 2 ? RED : GLOW) : '#20233a'); }); void open; });
  return (
    <group>
      <mesh position={[0, 2.2, 0]} rotation={[0, Math.PI / 2, 0]} material={mats.arch}><torusGeometry args={[2.4, 0.35, 20, 48, Math.PI]} /></mesh>
      {['job done', 'nothing unsafe', 'attacker goal'].map((v, i) => (
        <group key={v} position={[0, 2.2 + Math.sin((i + 1) * Math.PI / 4) * 2.4, Math.cos((i + 1) * Math.PI / 4) * 2.4]}>
          <mesh><sphereGeometry args={[0.32, 20, 20]} /><meshBasicMaterial ref={(el) => { lamps.current[i] = el; }} toneMapped={false} /></mesh>
        </group>
      ))}
      <Label text="Scorer" sub="job done · nothing unsafe · attacker goal" y={5.4} />
    </group>
  );
}

/** 11. The report: a stack of pair records with a hash chip on top. */
function Report({ open }: { open: () => number }) {
  const sheets = useRef<(THREE.Mesh | null)[]>([]);
  const mats = useMemo(() => ({ sheet: plastic('#ffffff'), chip: plastic(BLUE) }), []);
  useFrame(() => { const o = open(); sheets.current.forEach((s, i) => { if (s) s.position.y = 0.3 + i * (0.18 + o * 0.35); }); });
  return (
    <group>
      {Array.from({ length: 7 }, (_, i) => <mesh key={i} ref={(el) => { sheets.current[i] = el; }} material={mats.sheet} rotation={[0, i * 0.05, 0]}><boxGeometry args={[3, 0.1, 3.8]} /></mesh>)}
      <mesh position={[0, 2.6, 0]} material={mats.chip}><boxGeometry args={[1.4, 0.2, 0.6]} /></mesh>
      <Label text="Report" sub="pairs, traces, gate decisions, hash" y={3.8} />
    </group>
  );
}

/** Links between modules, with packets moving along them. In the defended arm one packet is refused at the guard. */
function Links({ f, gates }: { f: F; gates: number }) {
  const curves = useMemo(() => {
    const v = (id: StepId, dy = 0.6, dz = 0) => new THREE.Vector3(POS[id][0], dy, POS[id][2] + dz);
    const seg = (pts: THREE.Vector3[], tone: string, refused = false) => {
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      // Where the refused packet stops: the point of the curve nearest the first ring's centre.
      let stopAt = 0.5;
      if (refused) { const g = new THREE.Vector3(gateX(0, gates), GATE_Y, POS.gateway[2]); let best = 1e9; for (let k = 0; k <= 400; k++) { const d = curve.getPointAt(k / 400).distanceTo(g); if (d < best) { best = d; stopAt = k / 400; } } }
      return { curve, tone, refused, stopAt };
    };
    return [
      seg([v('browser'), v('service')], GLOW), seg([v('service'), v('queue')], GLOW), seg([v('queue'), v('runner')], GLOW), seg([v('runner'), v('fixtures')], GLOW),
      seg([v('fixtures'), v('agent')], GLOW),
      seg([v('agent'), new THREE.Vector3(26, 0.6, -5), new THREE.Vector3(34, 0.6, -5), v('tools')], '#b9bccb'),        // baseline arm
      seg([v('agent'), new THREE.Vector3(gateX(0, gates) - 2.4, GATE_Y, POS.gateway[2]), ...Array.from({ length: gates }, (_, i) => new THREE.Vector3(gateX(i, gates), GATE_Y, POS.gateway[2])),
        new THREE.Vector3(gateX(gates - 1, gates) + 2.4, GATE_Y, POS.gateway[2]), v('tools')], GLOW, true),                    // defended arm
      seg([v('tools'), v('score')], GLOW), seg([v('score'), v('report')], GLOW),
      seg([v('report'), new THREE.Vector3(30, 14, 20), new THREE.Vector3(-10, 14, 20), v('browser', 2)], '#9aa4ff'),       // the result comes back
    ];
  }, [gates]);
  const tubes = useMemo(() => curves.map((c) => new THREE.TubeGeometry(c.curve, 64, 0.05, 6, false)), [curves]);
  const packets = useRef<(THREE.Mesh | null)[]>([]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    curves.forEach((c, i) => {
      for (let k = 0; k < 3; k++) {
        const m = packets.current[i * 3 + k];
        if (!m) continue;
        let u = (t * 0.22 + k / 3 + i * 0.07) % 1;
        // In the defended arm the first packet of each cycle is refused: it stops at the guard and fades red.
        const stop = c.refused && k === 0;
        if (stop) u = Math.min(u, c.stopAt);
        m.position.copy(c.curve.getPointAt(u));
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.color.set(stop && u >= c.stopAt ? RED : c.tone);
      }
    });
    void f;
  });
  return (
    <group>
      {tubes.map((g, i) => <mesh key={i} geometry={g}><meshBasicMaterial color={curves[i].tone} transparent opacity={0.35} toneMapped={false} /></mesh>)}
      {curves.flatMap((_, i) => [0, 1, 2].map((k) => (
        <mesh key={`${i}-${k}`} ref={(el) => { packets.current[i * 3 + k] = el; }}><sphereGeometry args={[0.22, 16, 16]} /><meshBasicMaterial color={GLOW} toneMapped={false} /></mesh>
      )))}
    </group>
  );
}

/** The camera: an overview of the whole system, then one close-up per step, then the overview again. */
function Rig({ progress, f, onStep }: { progress: MotionValue<number>; f: F; onStep: (i: number) => void }) {
  const { camera } = useThree();
  const p = useRef(0), look = useMemo(() => new THREE.Vector3(), []), from = useMemo(() => new THREE.Vector3(), []);
  const last = useRef(-2);
  const keys = useMemo(() => {
    const overview = { pos: new THREE.Vector3(13, 30, 44), at: new THREE.Vector3(13, 0, -2) };
    // Close-ups: a little above and in front of each module; the guard's four rings need a wider view.
    const steps = STEPS.map((id) => { const [x, , z] = POS[id]; const wide = id === 'gateway' ? 1.45 : 1;
      return { pos: new THREE.Vector3(x - 5 * wide, 8.5 * wide, z + 15 * wide), at: new THREE.Vector3(x, id === 'gateway' ? 3 : 1.8, z) }; });
    return [overview, ...steps, overview];
  }, []);
  useFrame((_, dt) => {
    p.current += (progress.get() - p.current) * Math.min(1, dt * 3.5);
    const s = p.current * (keys.length - 1), i = Math.min(keys.length - 2, Math.floor(s)), u = smooth(s - i);
    from.lerpVectors(keys[i].pos, keys[i + 1].pos, u);
    look.lerpVectors(keys[i].at, keys[i + 1].at, u);
    camera.position.copy(from); camera.lookAt(look);
    // Focus per step: 1 at its close-up, falling to 0 a key away.
    STEPS.forEach((_, k) => { f.current[k] = Math.max(0, 1 - Math.abs(s - (k + 1))); });
    const step = Math.round(s) - 1;
    if (step !== last.current) { last.current = step; onStep(step); }
  });
  return null;
}

export default function SystemModel({ pl, progress, reduce, onStep }: { pl: Pipeline; progress: MotionValue<number>; reduce: boolean; onStep: (i: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const f = useRef<number[]>(STEPS.map(() => 0));
  useEffect(() => {
    const el = host.current; if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && !document.hidden), { threshold: 0 });
    io.observe(el); return () => io.disconnect();
  }, []);
  const layers = [...pl.guard_layers.map((l) => l.label), 'Flow guard'];
  return (
    <div ref={host} className="sm-canvas" aria-hidden="true">
      <Canvas dpr={[1, 1.6]} camera={{ position: [14, 46, 62], fov: 38, near: 0.1, far: 500 }} gl={{ antialias: true, powerPreference: 'high-performance' }}
        frameloop={reduce ? 'demand' : visible ? 'always' : 'never'} onCreated={({ gl, scene }) => { gl.setClearColor('#07080c'); scene.fog = new THREE.Fog('#07080c', 60, 150); }}>
        <ambientLight intensity={0.4} />
        <directionalLight position={[20, 30, 20]} intensity={2.2} />
        <directionalLight position={[-20, 10, -10]} intensity={0.6} color="#7f8cff" />
        <Environment resolution={256}>
          <Lightformer form="rect" intensity={4} color="#ffffff" position={[0, 10, 10]} scale={[20, 4, 1]} />
          <Lightformer form="rect" intensity={3} color="#6b7cff" position={[-10, 2, -6]} scale={[6, 10, 1]} />
          <Lightformer form="rect" intensity={2} color="#ff7aa8" position={[12, 2, -6]} scale={[6, 10, 1]} />
        </Environment>
        <Grid position={[14, 0, 0]} args={[200, 200]} cellSize={1} cellThickness={0.5} cellColor="#1a1d33" sectionSize={6} sectionThickness={1} sectionColor="#2a3170"
          fadeDistance={120} fadeStrength={1.2} infiniteGrid />
        <Node id="browser" f={f}>{(o) => <><Browser open={o} modes={pl.live.modes} /><Label text="Your browser" sub="the Live page" y={5.6} /></>}</Node>
        <Node id="service" f={f}>{(o) => <><Service open={o} modes={pl.live.modes} /><Label text="Live service" sub={`${pl.live.modes.length} modes · limits · key vault`} y={7.6} /></>}</Node>
        <Node id="queue" f={f}>{(o) => <><Queue open={o} workers={pl.live.workers} /><Label text="Job queue" y={4.4} /></>}</Node>
        <Node id="runner" f={f}>{(o) => <><Runner open={o} /><Label text="Runner" sub="one process group per job" y={5.4} /></>}</Node>
        <Node id="fixtures" f={f}>{(o) => <Fixtures open={o} tasks={pl.tasks} attacks={pl.attacks} />}</Node>
        <Node id="agent" f={f}>{(o) => <><Agent open={o} providers={pl.providers} agents={pl.live.agents} /><Label text="Agent" sub={`asks one of ${pl.models.length} models`} y={4.6} /></>}</Node>
        <Node id="arms" f={f}>{() => <Arms />}</Node>
        <Node id="gateway" f={f}>{(o) => <Gateway open={o} layers={layers} />}</Node>
        <Node id="tools" f={f}>{(o) => <Tools open={o} tools={pl.tools} />}</Node>
        <Node id="score" f={f}>{(o) => <Score open={o} />}</Node>
        <Node id="report" f={f}>{(o) => <Report open={o} />}</Node>
        <Links f={f} gates={layers.length} />
        <Rig progress={progress} f={f} onStep={onStep} />
      </Canvas>
    </div>
  );
}
