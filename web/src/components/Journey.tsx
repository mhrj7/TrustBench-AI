// The journey (react-three-fiber), after the reference site's device sequence. One scroll value drives everything:
//   space    (0.00-0.42)  the astronaut model floats above a glowing planet, then drifts away into the dark;
//   tunnel   (0.42-0.78)  the camera flies through a chrome lattice whose rings ("lanes") turn in opposite directions;
//   corridor (0.78-1.00)  after a flash, a blue corridor whose walls are cut with the site's shield and lock shapes.
// The canvas is transparent: the space behind it is a ShaderGradient nebula rendered by the section (see Overview.tsx).
// The astronaut is a downloaded model (lib/models.ts). The loop pauses off screen and renders one frame under reduced motion.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer, useGLTF } from '@react-three/drei';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { MotionValue } from 'motion/react';
import * as THREE from 'three';

const smooth = (a: number, b: number, v: number) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const seeded = (s: number) => () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;

const TUNNEL_START = -24, TUNNEL_END = -210, CORRIDOR_START = -222, CORRIDOR_LEN = 90;
type P = React.MutableRefObject<number>;

/** Where the camera is along the path, from the eased scroll value. */
function cameraZ(p: number) {
  if (p < 0.42) return 9 - smooth(0.18, 0.42, p) * 16;                                         // space: 9 -> -7
  if (p < 0.78) return THREE.MathUtils.lerp(-7, TUNNEL_END + 4, smooth(0.42, 0.78, p) ** 0.9);   // tunnel
  return THREE.MathUtils.lerp(TUNNEL_END + 4, CORRIDOR_START - CORRIDOR_LEN + 20, smooth(0.78, 1, p)); // corridor
}

function Astronaut({ url, p }: { url: string; p: P }) {
  const g = useRef<THREE.Group>(null);
  const { scene } = useGLTF(url);
  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    return { s: 2.4 / Math.max(size.y, 1e-3), c };
  }, [scene]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime, v = p.current, el = g.current;
    if (!el) return;
    const z = cameraZ(v);
    // In space it floats in front of the camera and slowly recedes; in the tunnel and corridor it flies just ahead.
    const ahead = v < 0.42 ? 7 + smooth(0.22, 0.42, v) * 14 : 9;
    el.position.set(Math.sin(t * 0.4) * 0.3, -0.2 + Math.sin(t * 0.8) * 0.18, z - ahead);
    el.rotation.set(-0.15 + (v > 0.42 ? -0.9 : 0) + Math.sin(t * 0.6) * 0.05, Math.sin(t * 0.3) * 0.5 + (v > 0.42 ? Math.PI : 0), Math.sin(t * 0.5) * 0.12);
  });
  return (
    <group ref={g}>
      <primitive object={scene} scale={fit.s} position={[-fit.c.x * fit.s, -fit.c.y * fit.s, -fit.c.z * fit.s]} />
    </group>
  );
}

/** A planet below the astronaut with a thin glowing atmosphere (fresnel rim). Only in the space phase. */
function Planet({ p }: { p: P }) {
  const g = useRef<THREE.Group>(null);
  const atmo = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
    uniforms: { uColor: { value: new THREE.Color('#4d6bff') } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
    fragmentShader: 'uniform vec3 uColor; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 3.0); gl_FragColor = vec4(uColor * f * 1.8, f); }',
  }), []);
  useFrame(({ clock }) => {
    if (!g.current) return;
    g.current.visible = p.current < 0.46;
    g.current.rotation.y = clock.elapsedTime * 0.01;
  });
  return (
    <group ref={g} position={[0, -47, -40]}>
      <mesh><sphereGeometry args={[42, 96, 96]} /><meshStandardMaterial color="#0a1440" roughness={0.9} emissive="#06103a" emissiveIntensity={0.6} /></mesh>
      <mesh scale={1.035} material={atmo}><sphereGeometry args={[42, 96, 96]} /></mesh>
    </group>
  );
}

function Stars({ count }: { count: number }) {
  const geo = useMemo(() => {
    const rnd = seeded(9), a = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { const r = 20 + rnd() * 80, th = rnd() * Math.PI * 2; a[i * 3] = Math.cos(th) * r; a[i * 3 + 1] = Math.sin(th) * r; a[i * 3 + 2] = 20 - rnd() * 120; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a, 3)); return g;
  }, [count]);
  return <points geometry={geo}><pointsMaterial size={0.14} color="#ffffff" transparent opacity={0.85} depthWrite={false} /></points>;
}

/** The chrome lattice: rings of struts on a cylinder; each ring ("lane") turns its own way as you scroll. */
function Lattice({ p }: { p: P }) {
  const group = useRef<THREE.Group>(null);
  const BANDS = 32, NODES = 10, R = 6.5, STEP = (TUNNEL_START - TUNNEL_END) / BANDS;
  const strut = useMemo(() => new THREE.CylinderGeometry(0.09, 0.09, 1, 6, 1), []);
  const chrome = useMemo(() => new THREE.MeshPhysicalMaterial({ color: '#d9dcea', metalness: 1, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.4 }), []);
  const glowPink = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ff4fa3', toneMapped: false }), []);
  const glowBlue = useMemo(() => new THREE.MeshBasicMaterial({ color: '#57d1ff', toneMapped: false }), []);
  const bands = useMemo(() => {
    const up = new THREE.Vector3(0, 1, 0), m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), mid = new THREE.Vector3(), dir = new THREE.Vector3();
    const node = (i: number, z: number, twist: number) => { const a = (i / NODES) * Math.PI * 2 + twist; return new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, z); };
    const place = (a: THREE.Vector3, b: THREE.Vector3, w = 1) => {
      mid.addVectors(a, b).multiplyScalar(0.5); dir.subVectors(b, a); q.setFromUnitVectors(up, dir.clone().normalize()); s.set(w, dir.length(), w);
      return m.compose(mid, q, s).clone();
    };
    return Array.from({ length: BANDS }, (_, k) => {
      const z0 = TUNNEL_START - k * STEP, z1 = z0 - STEP, tw = (k % 2) * (Math.PI / NODES);
      const mats: THREE.Matrix4[] = [], glow: THREE.Matrix4[] = [];
      for (let i = 0; i < NODES; i++) {
        const a = node(i, z0, tw), b = node(i + 1, z0, tw), c = node(i, z1, tw + Math.PI / NODES), d = node(i + 1, z1, tw + Math.PI / NODES);
        mats.push(place(a, b), place(a, c), place(b, c));
        if ((i + k) % 4 === 0) glow.push(place(a.clone().multiplyScalar(0.985), d.clone().multiplyScalar(0.985), 0.45));
      }
      return { mats, glow, dir: k % 2 ? 1 : -1, speed: 0.6 + (k % 3) * 0.35 };
    });
  }, [BANDS, STEP]);
  const refs = useRef<(THREE.Group | null)[]>([]);
  useFrame(({ clock }) => {
    const v = p.current, t = clock.elapsedTime;
    if (group.current) group.current.visible = v > 0.34 && v < 0.84;
    bands.forEach((b, i) => { const g = refs.current[i]; if (g) g.rotation.z = b.dir * (v * 9 * b.speed + t * 0.05 * b.speed); });
  });
  return (
    <group ref={group}>
      {bands.map((b, i) => (
        <group key={i} ref={(el) => { refs.current[i] = el; }}>
          <instancedMesh args={[strut, chrome, b.mats.length]} onUpdate={(im) => { b.mats.forEach((m, j) => im.setMatrixAt(j, m)); im.instanceMatrix.needsUpdate = true; }} />
          {b.glow.length > 0 && (
            <instancedMesh args={[strut, i % 2 ? glowPink : glowBlue, b.glow.length]} onUpdate={(im) => { b.glow.forEach((m, j) => im.setMatrixAt(j, m)); im.instanceMatrix.needsUpdate = true; }} />
          )}
        </group>
      ))}
      <pointLight position={[0, 0, -60]} color="#ff4fa3" intensity={120} distance={60} />
      <pointLight position={[0, 0, -130]} color="#57d1ff" intensity={120} distance={60} />
    </group>
  );
}

/** Wall art for the corridor: white cut-outs of the site's shapes (rings, shields, locks, dots) on guard blue. */
function corridorTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const x = c.getContext('2d')!;
  x.fillStyle = '#2433ff'; x.fillRect(0, 0, 512, 512);
  x.fillStyle = '#e9eaf2'; x.strokeStyle = '#e9eaf2';
  const rnd = seeded(17);
  for (let i = 0; i < 9; i++) {
    const cx = rnd() * 512, cy = rnd() * 512, r = 30 + rnd() * 60, kind = i % 4;
    x.save(); x.translate(cx, cy);
    if (kind === 0) { x.lineWidth = r * 0.35; x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); x.stroke(); }
    else if (kind === 1) { x.beginPath(); x.moveTo(0, -r); x.lineTo(r * 0.8, -r * 0.6); x.lineTo(r * 0.8, r * 0.1); x.quadraticCurveTo(r * 0.7, r * 0.8, 0, r); x.quadraticCurveTo(-r * 0.7, r * 0.8, -r * 0.8, r * 0.1); x.lineTo(-r * 0.8, -r * 0.6); x.closePath(); x.fill(); }
    else if (kind === 2) { x.lineWidth = r * 0.22; x.beginPath(); x.arc(0, -r * 0.2, r * 0.45, Math.PI, 0); x.stroke(); x.fillRect(-r * 0.65, -r * 0.2, r * 1.3, r * 1.0); }
    else { x.beginPath(); x.arc(0, 0, r * 0.5, 0, Math.PI * 2); x.fill(); }
    x.restore();
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function Corridor({ p }: { p: P }) {
  const g = useRef<THREE.Group>(null);
  const tex = useMemo(() => { const t = corridorTexture(); t.repeat.set(8, 1); return t; }, []);
  const W = 9, H = 7;
  useFrame(() => { if (g.current) g.current.visible = p.current > 0.74; });
  const wall = (pos: [number, number, number], rot: [number, number, number], w: number) => (
    <mesh position={pos} rotation={rot}><planeGeometry args={[CORRIDOR_LEN, w]} /><meshStandardMaterial map={tex} roughness={0.55} side={THREE.DoubleSide} /></mesh>
  );
  const zc = CORRIDOR_START - CORRIDOR_LEN / 2;
  return (
    <group ref={g}>
      {wall([-W / 2, 0, zc], [0, Math.PI / 2, 0], H)}
      {wall([W / 2, 0, zc], [0, -Math.PI / 2, 0], H)}
      {wall([0, H / 2, zc], [Math.PI / 2, 0, Math.PI / 2], W)}
      {wall([0, -H / 2, zc], [-Math.PI / 2, 0, Math.PI / 2], W)}
      {Array.from({ length: 6 }, (_, i) => <pointLight key={i} position={[0, 2.5, CORRIDOR_START - 8 - i * 14]} intensity={40} distance={20} color="#ffffff" />)}
    </group>
  );
}

function Rig({ progress, p }: { progress: MotionValue<number>; p: P }) {
  const { camera } = useThree();
  useFrame((_, dt) => {
    p.current += (progress.get() - p.current) * Math.min(1, dt * 4);
    const v = p.current, z = cameraZ(v);
    const sway = v > 0.42 ? Math.sin(v * 40) * 0.25 : 0;
    camera.position.set(sway, v < 0.42 ? 0.6 - smooth(0.2, 0.42, v) * 0.6 : 0, z);
    camera.lookAt(0, 0, z - 10);
    (camera as THREE.PerspectiveCamera).fov = 42 + smooth(0.4, 0.5, v) * 18 - smooth(0.76, 0.84, v) * 8;
    camera.updateProjectionMatrix();
  });
  return null;
}

export default function Journey({ progress, reduce, modelUrl }: { progress: MotionValue<number>; reduce: boolean; modelUrl: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const p = useRef(reduce ? 0.1 : 0);
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
      <Canvas dpr={[1, 1.5]} camera={{ position: [0, 0.6, 9], fov: 42, near: 0.1, far: 400 }} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        frameloop={reduce ? 'demand' : visible ? 'always' : 'never'}>
        <ambientLight intensity={0.35} />
        <directionalLight position={[5, 6, 8]} intensity={2.2} />
        <directionalLight position={[-6, -3, -4]} intensity={0.8} color="#7f8cff" />
        <Environment resolution={256}>
          <Lightformer form="rect" intensity={6} color="#ff4fa3" position={[6, 2, -4]} scale={[4, 12, 1]} />
          <Lightformer form="rect" intensity={6} color="#57d1ff" position={[-6, -2, -4]} scale={[4, 12, 1]} />
          <Lightformer form="rect" intensity={3} color="#ffffff" position={[0, 8, 2]} scale={[12, 2, 1]} />
        </Environment>
        <Stars count={small ? 1200 : 3000} />
        <Planet p={p} />
        <Lattice p={p} />
        <Corridor p={p} />
        <Suspense fallback={null}><Astronaut url={modelUrl} p={p} /></Suspense>
        <Rig progress={progress} p={p} />
      </Canvas>
    </div>
  );
}
