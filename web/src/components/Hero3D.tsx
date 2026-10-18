// The hero scene: an AI helper (the glowing core), the documents it reads orbiting it, one of them a trap that keeps
// firing a hidden instruction, and the guard: a translucent shield that stops each one. Built with react-three-fiber.
// No external assets are loaded (lights only, no HDR environment), so the page makes no extra requests. The canvas
// pauses when it is off screen or the tab is hidden, and renders a single still frame under reduced motion.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Float, RoundedBox, Sparkles } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

const ACCENT = new THREE.Color('#7c83ff');
const VIOLET = new THREE.Color('#c084fc');
const DANGER = new THREE.Color('#fb7185');
const SAFE = new THREE.Color('#34d399');
const SHIELD_R = 1.75;
const DOCS = 7;
const TRAP = 2;

/** The AI helper: the same friendly character as the story, a glowing sphere with eyes that blink, inside a slowly turning
 *  wireframe. It faces the viewer and looks toward the pointer. */
function Core() {
  const wire = useRef<THREE.Mesh>(null);
  const face = useRef<THREE.Group>(null);
  const eyes = useRef<THREE.Group>(null);
  const { pointer } = useThree();
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += dt;
    if (wire.current) { wire.current.rotation.y -= dt * 0.18; wire.current.rotation.x += dt * 0.05; }
    if (face.current) {
      face.current.rotation.y += (pointer.x * 0.5 - face.current.rotation.y) * 0.06;
      face.current.rotation.x += (-pointer.y * 0.35 - face.current.rotation.x) * 0.06;
      face.current.position.y = Math.sin(t.current * 1.6) * 0.05;
    }
    if (eyes.current) {
      const blink = (t.current % 3.6) > 3.45 ? 0.12 : 1;
      eyes.current.scale.y += (blink - eyes.current.scale.y) * 0.5;
    }
  });
  return (
    <group>
      <group ref={face}>
        <mesh>
          <sphereGeometry args={[0.74, 64, 64]} />
          <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={0.55} roughness={0.22} metalness={0.15} />
        </mesh>
        <group ref={eyes} position={[0, 0.08, 0.7]}>
          {[-0.2, 0.2].map((x) => (
            <mesh key={x} position={[x, 0, 0]}>
              <capsuleGeometry args={[0.065, 0.12, 8, 16]} />
              <meshBasicMaterial color="#0b0c19" />
            </mesh>
          ))}
        </group>
        <mesh position={[0, -0.2, 0.69]} rotation={[0, 0, Math.PI / 2]}>
          <capsuleGeometry args={[0.03, 0.16, 6, 12]} />
          <meshBasicMaterial color="#0b0c19" />
        </mesh>
      </group>
      <mesh ref={wire} scale={1.32}>
        <icosahedronGeometry args={[0.74, 1]} />
        <meshBasicMaterial color={VIOLET} wireframe transparent opacity={0.3} />
      </mesh>
      <pointLight color={ACCENT} intensity={6} distance={6} />
    </group>
  );
}

/** The guard. Flashes green when it stops a hidden instruction (hit is a 0..1 pulse written by the beam). */
function Shield({ hit }: { hit: React.MutableRefObject<number> }) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const shell = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    hit.current = Math.max(0, hit.current - dt * 1.6);
    if (mat.current) {
      mat.current.opacity = 0.045 + hit.current * 0.2;
      mat.current.color.copy(ACCENT).lerp(SAFE, Math.min(1, hit.current * 1.4));
    }
    if (shell.current) { shell.current.rotation.y += dt * 0.05; const s = 1 + hit.current * 0.04; shell.current.scale.setScalar(s); }
  });
  return (
    <mesh ref={shell}>
      <icosahedronGeometry args={[SHIELD_R, 2]} />
      <meshBasicMaterial ref={mat} wireframe transparent opacity={0.045} color={ACCENT} />
    </mesh>
  );
}

function Documents({ trapPos }: { trapPos: React.MutableRefObject<THREE.Vector3> }) {
  const group = useRef<THREE.Group>(null);
  const items = useMemo(() => Array.from({ length: DOCS }, (_, i) => {
    const a = (i / DOCS) * Math.PI * 2;
    return { a, r: 2.75 + (i % 2) * 0.35, y: Math.sin(i * 1.7) * 0.55, trap: i === TRAP };
  }), []);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    if (!group.current) return;
    group.current.rotation.y += dt * 0.12;
    const trap = group.current.children[TRAP];
    if (trap) trapPos.current.copy(trap.getWorldPosition(tmp));
  });
  return (
    <group ref={group}>
      {items.map((d, i) => (
        <group key={i} position={[Math.cos(d.a) * d.r, d.y, Math.sin(d.a) * d.r]} rotation={[0, -d.a + Math.PI / 2, 0]}>
          <Float speed={1.4} rotationIntensity={0.25} floatIntensity={0.35}>
            <RoundedBox args={[0.62, 0.82, 0.04]} radius={0.05} smoothness={3}>
              <meshStandardMaterial color={d.trap ? '#2a0f16' : '#151a2b'} emissive={d.trap ? DANGER : ACCENT} emissiveIntensity={d.trap ? 0.55 : 0.12}
                roughness={0.4} metalness={0.2} />
            </RoundedBox>
            {[0.22, 0.08, -0.06, -0.2].map((y, k) => (
              <mesh key={k} position={[-0.04 + (k === 3 ? -0.08 : 0), y, 0.03]}>
                <planeGeometry args={[k === 3 ? 0.28 : 0.42, 0.035]} />
                <meshBasicMaterial color={d.trap && k === 1 ? DANGER : '#8d93b8'} transparent opacity={d.trap && k === 1 ? 1 : 0.55} />
              </mesh>
            ))}
          </Float>
        </group>
      ))}
    </group>
  );
}

/** Hidden instructions travel from the trap document toward the helper and stop at the shield. */
function Beam({ trapPos, hit }: { trapPos: React.MutableRefObject<THREE.Vector3>; hit: React.MutableRefObject<number> }) {
  const N = 5;
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const phase = useRef(Array.from({ length: N }, (_, i) => i / N));
  const dir = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    for (let i = 0; i < N; i++) {
      const m = refs.current[i];
      if (!m) continue;
      phase.current[i] += dt * 0.45;
      if (phase.current[i] >= 1) { phase.current[i] -= 1; hit.current = 1; }
      const t = phase.current[i];
      dir.copy(trapPos.current).normalize();
      const start = trapPos.current.length();
      const d = start + (SHIELD_R - start) * t;
      m.position.copy(dir).multiplyScalar(d);
      const s = 0.05 + Math.sin(t * Math.PI) * 0.03;
      m.scale.setScalar(s / 0.05);
      (m.material as THREE.MeshBasicMaterial).opacity = Math.sin(t * Math.PI) * 0.95;
    }
  });
  return (
    <>
      {Array.from({ length: N }, (_, i) => (
        <mesh key={i} ref={(el) => { refs.current[i] = el; }}>
          <sphereGeometry args={[0.05, 12, 12]} />
          <meshBasicMaterial color={DANGER} transparent opacity={0} />
        </mesh>
      ))}
    </>
  );
}

/** The whole scene leans toward the pointer (lerped, so it never snaps). */
function Rig({ children }: { children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null);
  const { pointer, viewport } = useThree();
  // Wide screens: the scene sits to the right of the headline; narrow screens: centred and smaller, behind a dimmer overlay.
  const wide = viewport.aspect > 1.15;
  const x = wide ? viewport.width * 0.24 : 0;
  const scale = wide ? 1 : 0.78;
  useFrame(() => {
    if (!group.current) return;
    group.current.position.x += (x - group.current.position.x) * 0.08;
    group.current.scale.setScalar(scale);
    group.current.rotation.y += (pointer.x * 0.35 - group.current.rotation.y) * 0.05;
    group.current.rotation.x += (-pointer.y * 0.2 - group.current.rotation.x) * 0.05;
  });
  return <group ref={group}>{children}</group>;
}

export default function Hero3D({ reduce }: { reduce: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const hit = useRef(0);
  const trapPos = useRef(new THREE.Vector3(3, 0, 0));
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && !document.hidden), { threshold: 0.01 });
    io.observe(el);
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  return (
    <div ref={host} className="hero-canvas" aria-hidden="true">
      <Canvas dpr={[1, 2]} camera={{ position: [0, 0.6, 7.2], fov: 42 }} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        frameloop={reduce ? 'demand' : visible ? 'always' : 'never'}>
        <ambientLight intensity={0.35} />
        <directionalLight position={[4, 6, 5]} intensity={1.1} />
        <Rig>
          <Core />
          <Shield hit={hit} />
          <Documents trapPos={trapPos} />
          {!reduce && <Beam trapPos={trapPos} hit={hit} />}
        </Rig>
        {!reduce && <Sparkles count={70} scale={[11, 6, 6]} size={1.6} speed={0.25} opacity={0.5} color="#a5b4fc" />}
      </Canvas>
    </div>
  );
}
