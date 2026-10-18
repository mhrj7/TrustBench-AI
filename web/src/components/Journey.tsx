// The journey: a scroll-driven 3D scene (react-three-fiber). An astronaut (a downloaded model, credited in lib/models.ts)
// stands on a moon under a beam of light while rocks drift upward; then it lifts off and flies through four portals, one
// per stage of the evidence, each a different colour of space. The moon, rocks, beam, stars and portals are built here. The
// scene reads the scroll position each frame (`progress`, 0 to 1), eased so the camera never jumps; it pauses off screen,
// and renders one still frame under reduced motion.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useAnimations, useGLTF } from '@react-three/drei';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { MotionValue } from 'motion/react';
import * as THREE from 'three';

export const PORTALS = [
  { z: -46, color: '#2433ff', fog: '#05071a' },
  { z: -92, color: '#7c3aed', fog: '#0c0418' },
  { z: -138, color: '#ef3b24', fog: '#170504' },
  { z: -184, color: '#e9eaf2', fog: '#0b0c10' },
] as const;
const END_Z = -206;

const smooth = (a: number, b: number, v: number) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const seeded = (s: number) => () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;

function rockGeometry(seed: number) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const rnd = seeded(seed + 11), p = g.attributes.position, v = new THREE.Vector3();
  const cache = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    const k = cache.get(key) ?? 0.72 + rnd() * 0.5;
    cache.set(key, k);
    v.multiplyScalar(k);
    p.setXYZ(i, v.x, v.y * 0.8, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** The astronaut model (see lib/models.ts for its source and licence), scaled to a fixed height, playing its own loop.
 *  It leans forward into flight as the helper lifts off. */
function Astronaut({ url, progress }: { url: string; progress: React.MutableRefObject<number> }) {
  const g = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF(url);
  const { actions } = useAnimations(animations, g);
  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    return { s: 2.2 / Math.max(size.y, 1e-3), c };
  }, [scene]);
  useEffect(() => { const a = Object.values(actions)[0]; a?.reset().fadeIn(0.4).play(); return () => { a?.fadeOut(0.2); }; }, [actions]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime, fly = smooth(0.16, 0.3, progress.current);
    if (g.current) {
      g.current.rotation.x = -fly * 1.1 + Math.sin(t * 0.7) * 0.05 * fly;
      g.current.rotation.z = Math.sin(t * 0.5) * 0.07 * fly;
      g.current.rotation.y = Math.PI + (1 - fly) * Math.sin(t * 0.35) * 0.3;
    }
  });
  return (
    <group ref={g}>
      <primitive object={scene} scale={fit.s} position={[-fit.c.x * fit.s, -fit.c.y * fit.s + 1.1, -fit.c.z * fit.s]} />
    </group>
  );
}

function Moon({ progress }: { progress: React.MutableRefObject<number> }) {
  const mesh = useRef<THREE.Mesh>(null);
  // The moon is only the first scene: gone once the helper is well into space, so its rim never blocks a portal.
  useFrame(() => { if (mesh.current) mesh.current.visible = progress.current < 0.42; });
  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(220, 220, 160, 160);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), r = Math.hypot(x, y);
      const crater = Math.sin(x * 0.35) * Math.cos(y * 0.31) * 0.35 + Math.sin(x * 0.11 + y * 0.07) * 1.2;
      const rim = smooth(12, 70, r) * 5 * (0.6 + 0.4 * Math.sin(Math.atan2(y, x) * 5));
      p.setZ(i, crater * smooth(3, 14, r) + rim);
    }
    g.computeVertexNormals();
    return g;
  }, []);
  return (
    <mesh ref={mesh} geometry={geo} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, -20]} receiveShadow>
      <meshStandardMaterial color="#9a9ca6" roughness={0.95} flatShading />
    </mesh>
  );
}

/** Rocks lifting off the ground around the helper; they rise faster as the helper takes off. */
function Rocks({ progress, count }: { progress: React.MutableRefObject<number>; count: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(() => rockGeometry(3), []);
  const data = useMemo(() => {
    const rnd = seeded(5);
    return Array.from({ length: count }, () => ({ x: (rnd() - 0.5) * 26, z: -rnd() * 26 + 6, y0: rnd() * 6, s: 0.06 + rnd() * 0.22, sp: 0.2 + rnd() * 0.6, r: rnd() * 6 }));
  }, [count]);
  const m = useMemo(() => new THREE.Object3D(), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime, lift = 1 + smooth(0.1, 0.3, progress.current) * 6;
    data.forEach((d, i) => {
      const y = (d.y0 + t * d.sp * lift) % 14;
      m.position.set(d.x, y, d.z); m.rotation.set(t * d.sp + d.r, t * d.sp * 0.7, d.r); m.scale.setScalar(d.s);
      m.updateMatrix(); ref.current?.setMatrixAt(i, m.matrix);
    });
    if (ref.current) ref.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[geo, undefined, count]}>
      <meshStandardMaterial color="#5b5e6b" roughness={0.9} flatShading />
    </instancedMesh>
  );
}

function Beam() {
  return (
    <mesh position={[0, 14, -1]}>
      <cylinderGeometry args={[0.6, 4.2, 30, 48, 1, true]} />
      <meshBasicMaterial color="#cfd6ff" transparent opacity={0.07} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

function Stars({ count }: { count: number }) {
  const geo = useMemo(() => {
    const rnd = seeded(9), a = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 6 + rnd() * 60, th = rnd() * Math.PI * 2;
      a[i * 3] = Math.cos(th) * r; a[i * 3 + 1] = Math.sin(th) * r * 0.7 + 8; a[i * 3 + 2] = 30 - rnd() * 280;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a, 3));
    return g;
  }, [count]);
  return <points geometry={geo}><pointsMaterial size={0.12} color="#ffffff" transparent opacity={0.85} sizeAttenuation depthWrite={false} /></points>;
}

function Portal({ z, color, index, progress }: { z: number; color: string; index: number; progress: React.MutableRefObject<number> }) {
  const ring = useRef<THREE.Mesh>(null), disc = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (ring.current) { ring.current.rotation.z = t * (0.2 + index * 0.05); }
    if (disc.current) disc.current.opacity = 0.1 + Math.sin(t * 1.5 + index) * 0.04;
  });
  return (
    <group position={[0, 9, z]}>
      <mesh ref={ring}><torusGeometry args={[4.2, 0.07, 16, 160]} /><meshBasicMaterial color={color} toneMapped={false} /></mesh>
      <mesh><torusGeometry args={[4.6, 0.02, 8, 160]} /><meshBasicMaterial color={color} transparent opacity={0.5} toneMapped={false} /></mesh>
      <mesh><circleGeometry args={[4.15, 96]} /><meshBasicMaterial ref={disc} color={color} transparent opacity={0.1} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} /></mesh>
      <pointLight color={color} intensity={30} distance={22} />
    </group>
  );
}

/** Camera and helper follow one path: standing on the moon, lifting into the beam, then flying through the portals. */
function Flight({ progress, smoothP, url }: { progress: MotionValue<number>; smoothP: React.MutableRefObject<number>; url: string }) {
  const astro = useRef<THREE.Group>(null);
  const { camera, scene } = useThree();
  const fog = useMemo(() => new THREE.Color('#0b0c10'), []);
  const tmp = useMemo(() => new THREE.Color(), []);
  const look = useMemo(() => new THREE.Vector3(), []);
  useEffect(() => { scene.fog = new THREE.FogExp2('#0b0c10', 0.018); scene.background = fog; }, [scene, fog]);
  useFrame((_, dt) => {
    smoothP.current += (progress.get() - smoothP.current) * Math.min(1, dt * 4);
    const p = smoothP.current;
    const lift = smooth(0.14, 0.32, p), travel = smooth(0.3, 0.97, p);
    const y = lift * 9 + Math.sin(performance.now() / 900) * 0.15 * lift;
    const z = THREE.MathUtils.lerp(0, END_Z, travel);
    astro.current?.position.set(0, y, z);
    const pull = 1 - lift;
    camera.position.set(Math.sin(p * 3) * 1.2, 1.4 + y * 0.92 + pull * 1.2, z + 7 + pull * 5);
    look.set(0, y + 0.6 + pull * 0.4, z - 4);
    camera.lookAt(look);
    // Space takes the colour of the portal ahead.
    let target = '#0b0c10';
    for (const pt of PORTALS) if (z < pt.z + 30) target = pt.fog;
    tmp.set(target);
    fog.lerp(tmp, Math.min(1, dt * 2));
    if (scene.fog) (scene.fog as THREE.FogExp2).color.copy(fog);
  });
  return <group ref={astro}><Suspense fallback={null}><Astronaut url={url} progress={smoothP} /></Suspense></group>;
}

export default function Journey({ progress, reduce, modelUrl }: { progress: MotionValue<number>; reduce: boolean; modelUrl: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const smoothP = useRef(reduce ? 0.18 : 0);
  const small = typeof window !== 'undefined' && window.innerWidth < 760;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && !document.hidden), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={host} className="journey-canvas" aria-hidden="true">
      <Canvas dpr={[1, 1.5]} camera={{ position: [0, 2, 12], fov: 50, near: 0.1, far: 400 }} gl={{ antialias: true, powerPreference: 'high-performance' }}
        frameloop={reduce ? 'demand' : visible ? 'always' : 'never'}>
        <ambientLight intensity={0.25} />
        <spotLight position={[0, 30, 0]} angle={0.35} penumbra={0.8} intensity={1800} distance={60} color="#e6e9ff" />
        <hemisphereLight args={['#9aa4ff', '#111111', 0.4]} />
        <Moon progress={smoothP} />
        <Beam />
        <Rocks progress={smoothP} count={small ? 60 : 140} />
        <Stars count={small ? 1500 : 4000} />
        {PORTALS.map((pt, i) => <Portal key={i} index={i} z={pt.z} color={pt.color} progress={smoothP} />)}
        <Flight progress={progress} smoothP={smoothP} url={modelUrl} />
      </Canvas>
    </div>
  );
}
