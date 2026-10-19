// The hero stage: a pile of glossy pieces held together by a pull toward the centre (Rapier physics, react-three-fiber).
// Blue, black and white pieces are the helper's ordinary actions; the red ones are hidden tricks. The pointer is the guard:
// a kinematic ball that shoves the pile around, and every trick it touches is stopped (turns blue) and counted. When all
// tricks are stopped, new ones arrive after a pause, so the scene never runs out. No external assets: the reflections come
// from light panels rendered into the environment map on the GPU. The loop pauses off screen or in a hidden tab, and the
// physics stands still under reduced motion.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { BallCollider, CuboidCollider, Physics, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FluidFX } from './FluidFX';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

const PALETTE = { blue: '#2433ff', black: '#0d0e13', white: '#e9eaf2', red: '#ef3b24' } as const;
type Kind = 'cross';
type Piece = { id: number; kind: Kind; color: keyof typeof PALETTE; scale: number; start: [number, number, number]; spin: [number, number, number] };

/** One hollow tube along y: an outer wall with rounded lips and an inner bore, turned on a lathe (normals come out right). */
function tube(R = 0.42, r = 0.2, h = 1.2, e = 0.07) {
  const pts = [[r, -h], [R - e, -h], [R, -h + e], [R, h - e], [R - e, h], [r, h], [r, -h]].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 40);
}
/** The piece: three hollow tubes crossing at the middle, one along each axis (a six-armed connector). */
const CROSS = (() => {
  const y = tube(), x = tube().rotateZ(Math.PI / 2), z = tube().rotateX(Math.PI / 2);
  const g = mergeGeometries([x, y, z])!; g.computeVertexNormals(); return g;
})();

const seeded = (s: number) => () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;

function makePieces(n: number, tricks: number): Piece[] {
  const rnd = seeded(7);
  const colors: (keyof typeof PALETTE)[] = ['blue', 'black', 'white'];
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    kind: 'cross' as Kind,
    color: i < tricks ? 'red' : colors[Math.floor(rnd() * 3)],
    scale: 0.95 + rnd() * 0.35,
    start: (() => { const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, rr = 3.2 * Math.cbrt(rnd()), s2 = Math.sqrt(1 - u * u);
      return [Math.cos(th) * s2 * rr, Math.sin(th) * s2 * rr, u * rr] as [number, number, number]; })(),
    spin: [rnd() * 6, rnd() * 6, rnd() * 6] as [number, number, number],
  }));
}

function Body({ piece, tricked, onStop, still }: { piece: Piece; tricked: boolean; onStop: (id: number) => void; still: boolean }) {
  const api = useRef<RapierRigidBody>(null);
  const mat = useRef<THREE.MeshPhysicalMaterial>(null);
  const flash = useRef(0);
  const target = useMemo(() => new THREE.Color(), []);
  const pull = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    const b = api.current;
    if (b && !still) {
      // Pull toward the centre: a weak spring with damping, so the pile breathes instead of collapsing.
      const t = b.translation();
      pull.set(-t.x, -t.y, -t.z).multiplyScalar(0.55 * piece.scale ** 3);
      b.applyImpulse(pull, true);
    }
    if (mat.current) {
      flash.current = Math.max(0, flash.current - dt * 1.8);
      target.set(tricked ? PALETTE.red : piece.color === 'red' ? PALETTE.blue : PALETTE[piece.color]);
      mat.current.color.lerp(target, 0.18);
      mat.current.emissive.set(PALETTE.blue).multiplyScalar(flash.current * 0.9);
    }
  });
  return (
    <RigidBody ref={api} position={piece.start} rotation={piece.spin} colliders={false}
      linearDamping={3.2} angularDamping={0.6} friction={0.2} restitution={0.25} name={`piece-${piece.id}`}
      onCollisionEnter={({ other }) => {
        if (tricked && other.rigidBodyObject?.name === 'guard') { flash.current = 1; onStop(piece.id); }
      }}>
      {/* Three crossing bars: the collider matches the piece, so pieces hook and stack like the real thing. */}
      <CuboidCollider args={[1.2 * piece.scale, 0.42 * piece.scale, 0.42 * piece.scale]} />
      <CuboidCollider args={[0.42 * piece.scale, 1.2 * piece.scale, 0.42 * piece.scale]} />
      <CuboidCollider args={[0.42 * piece.scale, 0.42 * piece.scale, 1.2 * piece.scale]} />
      <mesh geometry={CROSS} scale={piece.scale} castShadow receiveShadow>
        <meshPhysicalMaterial ref={mat} color={tricked ? PALETTE.red : PALETTE[piece.color === 'red' ? 'blue' : piece.color]}
          roughness={piece.color === 'black' ? 0.12 : 0.28} metalness={0.05} clearcoat={1} clearcoatRoughness={0.12} />
      </mesh>
    </RigidBody>
  );
}

/** The guard: a ball that follows the pointer across the stage. */
function Guard({ active }: { active: boolean }) {
  const api = useRef<RapierRigidBody>(null);
  const { viewport, pointer } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    v.set((pointer.x * viewport.width) / 2, (pointer.y * viewport.height) / 2, 0);
    if (!active) v.set(100, 100, 0);
    api.current?.setNextKinematicTranslation(v);
  });
  return (
    <RigidBody ref={api} type="kinematicPosition" colliders={false} name="guard" position={[100, 100, 0]}>
      <BallCollider args={[1.6]} />
    </RigidBody>
  );
}

export type HeroScore = { stopped: number; total: number };

export default function PhysicsHero({ reduce, onScore }: { reduce: boolean; onScore?: (s: HeroScore) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [pointerIn, setPointerIn] = useState(false);
  const small = typeof window !== 'undefined' && window.innerWidth < 760;
  const pieces = useMemo(() => makePieces(small ? 26 : 46, small ? 4 : 7), [small]);
  const tricks = pieces.filter((p) => p.color === 'red').map((p) => p.id);
  const [stopped, setStopped] = useState<Set<number>>(new Set());
  useEffect(() => { onScore?.({ stopped: stopped.size, total: tricks.length }); }, [stopped, tricks.length, onScore]);
  // Every trick stopped: new tricks arrive a few seconds later.
  useEffect(() => {
    if (stopped.size < tricks.length) return;
    const t = setTimeout(() => setStopped(new Set()), 4200);
    return () => clearTimeout(t);
  }, [stopped, tricks.length]);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && !document.hidden), { threshold: 0.01 });
    io.observe(el);
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  const stop = (id: number) => setStopped((s) => (s.has(id) ? s : new Set(s).add(id)));
  return (
    <div ref={host} className="stage-canvas" aria-hidden="true" onPointerEnter={() => setPointerIn(true)} onPointerLeave={() => setPointerIn(false)}
      onPointerDown={() => setPointerIn(true)}>
      <Canvas dpr={[1, 1.5]} camera={{ position: [0, 0, 20], fov: 32, near: 1, far: 60 }} gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
        frameloop={reduce ? 'demand' : visible ? 'always' : 'never'} onCreated={({ gl }) => gl.setClearColor('#14161d')}>
        <ambientLight intensity={0.5} />
        <spotLight position={[18, 18, 18]} angle={0.25} penumbra={1} intensity={600} castShadow />
        <Physics gravity={[0, 0, 0]} paused={reduce || !visible} timeStep="vary">
          <Guard active={pointerIn && !reduce} />
          {pieces.map((p) => <Body key={p.id} piece={p} still={reduce} tricked={p.color === 'red' && !stopped.has(p.id)} onStop={stop} />)}
        </Physics>
        <Environment resolution={256}>
          <group rotation={[-Math.PI / 3, 0, 1]}>
            <Lightformer form="circle" intensity={4} rotation-x={Math.PI / 2} position={[0, 5, -9]} scale={2} />
            <Lightformer form="circle" intensity={2} rotation-y={Math.PI / 2} position={[-5, 1, -1]} scale={2} />
            <Lightformer form="circle" intensity={2} rotation-y={Math.PI / 2} position={[-5, -1, -1]} scale={2} />
            <Lightformer form="circle" intensity={2} rotation-y={-Math.PI / 2} position={[10, 1, 0]} scale={8} />
            <Lightformer form="ring" color="#6b7cff" intensity={6} onUpdate={(self) => self.lookAt(0, 0, 0)} position={[10, 10, 0]} scale={10} />
          </group>
        </Environment>
        {!reduce && <FluidFX />}
      </Canvas>
    </div>
  );
}
