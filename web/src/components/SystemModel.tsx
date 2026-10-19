// How it works: one real recorded case travelling through the system (react-three-fiber). The case is the home page's
// example (headline.json: the task, the hidden instruction and the tool calls the agent made with and without the guard),
// replayed through eleven stations, built around downloaded models (Sketchfab, CC BY 4.0, lib/models.ts) where one fits:
//   browser   the desktop model showing the Live page, whose Run button sends the job;
//   service   a turnstile under an arc of six limit plates that light as the request passes; a key used once, then gone;
//   queue     one assembly line per lane with the real worker counts, job tiles moving through;
//   runner    a server rack: the cases fall into a fixed order and the seed die locks;
//   fixtures  the case's small world: the task document, a contact, a record, and the document carrying the real hidden text;
//   agent     a humanoid robot bust that turns from the documents to the tools while it thinks, its providers in orbit;
//   arms      the path splits: the baseline rail goes straight to the tools, the defended rail through the guard;
//   gateway   one security arch per guard layer; the refused call shatters on the arch that refused it, with its real code;
//   tools     the tool server ringed by the tools' names; the baseline's forbidden call turns its record panel red;
//   score     three verdict lamps per arm, lit with the recorded verdicts;
//   report    the report sheet drops onto the stack, and the result flies back to the browser.
// Scroll moves the camera from station to station (How.tsx); clicking a station asks the page to scroll there; the replay
// loops on its own clock and restarts from the page's button. Every label and count is from pipeline.json or headline.json.
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Environment, Grid, Html, Lightformer, RoundedBox, useAnimations, useGLTF } from '@react-three/drei';
import { Suspense, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { MotionValue } from 'motion/react';
import * as THREE from 'three';
import type { Headline, Pipeline } from '../lib/data';
import { FluidFX } from './FluidFX';
import { AdaptiveResolution, budgetDpr } from '../lib/gpu';
import { DeviceModel, IMAC, imacTint, screenSize } from './Devices';
import type { HowModelUrls } from '../lib/models';

export const STEPS = ['browser', 'service', 'queue', 'runner', 'fixtures', 'agent', 'arms', 'gateway', 'tools', 'score', 'report'] as const;
export type StepId = (typeof STEPS)[number];
type Example = Headline['example'];

const POS: Record<StepId, [number, number, number]> = {
  browser: [-27, 0, 2], service: [-19, 0, -2.5], queue: [-11, 0, 2], runner: [-3.5, 0, -2.5], fixtures: [4, 0, 2], agent: [11.5, 0, -1],
  arms: [17.5, 0, 0], gateway: [24, 0, 4.4], tools: [31, 0, 0], score: [38, 0, -2.5], report: [45, 0, 1.5],
};
const BLUE = '#2433ff', RED = '#ef3b24', GLOW = '#6b7bff', GREEN = '#35e08a', AMBER = '#ffb547';
const GATE_GAP = 1.5, GATE_Y = 1.5;
const gateX = (i: number, n: number) => POS.gateway[0] + (i - (n - 1) / 2) * GATE_GAP;
const smooth = (t: number) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const span = (t: number, a: number, b: number) => Math.min(1, Math.max(0, (t - a) / (b - a)));
const pretty = (s: string) => s.replaceAll('_', ' ');
type R = React.MutableRefObject<number>;
type F = React.MutableRefObject<number[]>;

/** The replay timeline, in seconds of the loop (LOOP long). */
const TL = { job: [0, 3.2] as const, think: 3.4, call0: 4.2, callGap: 2.1, toArms: 0.7, rail: 1.5, verdict: 11.4, report: 12.6, back: [13.4, 15] as const };
const LOOP = 17;

const metal = (color = '#c9ccd8', rough = 0.25) => new THREE.MeshPhysicalMaterial({ color, metalness: 0.9, roughness: rough, clearcoat: 0.5, clearcoatRoughness: 0.2 });
const dark = (rough = 0.35) => new THREE.MeshPhysicalMaterial({ color: '#15171f', metalness: 0.6, roughness: rough, clearcoat: 0.8, clearcoatRoughness: 0.15 });
const glow = (color: string, k = 1) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), toneMapped: false });

/** Text on a canvas, for documents, plates and screens. */
function textTexture(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d')!; draw(x);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
function wrap(x: CanvasRenderingContext2D, text: string, left: number, top: number, width: number, lh: number, max = 8) {
  const words = text.split(/\s+/); let line = '', y = top, n = 0;
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (x.measureText(t).width > width && line) { x.fillText(line, left, y); line = w; y += lh; if (++n >= max) return y; } else line = t;
  }
  if (line) x.fillText(line, left, y);
  return y + lh;
}
const SANS = '"Google Sans Variable", "Google Sans", system-ui, sans-serif', MONO = '"Google Sans Code Variable", ui-monospace, monospace';

/** Which station a detail tag belongs to, and every station's focus, so a station's small tags show only while the camera
 *  is at it (seen from close by, another station's tags would loom over the caption). Tags outside a station always show. */
const Focus = createContext<{ i: number; f: F } | null>(null);
function Tag({ position, tone = '', children, d = 14 }: { position: [number, number, number]; tone?: string; children: React.ReactNode; d?: number }) {
  const ctx = useContext(Focus);
  const el = useRef<HTMLDivElement>(null);
  useFrame(() => { if (ctx && el.current) { const k = ctx.f.current[ctx.i] ?? 0; el.current.style.opacity = String(Math.min(1, Math.max(0, (k - 0.35) * 3))); } });
  return <Html position={position} center distanceFactor={d} zIndexRange={[4, 0]} className="sm-label-wrap"><div ref={el} className={`sm-tag ${tone}`}>{children}</div></Html>;
}

/** A station's name: shown for every station in the overview, and only for the station in focus in a close-up. */
function Label({ text, sub, y = 3.4, tone }: { text: string; sub?: string; y?: number; tone?: 'red' | 'blue' | 'planned' }) {
  const ctx = useContext(Focus);
  const el = useRef<HTMLDivElement>(null);
  useFrame(() => {
    if (!ctx || !el.current) return;
    const all = Math.max(...ctx.f.current), mine = ctx.f.current[ctx.i] ?? 0;
    el.current.style.opacity = String(Math.max(Math.min(1, Math.max(0, (mine - 0.35) * 3)), Math.min(1, Math.max(0, (0.5 - all) * 4))));
  });
  return (
    <Html position={[0, y, 0]} center distanceFactor={16} zIndexRange={[5, 0]} className="sm-label-wrap">
      <div ref={el} className={`sm-label ${tone ? `is-${tone}` : ''}`}><b>{text}</b>{sub && <span>{sub}</span>}</div>
    </Html>
  );
}

/** A station: a round plinth with a glowing rim (brighter when in focus or hovered); clicking it asks the page to go there. */
function Station({ id, f, onPick, children, r = 3 }: { id: StepId; f: F; onPick: (i: number) => void; children: React.ReactNode; r?: number }) {
  const i = STEPS.indexOf(id);
  const rim = useRef<THREE.Mesh>(null);
  const [hover, setHover] = useState(false);
  const plinth = useMemo(() => dark(0.5), []);
  useFrame(() => { if (rim.current) (rim.current.material as THREE.MeshBasicMaterial).color.set(GLOW).multiplyScalar(0.35 + (f.current[i] ?? 0) * 1.4 + (hover ? 0.8 : 0)); });
  const over = (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'pointer'; };
  const out = () => { setHover(false); document.body.style.cursor = ''; };
  return (
    <group position={POS[id]} onPointerOver={over} onPointerOut={out} onClick={(e) => { e.stopPropagation(); onPick(i); }}>
      <mesh position={[0, -0.12, 0]} material={plinth}><cylinderGeometry args={[r, r * 1.04, 0.24, 64]} /></mesh>
      <mesh ref={rim} position={[0, 0.005, 0]} rotation-x={-Math.PI / 2}><ringGeometry args={[r - 0.06, r, 96]} /><meshBasicMaterial color={GLOW} toneMapped={false} /></mesh>
      <Focus.Provider value={{ i, f }}>{children}</Focus.Provider>
    </group>
  );
}

/** A downloaded model (lib/models.ts): scaled to a height (or to a width along its longest side), standing on the plinth,
 *  turned by rotY, and playing its own animation if it has one. */
function Model({ url, height, width, rotY = 0, pos = [0, 0, 0], tint }: { url: string; height?: number; width?: number; rotY?: number; pos?: [number, number, number]; tint?: (m: THREE.Mesh) => void }) {
  const g = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF(url);
  const model = useMemo(() => { const m = scene.clone(true); if (tint) m.traverse((o) => { if ((o as THREE.Mesh).isMesh) tint(o as THREE.Mesh); }); return m; }, [scene, tint]);
  const fit = useMemo(() => {
    model.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(model), size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const k = height ? height / Math.max(size.y, 1e-6) : (width ?? 1) / Math.max(size.x, size.z, 1e-6);
    return { k, x: -c.x * k, y: -b.min.y * k, z: -c.z * k };
  }, [model, height, width]);
  const { actions } = useAnimations(animations, g);
  useEffect(() => { Object.values(actions).forEach((a) => a?.reset().play()); }, [actions]);
  return <group ref={g} position={pos} rotation-y={rotY}><primitive object={model} scale={fit.k} position={[fit.x, fit.y, fit.z]} /></group>;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. The browser: the desktop model showing the Live page; the Run button pulses as the job is sent.
function Browser({ pl, ex, imacUrl, rt }: { pl: Pipeline; ex: Example; imacUrl: string; rt: R }) {
  const s = screenSize(IMAC, false);
  const tex = useMemo(() => textTexture(1280, 720, (x) => {
    x.fillStyle = '#f0f1fa'; x.fillRect(0, 0, 1280, 720);
    x.fillStyle = '#0d0e13'; x.font = `600 64px ${SANS}`; x.fillText('Run it live', 64, 120);
    x.font = `26px ${SANS}`; x.fillStyle = '#4b4e5f'; x.fillText('Mode', 64, 190);
    pl.live.modes.forEach((m, i) => { x.fillStyle = i === 0 ? '#2b2e3a' : '#e4e6ef'; x.beginPath(); x.roundRect(64 + i * 300, 210, 280, 64, 32); x.fill();
      x.fillStyle = i === 0 ? '#fff' : '#0d0e13'; x.font = `500 26px ${SANS}`; x.fillText(pretty(m.id), 96 + i * 300, 252); });
    const rows: [string, string][] = [['Defense', pretty(pl.live.systems[0] ?? '')], ['Trick written as', pretty(pl.renderings[0] ?? '')], ['Case', ex.case_id]];
    rows.forEach(([k, v], i) => { x.fillStyle = '#4b4e5f'; x.font = `24px ${SANS}`; x.fillText(k, 64, 340 + i * 90);
      x.fillStyle = '#ffffff'; x.beginPath(); x.roundRect(64, 356 + i * 90, 760, 52, 12); x.fill(); x.fillStyle = '#0d0e13'; x.font = `26px ${MONO}`; x.fillText(v, 84, 391 + i * 90); });
    x.fillStyle = BLUE; x.beginPath(); x.roundRect(900, 560, 300, 96, 48); x.fill(); x.fillStyle = '#fff'; x.font = `600 40px ${SANS}`; x.fillText('Run', 1010, 622);
  }), [pl, ex]);
  const btn = useRef<THREE.Mesh>(null);
  useFrame(() => { if (btn.current) { const k = rt.current < 0.6 ? 1 - rt.current / 0.6 : 0; btn.current.scale.setScalar(1 + k * 0.6); (btn.current.material as THREE.MeshBasicMaterial).opacity = k * 0.8; } });
  return (
    <group position={[0, 2.35, 0]} scale={1.15}>
      <DeviceModel url={imacUrl} spec={IMAC} narrow={false} tint={imacTint} />
      <mesh position-z={IMAC.lift + 0.002}><planeGeometry args={[s.sw, s.sh]} /><meshBasicMaterial map={tex} toneMapped={false} /></mesh>
      <mesh ref={btn} position={[s.sw * (1050 / 1280 - 0.5), s.sh * (0.5 - 608 / 720), IMAC.lift + 0.01]}><circleGeometry args={[0.16, 40]} /><meshBasicMaterial color={GLOW} transparent opacity={0} toneMapped={false} /></mesh>
    </group>
  );
}

// 2. The live service: a checkpoint arch with six limit plates that light in turn; a key used once, then gone.
const LIMITS = ['mode', 'defense', 'cases', 'repetitions', 'budget', 'rate'];
function Service({ rt, url }: { rt: R; url: string }) {
  const plates = useRef<(THREE.Mesh | null)[]>([]), key = useRef<THREE.Group>(null);
  const texs = useMemo(() => LIMITS.map((l) => textTexture(256, 96, (x) => { x.fillStyle = '#0f1118'; x.fillRect(0, 0, 256, 96); x.fillStyle = '#e9eaf2'; x.font = `500 34px ${SANS}`; x.textAlign = 'center'; x.fillText(l, 128, 60); })), []);
  const keyGeo = useMemo(() => {
    const ring = new THREE.Shape(); ring.absarc(0, 0, 0.32, 0, Math.PI * 2, false);
    const hole = new THREE.Path(); hole.absarc(0, 0, 0.16, 0, Math.PI * 2, true); ring.holes.push(hole);
    const shaft = new THREE.Shape(); shaft.moveTo(0.28, -0.06); shaft.lineTo(1.3, -0.06); shaft.lineTo(1.3, -0.26); shaft.lineTo(1.18, -0.26); shaft.lineTo(1.18, -0.14); shaft.lineTo(1.04, -0.14); shaft.lineTo(1.04, -0.24); shaft.lineTo(0.92, -0.24); shaft.lineTo(0.92, -0.14); shaft.lineTo(0.28, -0.14); shaft.lineTo(0.28, -0.06);
    return [ring, shaft].map((p) => new THREE.ExtrudeGeometry(p, { depth: 0.08, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 }));
  }, []);
  const mats = useMemo(() => ({ gold: metal('#e8c27a', 0.2), line: glow(GLOW, 1.4), plate: dark(0.3) }), []);
  useFrame(({ clock }) => {
    const t = rt.current, pass = span(t, 0.4, 1.4);
    plates.current.forEach((m, i) => { if (!m) return; const on = pass > (i + 0.5) / LIMITS.length; (m.material as THREE.MeshBasicMaterial).color.set(on ? GREEN : '#ffffff').multiplyScalar(on ? 1.6 : 0.85); });
    if (key.current) {
      // The key you bring: it slides into the arch with the request and dissolves once the run has it (never stored).
      const k = span(t, 0.2, 1.2), d = span(t, 1.3, 2.2);
      key.current.position.set(-2.4 + k * 2.4, 1.2 + Math.sin(clock.elapsedTime * 2) * 0.05, 0.6);
      key.current.rotation.set(0, 0, Math.sin(clock.elapsedTime) * 0.1);
      key.current.scale.setScalar(Math.max(0.001, 0.9 * (1 - d)));
    }
  });
  return (
    <group>
      <Model url={url} height={2.1} rotY={Math.PI / 2} />
      <mesh material={mats.line} position-y={0.3}><torusGeometry args={[2.55, 0.015, 8, 96, Math.PI]} /></mesh>
      {LIMITS.map((l, i) => {
        const a = Math.PI * (0.1 + (0.8 * i) / (LIMITS.length - 1));
        return (
          <group key={l} position={[Math.cos(a) * 2.55, 0.3 + Math.sin(a) * 2.55, 0]} rotation-z={a - Math.PI / 2}>
            <RoundedBox args={[1.1, 0.42, 0.08]} radius={0.06} material={mats.plate} />
            <mesh position-z={0.05}><planeGeometry args={[1, 0.36]} /><meshBasicMaterial map={texs[i]} toneMapped={false} /></mesh>
            <mesh ref={(el) => { plates.current[i] = el; }} position={[0.62, 0, 0.05]}><circleGeometry args={[0.06, 20]} /><meshBasicMaterial toneMapped={false} /></mesh>
          </group>
        );
      })}
      <group ref={key}>{keyGeo.map((g, i) => <mesh key={i} geometry={g} material={mats.gold} />)}</group>
    </group>
  );
}

// 3. The job queue: one lane per kind of job with its real number of workers; job tiles slide toward the workers.
const LANE = 2.7;   // apart enough that the two assembly lines do not overlap
function Queue({ workers, rt, url }: { workers: Record<string, number>; rt: R; url: string }) {
  const lanes = Object.entries(workers);
  const tiles = useRef<(THREE.Group | null)[]>([]);
  const jobTex = useMemo(() => textTexture(192, 96, (x) => { x.fillStyle = '#1b1e2a'; x.fillRect(0, 0, 192, 96); x.fillStyle = '#9aa4ff'; x.font = `500 30px ${MONO}`; x.textAlign = 'center'; x.fillText('job', 96, 60); }), []);
  const ourTex = useMemo(() => textTexture(192, 96, (x) => { x.fillStyle = BLUE; x.fillRect(0, 0, 192, 96); x.fillStyle = '#fff'; x.font = `600 28px ${MONO}`; x.textAlign = 'center'; x.fillText('your job', 96, 60); }), []);
  const mats = useMemo(() => ({ worker: metal('#dfe3f2', 0.15), ring: glow(GREEN, 1.4), tile: dark(0.3) }), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    tiles.current.forEach((g, k) => { if (!g || k === 0) return; const lane = k % lanes.length, idx = Math.floor(k / lanes.length);
      const u = ((t * 0.25 + idx / 4 + lane * 0.13) % 1); g.position.set(-2.2 + u * 3.6, 0.35, (lane - (lanes.length - 1) / 2) * LANE); g.scale.setScalar(u > 0.85 ? (1 - u) / 0.15 : 1); });
    const ours = tiles.current[0]; if (ours) { const u = span(rt.current, 0.9, 1.9); ours.position.set(-2.2 + u * 3.6, 0.45, -(lanes.length - 1) / 2 * LANE); ours.scale.setScalar(u > 0 && u < 1 ? 1.15 : 0.001); }
  });
  return (
    <group>
      {lanes.map(([name, n], li) => {
        const z = (li - (lanes.length - 1) / 2) * LANE;
        return (
          <group key={name}>
            <Model url={url} width={3.8} pos={[-0.3, 0, z]} />
            {Array.from({ length: n }, (_, wi) => (
              <group key={wi} position={[2.15, 0.6, z + (wi - (n - 1) / 2) * 0.5]}>
                <mesh material={mats.worker}><sphereGeometry args={[0.2, 24, 24]} /></mesh>
                <mesh rotation-x={Math.PI / 2} material={mats.ring}><torusGeometry args={[0.3, 0.025, 8, 40]} /></mesh>
              </group>
            ))}
            <Tag position={[-2.9, 0.4, z]}>{name} · {n} worker{n > 1 ? 's' : ''}</Tag>
          </group>
        );
      })}
      {Array.from({ length: 8 }, (_, k) => (
        <group key={k} ref={(el) => { tiles.current[k] = el; }}>
          <RoundedBox args={[0.62, 0.08, 0.42]} radius={0.04} material={mats.tile} />
          <mesh position-y={0.045} rotation-x={-Math.PI / 2}><planeGeometry args={[0.56, 0.3]} /><meshBasicMaterial map={k === 0 ? ourTex : jobTex} toneMapped={false} /></mesh>
        </group>
      ))}
    </group>
  );
}

// 4. The runner: a glass capsule in which the cases fall into a fixed order and the seed die locks.
function Runner({ rt, url }: { rt: R; url: string }) {
  const cards = useRef<(THREE.Mesh | null)[]>([]), die = useRef<THREE.Mesh>(null);
  const tex = useMemo(() => Array.from({ length: 6 }, (_, i) => textTexture(128, 160, (x) => { x.fillStyle = '#f2f3fa'; x.fillRect(0, 0, 128, 160); x.fillStyle = '#0d0e13'; x.font = `600 64px ${SANS}`; x.textAlign = 'center'; x.fillText(String(i + 1), 64, 100); })), []);
  const shuffled = [3, 0, 5, 1, 4, 2];
  const mats = useMemo(() => ({
    die: glow(AMBER, 1.3),
  }), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime, order = smooth(span(rt.current, 1.6, 2.6));
    cards.current.forEach((m, i) => { if (!m) return; const x = (THREE.MathUtils.lerp(shuffled[i], i, order) - 2.5) * 0.42;
      m.position.set(x, 1.1 + Math.sin(t * 2 + i) * 0.06 * (1 - order), 0.55); m.rotation.z = (1 - order) * Math.sin(i * 7) * 0.4; });
    if (die.current) { die.current.rotation.set(t * 2 * (1 - order), t * 3 * (1 - order), 0); die.current.position.set(0, 3.05 + Math.sin(t * 3) * 0.05 * (1 - order), -0.3); }
  });
  return (
    <group>
      <Model url={url} height={2.7} pos={[0, 0, -0.6]} />
      {tex.map((t, i) => <mesh key={i} ref={(el) => { cards.current[i] = el; }}><planeGeometry args={[0.34, 0.44]} /><meshBasicMaterial map={t} side={THREE.DoubleSide} toneMapped={false} /></mesh>)}
      <mesh ref={die} position={[0, 2.25, 0]} material={mats.die}><icosahedronGeometry args={[0.22, 0]} /></mesh>
    </group>
  );
}

// 5. The fixtures: the case's own small world, written from the recorded case.
function Fixtures({ ex }: { ex: Example }) {
  const docs = useMemo(() => {
    const paper = (title: string, body: string, hidden?: string) => textTexture(512, 660, (x) => {
      x.fillStyle = '#f7f8fc'; x.fillRect(0, 0, 512, 660); x.fillStyle = '#0d0e13'; x.font = `600 30px ${SANS}`; x.fillText(title, 32, 60);
      x.fillStyle = '#4b4e5f'; x.font = `22px ${SANS}`; const y = wrap(x, body, 32, 110, 448, 32, 7);
      if (hidden) { x.fillStyle = 'rgba(239,59,36,0.12)'; x.fillRect(20, y - 4, 472, 300); x.fillStyle = RED; x.font = `20px ${MONO}`; wrap(x, hidden, 32, y + 26, 448, 28, 9); }
    });
    return [
      { tex: paper('The task', ex.task), pos: [-1.9, 1.6, 0.4] as [number, number, number], rot: 0.35, evil: false },
      { tex: paper('A contact', 'A name, an address and a phone number: something the helper may look up if the task needs it.'), pos: [-0.65, 1.75, -0.3] as [number, number, number], rot: 0.12, evil: false },
      { tex: paper('A record', 'The record the task is about: its tier, its owner and its last review.'), pos: [0.6, 1.7, -0.3] as [number, number, number], rot: -0.12, evil: false },
      { tex: paper('A document', 'Background reading the helper is given for the task. Hidden in it:', ex.hidden_text), pos: [1.9, 1.6, 0.4] as [number, number, number], rot: -0.35, evil: true },
    ];
  }, [ex]);
  const refs = useRef<(THREE.Group | null)[]>([]);
  const halo = useMemo(() => glow(RED, 1.8), []);
  useFrame(({ clock }) => { const t = clock.elapsedTime; refs.current.forEach((d, i) => { if (d) d.position.y = docs[i].pos[1] + Math.sin(t * 1.3 + i) * 0.08; }); });
  return (
    <group>
      {docs.map((d, i) => (
        <group key={i} ref={(el) => { refs.current[i] = el; }} position={d.pos} rotation-y={d.rot}>
          <mesh><planeGeometry args={[1.15, 1.48]} /><meshBasicMaterial map={d.tex} side={THREE.DoubleSide} toneMapped={false} /></mesh>
          {d.evil && <mesh position-z={-0.01} material={halo}><planeGeometry args={[1.24, 1.57]} /></mesh>}
        </group>
      ))}
      <Tag position={[1.9, 0.55, 0.5]} tone="is-red">hidden instruction</Tag>
    </group>
  );
}

// 6. The agent: a model core that reads the documents and answers with tool calls; providers in orbit; planned agents dashed.
function Agent({ pl, rt, url }: { pl: Pipeline; rt: R; url: string }) {
  const head = useRef<THREE.Group>(null), orbit = useRef<THREE.Group>(null), light = useRef<THREE.PointLight>(null);
  const mats = useMemo(() => ({ ring: glow(GLOW, 1.2), chip: metal('#dfe3f2', 0.15) }), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime, r = rt.current;
    const thinking = r > TL.think - 0.3 && r < TL.call0 + TL.callGap * 3 ? 1 : 0;
    // The helper turns its head from the documents to the tools while it thinks, and a blue light breathes on its face.
    if (head.current) { head.current.rotation.y = -0.5 + Math.sin(t * 0.6) * 0.18 + thinking * 0.35 * Math.sin(t * 1.4); head.current.position.y = Math.sin(t * 0.9) * 0.04; }
    if (light.current) light.current.intensity = 6 + thinking * (10 + Math.sin(t * 9) * 4);
    if (orbit.current) orbit.current.rotation.y = t * 0.4;
  });
  return (
    <group position-y={1.9}>
      <group ref={head} position-y={-1.9}><Model url={url} height={2.35} /></group>
      <pointLight ref={light} position={[0.6, 0.6, 1.6]} color="#7f8fff" distance={6} intensity={6} />
      <mesh rotation-x={Math.PI / 2} position-y={-0.4} material={mats.ring}><torusGeometry args={[1.75, 0.015, 8, 96]} /></mesh>
      <group ref={orbit}>
        {pl.providers.map((p, i) => {
          const a = (i / pl.providers.length) * Math.PI * 2;
          return (
            <group key={p} position={[Math.cos(a) * 1.75, -0.4, Math.sin(a) * 1.75]}>
              <mesh material={mats.chip}><cylinderGeometry args={[0.24, 0.24, 0.14, 6]} /></mesh>
              <Tag position={[0, 0.45, 0]}>{p}</Tag>
            </group>
          );
        })}
      </group>
      {pl.live.agents.filter((a) => a.status === 'planned').map((a, i) => (
        <group key={a.id} position={[-2.2 + i * 4.4, -1.2, 1.7]}>
          <mesh rotation-x={-Math.PI / 2}><ringGeometry args={[0.42, 0.48, 48]} /><meshBasicMaterial color="#8a8da0" transparent opacity={0.6} /></mesh>
          <Tag position={[0, 0.35, 0]} tone="is-planned">planned: {pretty(a.id)}</Tag>
        </group>
      ))}
    </group>
  );
}

// 8. The guard: one ring per layer on the defended rail, each with a faint membrane; the refusing ring flashes red.
function Gateway({ layers, refusedAt, rt, hitT, url }: { layers: string[]; refusedAt: number; rt: R; hitT: number; url: string }) {
  const mem = useMemo(() => layers.map(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, uniforms: { uHit: { value: 0 }, uColor: { value: new THREE.Color(GLOW) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec2 vUv; uniform float uHit; uniform vec3 uColor; void main(){ float d = length(vUv - 0.5) * 2.0; float a = smoothstep(1.0, 0.6, d) * (0.08 + uHit * 0.6) + smoothstep(0.85, 1.0, d) * 0.25; vec3 c = mix(uColor, vec3(1.0, 0.23, 0.14), uHit); gl_FragColor = vec4(c * a, a); }',
  })), [layers]);
  const mats = useMemo(() => ({ line: glow(GLOW, 1.4), red: glow(RED, 1.4) }), []);
  useFrame(() => { mem.forEach((m, i) => { m.uniforms.uHit.value = i === refusedAt ? Math.max(0, 1 - Math.abs(rt.current - hitT) * 1.5) : 0; }); });
  return (
    <group>
      {layers.map((l, i) => (
        <group key={l} position={[gateX(i, layers.length) - POS.gateway[0], 0, 0]} rotation-y={Math.PI / 2 - 1.2}>
          {/* Turned partly toward the camera so the arch reads as a frame; the rail still passes through its opening. */}
          <Model url={url} height={2.5} />
          <mesh material={i === refusedAt ? mats.red : mats.line} position={[0, 2.55, 0]}><boxGeometry args={[1.1, 0.03, 0.03]} /></mesh>
          <mesh material={mem[i]} position-y={GATE_Y}><planeGeometry args={[0.9, 2]} /></mesh>
          <Tag position={[0, 2.95, 0]} tone={`${i === refusedAt ? 'is-red' : ''}`}>{i + 1}. {l}</Tag>
        </group>
      ))}
    </group>
  );
}

// 9. The tool service: the tools around the case's own database; a record in it turns red when the baseline's forbidden
// call lands.
function Tools({ tools, forbidden, rt, landT, url }: { tools: string[]; forbidden: string; rt: R; landT: number; url: string }) {
  const ring = useRef<THREE.Group>(null), slab = useRef<THREE.Mesh>(null);
  const chips = useMemo(() => tools.map((t) => textTexture(320, 80, (x) => { x.fillStyle = t === forbidden ? '#2a1110' : '#14161f'; x.fillRect(0, 0, 320, 80);
    x.fillStyle = t === forbidden ? '#ff8a7a' : '#dfe3f2'; x.font = `500 26px ${MONO}`; x.textAlign = 'center'; x.fillText(pretty(t), 160, 50); })), [tools, forbidden]);
  const mats = useMemo(() => ({ red: glow(RED, 1.8), plain: glow('#3a3f55', 1), chip: dark(0.3) }), []);
  useFrame(({ clock }) => {
    if (ring.current) ring.current.rotation.y = clock.elapsedTime * 0.12;
    if (slab.current) slab.current.material = rt.current > landT && rt.current < LOOP - 0.5 ? mats.red : mats.plain;
  });
  return (
    <group>
      <Model url={url} height={2.6} rotY={-Math.PI / 2} />
      {/* The record the forbidden call reads: a panel on the machine that turns red when that call lands. */}
      <mesh ref={slab} position={[0, 1.3, 0.95]} material={mats.plain}><boxGeometry args={[0.9, 0.22, 0.05]} /></mesh>
      <Tag position={[0, 3, 0]}>the tool service and the case's database</Tag>
      <group ref={ring} position-y={1}>
        {tools.map((t, i) => {
          const a = (i / tools.length) * Math.PI * 2;
          return (
            <group key={t} position={[Math.cos(a) * 2.5, Math.sin(i * 1.7) * 0.25, Math.sin(a) * 2.5]} rotation-y={-a + Math.PI / 2}>
              <RoundedBox args={[1.1, 0.3, 0.06]} radius={0.04} material={mats.chip} />
              <mesh position-z={0.035}><planeGeometry args={[1.02, 0.25]} /><meshBasicMaterial map={chips[i]} toneMapped={false} /></mesh>
            </group>
          );
        })}
      </group>
    </group>
  );
}

// 10. The scorer: three lamps per arm, lit with the recorded verdicts.
function Score({ ex, rt }: { ex: Example; rt: R }) {
  const lamps = useRef<(THREE.Mesh | null)[]>([]);
  const rows: [string, Example['without_guard']][] = [['without the guard', ex.without_guard], ['with the guard', ex.with_guard]];
  const verdicts = (s: Example['without_guard']) => [
    { name: 'job done', good: s.utility_pass }, { name: 'nothing unsafe', good: s.security_pass }, { name: 'attacker goal', good: !s.attacker_goal_achieved },
  ];
  const base = useMemo(() => metal('#9aa0b4'), []);
  useFrame(() => {
    const on = rt.current > TL.verdict;
    lamps.current.forEach((m, k) => { if (!m) return; const v = verdicts(rows[Math.floor(k / 3)][1])[k % 3];
      (m.material as THREE.MeshBasicMaterial).color.set(on ? (v.good ? GREEN : RED) : '#2a2d3a').multiplyScalar(on ? 1.6 : 1); });
  });
  return (
    <group>
      {rows.map(([label, s], r) => (
        <group key={label} position={[0, 0.9 + r * 1.35, 0]}>
          <Tag position={[-2.5, 0.05, 0]} tone={`${r === 0 ? 'is-red' : 'is-blue'}`}>{label}</Tag>
          {verdicts(s).map((v, k) => (
            <group key={k} position={[(k - 1) * 1.15, 0, 0]}>
              <mesh position-y={-0.18} material={base}><cylinderGeometry args={[0.32, 0.38, 0.22, 32]} /></mesh>
              <mesh ref={(el) => { lamps.current[r * 3 + k] = el; }} position-y={0.12}><sphereGeometry args={[0.26, 32, 32]} /><meshBasicMaterial toneMapped={false} /></mesh>
              {r === 1 && <Tag position={[0, k % 2 ? 0.95 : 0.68, 0]}>{v.name}</Tag>}
            </group>
          ))}
        </group>
      ))}
    </group>
  );
}

// 11. The report: the sheet drops onto the stack of reports, then the result flies back to the browser.
function Report({ pl, ex, rt }: { pl: Pipeline; ex: Example; rt: R }) {
  const sheet = useRef<THREE.Group>(null);
  const tex = useMemo(() => textTexture(512, 660, (x) => {
    x.fillStyle = '#f7f8fc'; x.fillRect(0, 0, 512, 660); x.fillStyle = '#0d0e13'; x.font = `600 32px ${SANS}`; x.fillText('Report', 32, 64);
    x.font = `19px ${MONO}`; let y = 112;
    for (const [k, s] of [['without guard', ex.without_guard], ['with guard', ex.with_guard]] as const) {
      x.fillStyle = '#0d0e13'; x.fillText(`${k}:`, 32, y); y += 30;
      for (const t of s.tools) { x.fillStyle = t.status === 'failed' ? RED : '#4b4e5f'; x.fillText(`  ${t.tool} ${t.status}${t.error ? ` (${t.error})` : ''}`, 32, y); y += 28; }
      y += 16;
    }
    x.fillStyle = '#8a8da0'; x.fillText('every report is hashed', 32, 620);
  }), [ex]);
  const paper = useMemo(() => new THREE.MeshStandardMaterial({ color: '#e9ebf4', roughness: 0.6, side: THREE.DoubleSide }), []);
  useFrame(() => { if (!sheet.current) return; const d = smooth(span(rt.current, TL.report, TL.report + 0.8)); sheet.current.position.y = 4.2 - d * 2.9; sheet.current.rotation.x = -Math.PI / 2 + (1 - d) * 1.2; sheet.current.visible = rt.current > TL.report - 0.05; });
  return (
    <group>
      {Array.from({ length: 10 }, (_, i) => <mesh key={i} position={[Math.sin(i * 3.1) * 0.05, 0.05 + i * 0.12, Math.cos(i * 2.3) * 0.05]} rotation-x={-Math.PI / 2} rotation-z={i * 0.07} material={paper}><planeGeometry args={[1.5, 1.95]} /></mesh>)}
      <group ref={sheet} position={[0, 4, 0]}><mesh><planeGeometry args={[1.5, 1.95]} /><meshBasicMaterial map={tex} side={THREE.DoubleSide} toneMapped={false} /></mesh></group>
      <Tag position={[0, 2.9, 0]}>{pl.reports} reports · {pl.runs.toLocaleString('en')} runs</Tag>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The rails and the replayed packets.
function makeRails(gates: number) {
  const v = (id: StepId, y = 0.55, dz = 0) => new THREE.Vector3(POS[id][0], y, POS[id][2] + dz);
  const C = (pts: THREE.Vector3[]) => new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const main = C([v('browser', 0.55, 2.2), v('service', 1.2), v('queue', 0.6), v('runner', 1.5), v('fixtures', 1.2), v('agent', 1.9)]);
  const toArms = C([v('agent', 1.9), v('arms', 0.6)]);
  const gx0 = gateX(0, gates), gx1 = gateX(gates - 1, gates), gz = POS.gateway[2];
  const defended = C([v('arms', 0.6), new THREE.Vector3(gx0 - 2.2, GATE_Y, gz), new THREE.Vector3(gx0, GATE_Y, gz), new THREE.Vector3(gx1, GATE_Y, gz), new THREE.Vector3(gx1 + 2.2, GATE_Y, gz), v('tools', 1.2, 0.6)]);
  const baseline = C([v('arms', 0.6), new THREE.Vector3(POS.arms[0] + 3, 0.6, -4.2), new THREE.Vector3(POS.tools[0] - 3.4, 0.6, -4.2), v('tools', 1.2, -0.6)]);
  const out = C([v('tools', 1.2), v('score', 1.2), v('report', 1.4)]);
  const back = C([v('report', 2), new THREE.Vector3(POS.report[0] - 10, 13, -10), new THREE.Vector3(POS.browser[0] + 12, 13, -10), v('browser', 6.4, -1.8)]);
  // Where a call refused by layer i stops on the defended rail: the point nearest that ring's centre.
  const stopAt = (i: number) => { const g = new THREE.Vector3(gateX(i, gates), GATE_Y, gz); let best = 1e9, at = 0.5; for (let k = 0; k <= 600; k++) { const d = defended.getPointAt(k / 600).distanceTo(g); if (d < best) { best = d; at = k / 600; } } return at; };
  return { main, toArms, defended, baseline, out, back, stopAt };
}
type Rails = ReturnType<typeof makeRails>;

function RailTubes({ r }: { r: Rails }) {
  const tube = (c: THREE.Curve<THREE.Vector3>, rad = 0.045) => new THREE.TubeGeometry(c, 160, rad, 8, false);
  const g = useMemo(() => ({ main: tube(r.main), toArms: tube(r.toArms), defended: tube(r.defended), baseline: tube(r.baseline), out: tube(r.out), back: tube(r.back, 0.03) }), [r]);
  const m = useMemo(() => ({ glow: glow(GLOW, 0.8), blue: glow(BLUE, 1.6), red: glow(RED, 1.1), back: new THREE.MeshBasicMaterial({ color: '#9aa4ff', transparent: true, opacity: 0.35, toneMapped: false }) }), []);
  return (
    <group>
      <mesh geometry={g.main} material={m.glow} /><mesh geometry={g.toArms} material={m.glow} />
      <mesh geometry={g.defended} material={m.blue} /><mesh geometry={g.baseline} material={m.red} />
      <mesh geometry={g.out} material={m.glow} /><mesh geometry={g.back} material={m.back} />
    </group>
  );
}

type Call = { tool: string; denied: boolean; reason: string | null };
/** The replayed case: the job travels to the agent; each recorded tool call leaves the agent and runs down both arms; the
 *  defended copy of the refused call shatters on the ring that refused it; verdicts light; the report returns. */
function Packets({ r, calls, stop, rt }: { r: Rails; calls: Call[]; stop: number; rt: R }) {
  const job = useRef<THREE.Mesh>(null), back = useRef<THREE.Mesh>(null), out = useRef<THREE.Mesh>(null);
  const meshes = useRef<(THREE.Group | null)[]>([]);
  const shards = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const dirs = useMemo(() => Array.from({ length: 40 }, (_, i) => new THREE.Vector3(Math.sin(i * 12.9898) , Math.abs(Math.cos(i * 4.1414)) - 0.2, Math.sin(i * 78.233)).normalize().multiplyScalar(0.8 + ((i * 37) % 10) / 7)), []);
  const [refusal, setRefusal] = useState(false);
  const deniedIdx = calls.findIndex((c) => c.denied);
  const mats = useMemo(() => ({ white: glow('#ffffff', 2), head: glow('#ffffff', 1.6), red: glow(RED, 1.6), blue: glow('#8fa0ff', 1.6), amber: glow(AMBER, 1.8), shard: glow(RED, 2), green: glow(GREEN, 1.8) }), []);
  useFrame(() => {
    const t = rt.current;
    if (job.current) { const u = span(t, TL.job[0], TL.job[1]); job.current.visible = u > 0 && u < 1; job.current.position.copy(r.main.getPointAt(smooth(u))); }
    calls.forEach((c, i) => {
      const t0 = TL.call0 + i * TL.callGap, a = span(t, t0, t0 + TL.toArms), b = span(t, t0 + TL.toArms, t0 + TL.toArms + TL.rail);
      const head = meshes.current[i * 3], base = meshes.current[i * 3 + 1], def = meshes.current[i * 3 + 2];
      if (head) { head.visible = a > 0 && a < 1; head.position.copy(r.toArms.getPointAt(a)); }
      if (base) { base.visible = b > 0 && b < 1; base.position.copy(r.baseline.getPointAt(b)); }
      if (def) { const u = c.denied ? Math.min(b, stop) : b; def.visible = b > 0 && (c.denied ? b < stop : b < 1); def.position.copy(r.defended.getPointAt(u)); }
    });
    if (deniedIdx >= 0 && shards.current) {
      const hit = TL.call0 + deniedIdx * TL.callGap + TL.toArms + TL.rail * stop, s = span(t, hit, hit + 1.2), at = r.defended.getPointAt(stop);
      dirs.forEach((d, j) => { tmp.position.copy(at).addScaledVector(d, s * 1.6); tmp.position.y -= s * s * 0.8; tmp.rotation.set(s * 6 + j, s * 4, 0); tmp.scale.setScalar(s > 0 && s < 1 ? 0.07 * (1 - s) : 0); tmp.updateMatrix(); shards.current!.setMatrixAt(j, tmp.matrix); });
      shards.current.instanceMatrix.needsUpdate = true;
      const show = t > hit && t < hit + 2.6; if (show !== refusal) setRefusal(show);
    }
    if (out.current) { const u = span(t, TL.verdict - 1.2, TL.report); out.current.visible = u > 0 && u < 1; out.current.position.copy(r.out.getPointAt(smooth(u))); }
    if (back.current) { const u = span(t, TL.back[0], TL.back[1]); back.current.visible = u > 0 && u < 1; back.current.position.copy(r.back.getPointAt(smooth(u))); }
  });
  const tag = (tool: string, tone: string) => <Html position={[0, 0.42, 0]} center distanceFactor={12} zIndexRange={[6, 0]} className="sm-label-wrap"><div className={`sm-tag ${tone}`}>{pretty(tool)}</div></Html>;
  const ball = (m: THREE.Material) => <mesh material={m}><sphereGeometry args={[0.2, 20, 20]} /></mesh>;
  return (
    <group>
      <mesh ref={job} material={mats.white}><sphereGeometry args={[0.3, 24, 24]} /></mesh>
      {calls.map((c, i) => [
        <group key={`h${i}`} ref={(el) => { meshes.current[i * 3] = el; }} visible={false}>{ball(mats.head)}{tag(c.tool, '')}</group>,
        <group key={`b${i}`} ref={(el) => { meshes.current[i * 3 + 1] = el; }} visible={false}>{ball(mats.red)}{tag(c.tool, 'is-red')}</group>,
        <group key={`d${i}`} ref={(el) => { meshes.current[i * 3 + 2] = el; }} visible={false}>{ball(c.denied ? mats.amber : mats.blue)}{tag(c.tool, 'is-blue')}</group>,
      ])}
      <instancedMesh ref={shards} args={[undefined, undefined, dirs.length]} frustumCulled={false} material={mats.shard}><tetrahedronGeometry args={[1, 0]} /></instancedMesh>
      {refusal && deniedIdx >= 0 && (
        <group position={r.defended.getPointAt(stop).toArray()}>
          <Html position={[0, -1.35, 0]} center distanceFactor={12} zIndexRange={[7, 0]} className="sm-label-wrap"><div className="sm-tag is-red">refused: {calls[deniedIdx].reason}</div></Html>
        </group>
      )}
      <mesh ref={out} material={mats.white}><sphereGeometry args={[0.24, 20, 20]} /></mesh>
      <mesh ref={back} material={mats.green}><sphereGeometry args={[0.28, 24, 24]} /></mesh>
    </group>
  );
}

/** The replay clock: loops on its own, restarts when the page's button bumps `replay`. */
function Clock({ rt, replay }: { rt: R; replay: number }) {
  useEffect(() => { rt.current = 0; }, [replay, rt]);
  useFrame((_, dt) => { rt.current += Math.min(dt, 0.1); if (rt.current > LOOP) rt.current = 0; });
  return null;
}

/** The camera: an overview of the whole system, then a close-up per station, then the overview again. */
function Rig({ progress, f, onStep }: { progress: MotionValue<number>; f: F; onStep: (i: number) => void }) {
  const { camera, size } = useThree();
  const p = useRef(0), look = useMemo(() => new THREE.Vector3(), []), from = useMemo(() => new THREE.Vector3(), []), last = useRef(-2);
  const keys = useMemo(() => {
    const overview = { pos: new THREE.Vector3(9, 42, 34), at: new THREE.Vector3(9, 0, 1) };
    const close = STEPS.map((id) => {
      const [x, , z] = POS[id];
      const wide = id === 'gateway' ? 1.25 : id === 'arms' ? 1.7 : id === 'browser' ? 1.15 : 1;
      const at = id === 'arms' ? new THREE.Vector3(x + 3.5, 1, z) : new THREE.Vector3(x, id === 'browser' ? 2.4 : 1.6, z);
      return { pos: new THREE.Vector3(at.x - 3.5 * wide, 5.2 * wide, z + 10.5 * wide), at };
    });
    return [overview, ...close, overview];
  }, []);
  useFrame((_, dt) => {
    p.current += (progress.get() - p.current) * Math.min(1, dt * 3.5);
    const s = p.current * (keys.length - 1), i = Math.min(keys.length - 2, Math.floor(s)), u = smooth(s - i);
    from.lerpVectors(keys[i].pos, keys[i + 1].pos, u); look.lerpVectors(keys[i].at, keys[i + 1].at, u);
    const aspect = size.width / Math.max(1, size.height);
    if (aspect < 0.85) { const k = 1 + (0.85 - aspect) * 2.2; from.sub(look).multiplyScalar(k).add(look); look.y -= 2.2 * k; }
    // On a wide screen the caption fills the lower left: aim left of and below a station so it sits up and to the right.
    if (aspect > 1.1) { const k = Math.min(1, s, keys.length - 1 - s); look.x -= 3.4 * k; look.y -= 0.6 * k; from.x -= 3.4 * k; }
    camera.position.copy(from); camera.lookAt(look);
    STEPS.forEach((_, k) => { f.current[k] = Math.max(0, 1 - Math.abs(s - (k + 1))); });
    const step = Math.round(s) - 1;
    if (step !== last.current) { last.current = step; onStep(step); }
  });
  return null;
}

export type SystemModelProps = { pl: Pipeline; ex: Example; imacUrl: string; models: HowModelUrls; progress: MotionValue<number>; reduce: boolean; onStep: (i: number) => void; onPick: (i: number) => void; replay: number };

export default function SystemModel({ pl, ex, imacUrl, models, progress, reduce, onStep, onPick, replay }: SystemModelProps) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [dpr] = useState(() => budgetDpr(2.2e6, 1.6));
  const f = useRef<number[]>(STEPS.map(() => 0));
  const rt = useRef(0);
  useEffect(() => {
    const el = host.current; if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && !document.hidden), { threshold: 0 });
    io.observe(el); return () => { io.disconnect(); document.body.style.cursor = ''; };
  }, []);
  const layers = useMemo(() => [...pl.guard_layers.map((l) => l.label), 'Flow guard'], [pl]);
  // The recorded calls, and the layer that refused one, from its denial code (the flow guard's codes start with untrusted_flow).
  const calls: Call[] = useMemo(() => ex.with_guard.tools.map((t, i) => ({ tool: t.tool, denied: ex.with_guard.decisions[i]?.decision === 'deny', reason: ex.with_guard.decisions[i]?.reason ?? null })), [ex]);
  const denied = calls.find((c) => c.denied);
  const byCode = pl.guard_layers.findIndex((l) => l.denies_with === denied?.reason);
  const refusedAt = byCode >= 0 ? byCode : denied?.reason?.startsWith('untrusted_flow') ? layers.length - 1 : 0;
  const rails = useMemo(() => makeRails(layers.length), [layers.length]);
  const stop = useMemo(() => rails.stopAt(refusedAt), [rails, refusedAt]);
  const deniedIdx = calls.findIndex((c) => c.denied);
  const hitT = TL.call0 + Math.max(0, deniedIdx) * TL.callGap + TL.toArms + TL.rail * stop;
  const landT = TL.call0 + Math.max(0, deniedIdx) * TL.callGap + TL.toArms + TL.rail;
  return (
    <div ref={host} className="sm-canvas">
      <Canvas dpr={dpr} camera={{ position: [9, 34, 46], fov: 38, near: 0.1, far: 400 }} gl={{ antialias: true, powerPreference: 'high-performance' }}
        frameloop={reduce ? 'demand' : visible ? 'always' : 'never'} onCreated={({ gl, scene }) => { gl.setClearColor('#07080c'); scene.fog = new THREE.Fog('#07080c', 50, 130); }}>
        <AdaptiveResolution base={dpr} />
        <ambientLight intensity={0.45} />
        <directionalLight position={[20, 30, 20]} intensity={2.2} />
        <directionalLight position={[-20, 10, -10]} intensity={0.6} color="#7f8cff" />
        <Environment resolution={256} frames={1}>
          <Lightformer form="rect" intensity={4} color="#ffffff" position={[0, 10, 10]} scale={[20, 4, 1]} />
          <Lightformer form="rect" intensity={3} color="#6b7cff" position={[-10, 2, -6]} scale={[6, 10, 1]} />
          <Lightformer form="rect" intensity={2} color="#ff7aa8" position={[12, 2, -6]} scale={[6, 10, 1]} />
        </Environment>
        <Grid position={[9, -0.25, 0]} args={[200, 200]} cellSize={1} cellThickness={0.5} cellColor="#161a30" sectionSize={6} sectionThickness={1} sectionColor="#262d66" fadeDistance={110} fadeStrength={1.2} infiniteGrid />
        <Clock rt={rt} replay={replay} />
        <Suspense fallback={null}>
        <Station id="browser" f={f} onPick={onPick} r={3.2}><Browser pl={pl} ex={ex} imacUrl={imacUrl} rt={rt} /><Label text="1 · Your browser" sub="the Live page sends the job" y={5.4} /></Station>
        <Station id="service" f={f} onPick={onPick}><Service rt={rt} url={models.turnstile} /><Label text="2 · Live service" sub="checks every limit; your key is used once" y={4.2} /></Station>
        <Station id="queue" f={f} onPick={onPick}><Queue workers={pl.live.workers} rt={rt} url={models.assembly} /><Label text="3 · Job queue" sub="a fixed number of workers per lane" y={2.6} /></Station>
        <Station id="runner" f={f} onPick={onPick}><Runner rt={rt} url={models.rack} /><Label text="4 · Runner" sub="case order and seeds fixed first" y={3.4} /></Station>
        <Station id="fixtures" f={f} onPick={onPick}><Fixtures ex={ex} /><Label text="5 · The case's world" sub={`${pl.tasks} tasks · ${pl.attacks} attacks`} y={3.3} /></Station>
        <Station id="agent" f={f} onPick={onPick}><Agent pl={pl} rt={rt} url={models.robot} /><Label text="6 · Agent" sub={`asks one of ${pl.models.length} models`} y={4.2} /></Station>
        <Station id="arms" f={f} onPick={onPick} r={2}><Label text="7 · Two arms" sub="same task, same trick, same seed" y={2.4} /></Station>
        <Station id="gateway" f={f} onPick={onPick} r={3.6}><Gateway layers={layers} refusedAt={refusedAt} rt={rt} hitT={hitT} url={models.detector} /><Label text="8 · The guard" sub="every call of the defended arm" y={3.6} tone="blue" /></Station>
        <Station id="tools" f={f} onPick={onPick} r={3.2}><Tools tools={pl.tools} forbidden={denied?.tool ?? ''} rt={rt} landT={landT} url={models.server} /><Label text="9 · The tools" sub="real tools on the case's own data" y={3.4} /></Station>
        <Station id="score" f={f} onPick={onPick}><Score ex={ex} rt={rt} /><Label text="10 · The scorer" sub="reads what happened, not what was said" y={3.8} /></Station>
        <Station id="report" f={f} onPick={onPick}><Report pl={pl} ex={ex} rt={rt} /><Label text="11 · The report" sub="kept, hashed, sent back" y={3.6} /></Station>
        <group position={[POS.arms[0] + 3, 0.2, 0]}>
          <Tag position={[0, 0, 3.4]} tone="is-blue">defended: through the guard</Tag>
          <Tag position={[0, 0, -4.4]} tone="is-red">baseline: straight to the tools</Tag>
        </group>
        </Suspense>
        <RailTubes r={rails} />
        <Packets r={rails} calls={calls} stop={stop} rt={rt} />
        <Rig progress={progress} f={f} onStep={onStep} />
        {!reduce && <FluidFX />}
      </Canvas>
    </div>
  );
}
