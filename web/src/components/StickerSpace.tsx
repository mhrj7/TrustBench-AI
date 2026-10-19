// The ending scene: stickers (our own artwork, components/stickers.ts) rain down onto the floor of a dark sky and settle
// into a heap, a sea bed of stickers under the title. The astronaut that fell out of the journey drops in, lands on the
// heap, large, and waves. Each sticker is a flat
// physics body (Rapier) under gravity; nothing moves until the pointer, a kinematic ball, pushes into the heap. The loop
// stops off screen, and the heap lies still under reduced motion.
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { BallCollider, CuboidCollider, Physics, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { useAnimations, useGLTF } from '@react-three/drei';
import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { FluidFX } from './FluidFX';
import * as THREE from 'three';
import { STICKERS } from './stickers';
import { AdaptiveResolution, budgetDpr } from '../lib/gpu';

const NAMES = Object.keys(STICKERS);
const WAVE_START = 6;
const URLS = NAMES.map((n) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(STICKERS[n].replace('<svg ', '<svg width="512" height="512" '))}`);
const seeded = (s: number) => () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;

function Sticker({ tex, start, size }: { tex: THREE.Texture; start: THREE.Vector3; size: number }) {
  return (
    <RigidBody position={start.toArray()} rotation={[0, 0, (start.x * 7) % Math.PI]} colliders={false} enabledRotations={[false, false, true]}
      linearDamping={0.3} angularDamping={0.8} friction={0.7} restitution={0.12}>
      <CuboidCollider args={[size * 0.4, size * 0.4, 0.25]} />
      <mesh>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial map={tex} transparent alphaTest={0.02} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
    </RigidBody>
  );
}

/** Floor and side walls at the edges of the view, so the heap stays on screen at any width. */
function Bounds() {
  const { viewport } = useThree();
  const w = viewport.width / 2, h = viewport.height / 2;
  return (
    <RigidBody type="fixed" colliders={false}>
      <CuboidCollider args={[w + 2, 1, 3]} position={[0, -h - 1, 0]} />
      <CuboidCollider args={[1, h * 4, 3]} position={[-w - 1, h, 0]} />
      <CuboidCollider args={[1, h * 4, 3]} position={[w + 1, h, 0]} />
      <CuboidCollider args={[w + 2, h * 4, 0.5]} position={[0, h, -1.2]} />
      <CuboidCollider args={[w + 2, h * 4, 0.5]} position={[0, h, 1.2]} />
    </RigidBody>
  );
}

/** The astronaut arrives from the journey: it drops in from above, lands on the sticker heap and waves. A rigged model
 *  plays its own wave; the plain model rocks a hello. */
function Floater({ url }: { url: string }) {
  const g = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF(url);
  const { viewport } = useThree();
  const model = useMemo(() => (animations.length ? scene : scene.clone(true)), [scene, animations.length]);
  const { actions } = useAnimations(animations, g);
  const born = useRef<number | null>(null);
  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    // Large, as on the reference site: the astronaut stands about two thirds of the view tall, its feet in the heap.
    return { s: (viewport.height * (viewport.aspect > 1 ? 0.66 : 0.52)) / Math.max(size.y, 1e-3), c };
  }, [model, viewport.height]);
  useEffect(() => {
    const clip = Object.keys(actions).find((n) => /wave|hello|greet/i.test(n)) ?? Object.keys(actions)[0];
    const a = clip ? actions[clip] : null;
    // The waving model's clip waves most from about 8 s in (elbow motion read from its animation data); landing takes
    // about 2 s, so start 6 s in and the wave arrives as it touches down.
    if (a) { a.reset().fadeIn(0.4).play(); a.time = WAVE_START; }
  }, [actions]);
  useFrame(({ clock }) => {
    const el = g.current; if (!el) return;
    if (born.current === null) born.current = clock.elapsedTime;
    const t = clock.elapsedTime - born.current, land = Math.min(1, t / 2.2), e = 1 - Math.pow(1 - land, 3);
    const top = viewport.height * 1.1, rest = -viewport.height * (viewport.aspect > 1 ? 0.16 : 0.2);
    el.position.y = top + (rest - top) * e + (land >= 1 ? Math.sin(t * 1.2) * 0.08 : 0);
    el.rotation.y = Math.sin(t * 0.3) * 0.12;   // face the viewer while it waves, with a slight sway
    // Without its own animation, the model says hello by rocking side to side for a few seconds after it lands.
    if (!animations.length) el.rotation.z = land >= 1 ? Math.sin(t * 5) * 0.16 * Math.max(0, 1 - (t - 2.2) / 5) : 0;
  });
  return (
    <group ref={g} position={[viewport.width * (viewport.aspect > 1 ? 0.27 : 0.16), viewport.height, -2.5]}>
      <primitive object={model} scale={fit.s} position={[-fit.c.x * fit.s, -fit.c.y * fit.s, -fit.c.z * fit.s]} />
    </group>
  );
}

function Pointer() {
  const api = useRef<RapierRigidBody>(null);
  const { viewport, pointer } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => { v.set((pointer.x * viewport.width) / 2, (pointer.y * viewport.height) / 2, 0); api.current?.setNextKinematicTranslation(v); });
  return <RigidBody ref={api} type="kinematicPosition" colliders={false} position={[0, 100, 0]}><BallCollider args={[1.3]} /></RigidBody>;
}

function Heap({ count }: { count: number }) {
  const textures = useLoader(THREE.TextureLoader, URLS);
  textures.forEach((t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; });
  const { viewport } = useThree();
  const items = useMemo(() => {
    const rnd = seeded(31), w = viewport.width / 2, h = viewport.height / 2;
    // Dropped from above the view in a loose column per slot, so they arrive in a shower rather than all at once.
    return Array.from({ length: count }, (_, i) => ({
      start: new THREE.Vector3((rnd() * 2 - 1) * w * 0.92, h + 1 + (i / count) * h * 3 + rnd() * 2, (rnd() - 0.5) * 1.2),
      size: (0.7 + rnd() * 0.65) * Math.min(1.2, viewport.width / 15), tex: i % textures.length,
    }));
  }, [count, viewport.width, viewport.height, textures.length]);
  return <>{items.map((it, i) => <Sticker key={i} tex={textures[it.tex]} start={it.start} size={it.size} />)}</>;
}

function Dust({ count }: { count: number }) {
  const geo = useMemo(() => {
    const rnd = seeded(4), a = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { a[i * 3] = (rnd() - 0.5) * 40; a[i * 3 + 1] = (rnd() - 0.5) * 24; a[i * 3 + 2] = -rnd() * 20 - 2; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a, 3)); return g;
  }, [count]);
  const ref = useRef<THREE.Points>(null);
  useFrame(({ clock }) => { if (ref.current) ref.current.rotation.z = clock.elapsedTime * 0.01; });
  return <points ref={ref} geometry={geo}><pointsMaterial size={0.06} color="#cfd6ff" transparent opacity={0.8} depthWrite={false} /></points>;
}

export default function StickerSpace({ reduce, source, modelUrl }: { reduce: boolean; source: RefObject<HTMLElement | null>; modelUrl: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [started, setStarted] = useState(false);
  const small = typeof window !== 'undefined' && window.innerWidth < 760;
  const [dpr] = useState(() => budgetDpr(small ? 1.4e6 : 2.2e6));
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { setVisible(e.isIntersecting && !document.hidden); if (e.isIntersecting) setStarted(true); }, { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={host} className="space-canvas" aria-hidden="true">
      {started && (
        <Canvas dpr={dpr} camera={{ position: [0, 0, 16], fov: 38 }} gl={{ antialias: true, alpha: false }} onCreated={({ gl }) => gl.setClearColor('#07080c')}
          eventSource={source.current ?? undefined} eventPrefix="client" frameloop={reduce ? 'demand' : visible ? 'always' : 'never'}>
          <AdaptiveResolution base={dpr} />
          <Dust count={small ? 400 : 1200} />
          <ambientLight intensity={0.6} />
          <directionalLight position={[4, 8, 6]} intensity={2.4} />
          <directionalLight position={[-6, -2, 4]} intensity={0.6} color="#9aa4ff" />
          {modelUrl && <Suspense fallback={null}><Floater url={modelUrl} /></Suspense>}
          <Physics gravity={[0, -16, 0]} paused={reduce || !visible} timeStep="vary">
            <Bounds />
            {!reduce && <Pointer />}
            <Suspense fallback={null}><Heap count={small ? 81 : 174} /></Suspense>
          </Physics>
          {!reduce && <FluidFX />}
        </Canvas>
      )}
    </div>
  );
}
