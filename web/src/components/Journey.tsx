// The journey (react-three-fiber), after the reference site's device sequence. One scroll value drives everything:
//   space    (0.00-0.42)  the astronaut model floats above a glowing planet, then drifts away into the dark;
//   tunnel   (0.42-0.78)  the camera flies through a chrome lattice whose rings ("lanes") turn in opposite directions;
//   corridor (0.78-1.00)  after a flash, a blue corridor whose walls are cut with the site's shield and lock shapes.
// The canvas is transparent: the space behind it is a ShaderGradient nebula rendered by the section (see Overview.tsx).
// The astronaut is a downloaded model (lib/models.ts). The loop pauses off screen and renders one frame under reduced motion.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer, useGLTF } from '@react-three/drei';
import { Bloom } from '@react-three/postprocessing';
import { FluidFX } from './FluidFX';
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
    // At the end it turns and comes straight at the camera: out through the glass (the page shatters the screen).
    const out = smooth(0.84, 0.93, v);
    const ahead = (v < 0.42 ? 7 + smooth(0.22, 0.42, v) * 14 : 9) * (1 - out) + 0.6 * out;
    el.position.set(Math.sin(t * 0.4) * 0.3 * (1 - out), -0.2 + Math.sin(t * 0.8) * 0.18 - out * 0.6, z - ahead);
    el.visible = v < 0.935;
    const out2 = smooth(0.84, 0.9, v);
    el.rotation.set(-0.15 + (v > 0.42 ? -0.9 * (1 - out2) : 0) + Math.sin(t * 0.6) * 0.05, Math.sin(t * 0.3) * 0.5 * (1 - out2) + (v > 0.42 ? Math.PI * (1 - out2) : 0), Math.sin(t * 0.5) * 0.12);
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

/** The block tunnel, after the reference site: rings of dark glossy blocks of varied size around the flight path, each with
 *  glowing inset panels whose colour shifts along the tunnel and with the scroll (pink, violet, cyan). Neighbouring rings
 *  turn in opposite directions, and a bright burst waits at the far end. Bloom (in the canvas) makes the panels glow. */
function Lattice({ p }: { p: P }) {
  const group = useRef<THREE.Group>(null), burst = useRef<THREE.Mesh>(null);
  const RINGS = 34, PER = 18, R = 6.2, STEP = (TUNNEL_START - TUNNEL_END) / RINGS;
  const box = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const dark = useMemo(() => new THREE.MeshPhysicalMaterial({ color: '#0d0e16', metalness: 0.4, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 1.2 }), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), []);
  const rings = useMemo(() => {
    const rnd = seeded(23), m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
    return Array.from({ length: RINGS }, (_, k) => {
      const z = TUNNEL_START - k * STEP, blocks: THREE.Matrix4[] = [], panels: THREE.Matrix4[] = [], hues: number[] = [];
      for (let i = 0; i < PER; i++) {
        if (rnd() < 0.12) continue;                                    // gaps, so the walls read as separate blocks
        const a = (i / PER) * Math.PI * 2 + rnd() * 0.12, depth = 0.6 + rnd() * 2.2, w = 1.4 + rnd() * 1.4, len = STEP * (0.5 + rnd() * 0.9);
        const rr = R + depth / 2 + rnd() * 0.6;
        pos.set(Math.cos(a) * rr, Math.sin(a) * rr, z + (rnd() - 0.5) * STEP * 0.4);
        e.set(rnd() * 0.12, rnd() * 0.12, a + Math.PI / 2); q.setFromEuler(e); sc.set(w, depth, len);
        blocks.push(m.compose(pos, q, sc).clone());
        // One or two glowing panels on the inner face of the block: thin plates, slightly proud of the surface.
        const n = rnd() < 0.55 ? 1 : 2;
        for (let j = 0; j < n; j++) {
          const inner = rr - depth / 2 - 0.02, off = (j - (n - 1) / 2) * w * 0.4;
          const tang = new THREE.Vector3(-Math.sin(a), Math.cos(a), 0).multiplyScalar(off);
          pos.set(Math.cos(a) * inner, Math.sin(a) * inner, z).add(tang);
          sc.set(w * (n === 1 ? 0.7 : 0.32) * (0.6 + rnd() * 0.4), 0.05, len * (0.3 + rnd() * 0.6));
          panels.push(m.compose(pos, q, sc).clone());
          hues.push(rnd());
        }
      }
      return { blocks, panels, hues, dir: k % 2 ? 1 : -1, speed: 0.5 + (k % 3) * 0.3 };
    });
  }, [RINGS, STEP]);
  const groups = useRef<(THREE.Group | null)[]>([]), panelMeshes = useRef<(THREE.InstancedMesh | null)[]>([]);
  const col = useMemo(() => new THREE.Color(), []);
  const PINK = useMemo(() => new THREE.Color('#ff3d9a'), []), VIOLET = useMemo(() => new THREE.Color('#8b5cff'), []), CYAN = useMemo(() => new THREE.Color('#38d9ff'), []);
  useFrame(({ clock }) => {
    const v = p.current, t = clock.elapsedTime;
    if (group.current) group.current.visible = v > 0.34 && v < 0.84;
    rings.forEach((r, i) => {
      const g = groups.current[i]; if (g) g.rotation.z = r.dir * (v * 7 * r.speed + t * 0.04 * r.speed);
      const im = panelMeshes.current[i]; if (!im) return;
      // Colour along the tunnel and with the scroll: pink near the entrance, violet, then cyan deeper in; panels flicker.
      r.hues.forEach((h, j) => {
        const u = (i / RINGS + v * 1.4 + h * 0.25) % 1;
        if (u < 0.5) col.copy(PINK).lerp(VIOLET, u * 2); else col.copy(VIOLET).lerp(CYAN, (u - 0.5) * 2);
        col.multiplyScalar(1.6 + Math.sin(t * 3 + h * 30) * 0.5 + 0.5);
        im.setColorAt(j, col);
      });
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    });
    if (burst.current) { const near = smooth(0.6, 0.78, v); burst.current.scale.setScalar(4 + near * 26 + Math.sin(t * 2) * 0.6); (burst.current.material as THREE.MeshBasicMaterial).opacity = 0.35 + near * 0.65; }
  });
  return (
    <group ref={group}>
      {rings.map((r, i) => (
        <group key={i} ref={(el) => { groups.current[i] = el; }}>
          <instancedMesh args={[box, dark, r.blocks.length]} onUpdate={(im) => { r.blocks.forEach((m, j) => im.setMatrixAt(j, m)); im.instanceMatrix.needsUpdate = true; }} />
          <instancedMesh ref={(el) => { panelMeshes.current[i] = el; }} args={[box, glowMat, r.panels.length]}
            onUpdate={(im) => { r.panels.forEach((m, j) => { im.setMatrixAt(j, m); im.setColorAt(j, new THREE.Color('#ff3d9a')); }); im.instanceMatrix.needsUpdate = true; }} />
        </group>
      ))}
      <mesh ref={burst} position={[0, 0, TUNNEL_END - 6]}><circleGeometry args={[1, 64]} /><meshBasicMaterial color="#e8f4ff" transparent opacity={0.4} toneMapped={false} /></mesh>
      <pointLight position={[0, 0, -60]} color="#ff3d9a" intensity={140} distance={60} />
      <pointLight position={[0, 0, -130]} color="#38d9ff" intensity={140} distance={60} />
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
        {!reduce && <FluidFX><Bloom intensity={1.4} luminanceThreshold={0.6} luminanceSmoothing={0.2} mipmapBlur radius={0.75} /></FluidFX>}
      </Canvas>
    </div>
  );
}
