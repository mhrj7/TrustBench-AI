// The hero stage: a pile of glossy pieces held together by a pull toward the centre (Rapier physics, react-three-fiber).
// Blue, black and white pieces are the helper's ordinary actions; the red ones are hidden tricks. The pointer is the guard:
// a kinematic ball that shoves the pile around, and every trick it touches is stopped (turns blue) and counted. When all
// tricks are stopped, new ones arrive after a pause, so the scene never runs out. No external assets: the reflections come
// from light panels rendered into the environment map on the GPU. The loop pauses off screen or in a hidden tab, and the
// physics stands still under reduced motion.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { BallCollider, Physics, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

const PALETTE = { blue: '#2433ff', black: '#0d0e13', white: '#e9eaf2', red: '#ef3b24' } as const;
type Kind = 'box' | 'capsule' | 'ball';
type Piece = { id: number; kind: Kind; color: keyof typeof PALETTE; scale: number; start: [number, number, number] };

const GEO = {
  box: null as unknown as THREE.BufferGeometry,
  capsule: new THREE.CapsuleGeometry(0.42, 0.9, 8, 24),
  ball: new THREE.SphereGeometry(0.62, 40, 40),
};
// Soften the cube's edges by rounding it through a subdivided box mapped toward a sphere.
GEO.box = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const p = g.attributes.position, v = new THREE.Vector3(), r = 0.18, h = 0.5 - r;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const c = new THREE.Vector3(Math.max(-h, Math.min(h, v.x)), Math.max(-h, Math.min(h, v.y)), Math.max(-h, Math.min(h, v.z)));
    v.sub(c).normalize().multiplyScalar(r).add(c);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
})();

const seeded = (s: number) => () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;

function makePieces(n: number, tricks: number): Piece[] {
  const rnd = seeded(7);
  const kinds: Kind[] = ['box', 'capsule', 'ball'];
  const colors: (keyof typeof PALETTE)[] = ['blue', 'black', 'white'];
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    kind: kinds[i % 3],
    color: i < tricks ? 'red' : colors[Math.floor(rnd() * 3)],
    scale: 1.05 + rnd() * 0.75,
    start: [(rnd() - 0.5) * 16, (rnd() - 0.5) * 12, (rnd() - 0.5) * 8 - 2],
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
      pull.set(-t.x, -t.y, -t.z).multiplyScalar(0.2 * piece.scale ** 3);
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
    <RigidBody ref={api} position={piece.start} colliders={piece.kind === 'ball' ? 'ball' : piece.kind === 'capsule' ? 'hull' : 'cuboid'}
      linearDamping={3.2} angularDamping={0.6} friction={0.2} restitution={0.25} name={`piece-${piece.id}`}
      onCollisionEnter={({ other }) => {
        if (tricked && other.rigidBodyObject?.name === 'guard') { flash.current = 1; onStop(piece.id); }
      }}>
      <mesh geometry={GEO[piece.kind]} scale={piece.scale} castShadow receiveShadow>
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
  const pieces = useMemo(() => makePieces(small ? 34 : 64, small ? 5 : 8), [small]);
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
      <Canvas dpr={[1, 1.75]} camera={{ position: [0, 0, 20], fov: 32, near: 1, far: 60 }} gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
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
      </Canvas>
    </div>
  );
}
