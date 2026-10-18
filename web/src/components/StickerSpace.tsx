// The ending scene: a dark sky full of floating stickers (our own artwork, components/stickers.ts) drifting in zero
// gravity around an empty middle where the title sits. Each sticker is a physics body (Rapier); a weak spring pulls it back
// to its home, and the pointer is a kinematic ball that shoves stickers aside. Stickers tilt with their own velocity, so a
// push reads as a flick. No external assets. The loop stops off screen, and the stickers hang still under reduced motion.
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { BallCollider, Physics, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { STICKERS } from './stickers';

const NAMES = Object.keys(STICKERS);
const URLS = NAMES.map((n) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(STICKERS[n].replace('<svg ', '<svg width="512" height="512" '))}`);
const seeded = (s: number) => () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;

function Sticker({ tex, home, size, still }: { tex: THREE.Texture; home: THREE.Vector3; size: number; still: boolean }) {
  const api = useRef<RapierRigidBody>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const pull = useMemo(() => new THREE.Vector3(), []);
  const phase = useMemo(() => Math.random() * 10, []);
  useFrame(({ clock }) => {
    const b = api.current;
    if (!b) return;
    const t = b.translation(), v = b.linvel(), time = clock.elapsedTime + phase;
    if (!still) {
      // Spring home, plus a slow drift so the sky never stands still.
      pull.set(home.x + Math.sin(time * 0.3) * 0.4 - t.x, home.y + Math.cos(time * 0.27) * 0.4 - t.y, home.z - t.z).multiplyScalar(0.035 * size * size);
      b.applyImpulse(pull, true);
    }
    if (mesh.current) {
      mesh.current.rotation.z += ((-v.x * 0.08 + Math.sin(time * 0.5) * 0.12) - mesh.current.rotation.z) * 0.1;
      mesh.current.rotation.x += ((v.y * 0.06) - mesh.current.rotation.x) * 0.1;
    }
  });
  return (
    <RigidBody ref={api} position={home.toArray()} colliders={false} enabledRotations={[false, false, false]} linearDamping={1.6}>
      <BallCollider args={[size * 0.42]} />
      <mesh ref={mesh}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial map={tex} transparent alphaTest={0.02} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
    </RigidBody>
  );
}

function Pointer() {
  const api = useRef<RapierRigidBody>(null);
  const { viewport, pointer } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => { v.set((pointer.x * viewport.width) / 2, (pointer.y * viewport.height) / 2, 0); api.current?.setNextKinematicTranslation(v); });
  return <RigidBody ref={api} type="kinematicPosition" colliders={false} position={[0, 100, 0]}><BallCollider args={[1.3]} /></RigidBody>;
}

function Sky({ count, still }: { count: number; still: boolean }) {
  const textures = useLoader(THREE.TextureLoader, URLS);
  textures.forEach((t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; });
  const { viewport } = useThree();
  const items = useMemo(() => {
    const rnd = seeded(31), w = viewport.width / 2, h = viewport.height / 2, out: { home: THREE.Vector3; size: number; tex: number }[] = [];
    let guard = 0;
    while (out.length < count && guard++ < 4000) {
      const x = (rnd() * 2 - 1) * w * 1.05, y = (rnd() * 2 - 1) * h * 1.05;
      // Keep an oval in the middle clear for the title.
      if ((x / (w * 0.5)) ** 2 + (y / (h * 0.42)) ** 2 < 1) continue;
      const size = (0.9 + rnd() * 0.9) * Math.min(1.3, viewport.width / 14);
      if (out.some((o) => o.home.distanceTo(new THREE.Vector3(x, y, o.home.z)) < (o.size + size) * 0.45)) continue;
      out.push({ home: new THREE.Vector3(x, y, (rnd() - 0.5) * 2), size, tex: out.length % textures.length });
    }
    return out;
  }, [count, viewport.width, viewport.height, textures.length]);
  return <>{items.map((it, i) => <Sticker key={i} tex={textures[it.tex]} home={it.home} size={it.size} still={still} />)}</>;
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

export default function StickerSpace({ reduce, source }: { reduce: boolean; source: RefObject<HTMLElement | null> }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [started, setStarted] = useState(false);
  const small = typeof window !== 'undefined' && window.innerWidth < 760;
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
        <Canvas dpr={[1, 1.75]} camera={{ position: [0, 0, 16], fov: 38 }} gl={{ antialias: true, alpha: false }} onCreated={({ gl }) => gl.setClearColor('#07080c')}
          eventSource={source.current ?? undefined} eventPrefix="client" frameloop={reduce ? 'demand' : visible ? 'always' : 'never'}>
          <Dust count={small ? 400 : 1200} />
          <Physics gravity={[0, 0, 0]} paused={reduce || !visible} timeStep="vary">
            {!reduce && <Pointer />}
            <Suspense fallback={null}><Sky count={small ? 14 : 26} still={reduce} /></Suspense>
          </Physics>
        </Canvas>
      )}
    </div>
  );
}
