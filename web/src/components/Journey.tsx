// The journey (react-three-fiber), after the reference site's tunnel sequence. One canvas, two scenes, one scroll value:
//  - the desk: a tablet beside the intro text, later a desktop screen (downloaded models, lib/models.ts);
//  - the world: space, rendered into a texture that is shown on whichever screen is in use (drei RenderTexture).
// The beats, in order (lib/journey.ts): the tablet shows the astronaut floating above the Earth, facing us; the camera
// dives until the screen is the whole view; the astronaut turns its back and swims in while a headline zooms past (in the
// page); the camera follows it in free fall through the square holes of a lattice of greebled blocks that twists one way
// and then the other and winds into a spiral that blows out like a supernova; into a blue corridor, where the astronaut
// turns, walks up to the glass and crouches; the camera pulls back out of a desktop screen, the astronaut leaps, the glass
// breaks, and it flies out towards you and drops below the page, where the ending (StickerSpace.tsx) catches it.
// The world is framed so the swap of screens at full zoom is invisible: the world camera's field of view is widened to the
// whole screen from the part of it that fills the viewport. The loop pauses off screen; under reduced motion the page shows
// a static list instead (Overview.tsx).
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer, PerspectiveCamera, Preload, RenderTexture, useAnimations, useGLTF } from '@react-three/drei';
import { Bloom } from '@react-three/postprocessing';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { FluidFX } from './FluidFX';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { MotionValue } from 'motion/react';
import * as THREE from 'three';
import { T } from '../lib/journey';
import { AdaptiveResolution, budgetDpr } from '../lib/gpu';

export type JourneyModels = { astronaut: string; ipad: string; imac: string; earth: string };

const smooth = (a: number, b: number, v: number) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = THREE.MathUtils.lerp;
const seeded = (s: number) => () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;



// World layout along the flight path (world units; the camera looks down -z).
const GRID_START = -40, TWIST_A = -130, TWIST_B = -205, SPIRAL = -268, GRID_END = -300, CORRIDOR_START = -352, CORRIDOR_END = -445, STAND = -405;
// The camera eases in from rest and then keeps an even pace through the tunnel, the blast and the corridor (the first
// leg is sized so its end speed matches the tunnel's), easing out only where it stops in front of the glass.
const CAM_KEYS: [number, number][] = [[0, 0], [T.fly, 0], [T.grid[0], -22], [T.grid[1], GRID_END], [T.blast[1], CORRIDOR_START], [T.corridor[1], STAND], [1, STAND]];
function worldZ(p: number) {
  for (let i = 1; i < CAM_KEYS.length; i++) {
    const [p0, z0] = CAM_KEYS[i - 1], [p1, z1] = CAM_KEYS[i];
    if (p > p1) continue;
    const t = Math.min(1, Math.max(0, (p - p0) / (p1 - p0 || 1)));
    return mix(z0, z1, i === 2 ? t * t : i === 5 ? 1 - (1 - t) ** 2 : t);
  }
  return STAND;
}

// ---------------------------------------------------------------------------------------------------------------------
// Devices. Each model's screen is described in the model's own units: both files face +x (the screen's normals point
// that way, and the desktop's foot reaches forward under it). The device is turned to face +z, scaled so the screen is 2
// units tall and moved so the screen is centred on its group's origin. The desktop's glass leans back about 10 degrees on
// its hinge; the model is tipped by that much so the glass is upright and the full-screen hand-off stays exact.
type DeviceSpec = { center: [number, number, number]; w: number; h: number; landscape: boolean; lift: number; tilt: number };
const IPAD: DeviceSpec = { center: [1.062, 2.07, -4.373], w: 3.44 * 0.925, h: 4.74 * 0.948, landscape: true, lift: 0.004, tilt: 0 };
// The desktop's chin and rim stand a little proud of its glass, so its screen surface is lifted in front of them.
const IMAC: DeviceSpec = { center: [2.3, 64.13, 0], w: 111.9, h: Math.hypot(61.82, 10.9), landscape: false, lift: 0.04, tilt: Math.atan2(10.9, 61.82) };
const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
function screenSize(d: DeviceSpec, narrow: boolean) {
  const k = 2 / d.h, w = d.w * k, land = d.landscape && !narrow;
  return { k, sw: land ? 2 : w, sh: land ? w : 2, rot: land ? -Math.PI / 2 : 0 };
}
/** The part of a screen (sw x sh) the viewport shows at full zoom: the largest rectangle of the viewport's shape. */
function fillRect(sw: number, sh: number, aspect: number) { return aspect > sw / sh ? { rw: sw, rh: sw / aspect } : { rw: sh * aspect, rh: sh }; }

const DESK_FOV = 35, WORLD_FOV = 50;

function DeviceModel({ url, spec, narrow, tint }: { url: string; spec: DeviceSpec; narrow: boolean; tint: (m: THREE.Mesh) => void }) {
  const { scene } = useGLTF(url);
  const model = useMemo(() => { const s = scene.clone(true); s.traverse((o) => { if ((o as THREE.Mesh).isMesh) tint(o as THREE.Mesh); }); return s; }, [scene, tint]);
  const { k, rot } = screenSize(spec, narrow);
  // The quarter turn about y makes the screen face +z; the tilt about x stands the glass upright.
  const c = new THREE.Vector3(...spec.center).applyAxisAngle(Y, -Math.PI / 2).applyAxisAngle(X, spec.tilt).multiplyScalar(k);
  return (
    <group rotation-z={rot}>
      <group position={[-c.x, -c.y, -c.z]} scale={k}>
        <group rotation-x={spec.tilt}><primitive object={model} rotation-y={-Math.PI / 2} /></group>
      </group>
    </group>
  );
}

const ipadTint = (m: THREE.Mesh) => { m.castShadow = false; const mat = m.material as THREE.MeshStandardMaterial; if (mat) { mat.envMapIntensity = 1.4; } };
const imacTint = (m: THREE.Mesh) => {
  const n = m.name;
  // Re-coloured to a dark aluminium with a black bezel, so the screen reads like a studio display.
  const metal = new THREE.MeshStandardMaterial({ color: '#2a2c33', metalness: 0.9, roughness: 0.32, envMapIntensity: 1.3 });
  if (/Stand|LightBlue|Rotate|DarkBlue/.test(n)) m.material = metal;
  else if (/White|Black/.test(n)) m.material = new THREE.MeshStandardMaterial({ color: '#07080b', metalness: 0.2, roughness: 0.4 });
  else if (/Screen_Screen/.test(n)) m.visible = false;
};

// ---------------------------------------------------------------------------------------------------------------------
// The world.

function useAstronaut(url: string) {
  const { scene, animations } = useGLTF(url);
  const model = useMemo(() => cloneSkinned(scene), [scene]);
  // Measured on the loaded scene, whose bones are posed; a fresh clone's are not until it is first rendered.
  const fit = useMemo(() => {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene, true), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    return { s: 1 / Math.max(size.y, 1e-3), c };
  }, [scene]);
  return { model, animations, fit };
}

// The body. The model's own clip is held at a calm floating frame, and the arms, legs and spine are moved on top of it, in
// the character's own space (it faces +z, its left is +x): swimming strokes and kicks in free fall, a walk, a crouch and a
// leap. Bones are found by name in the rig (GLTFLoader drops the dot before each bone's number).
type Body = { swim: number; walk: number; step: number; crouch: number; leap: number; tuck: number; t: number };
const BONES = ['Spine_2', 'L_Arm', 'R_Arm', 'L_Elbow', 'R_Elbow', 'L_Thigh', 'R_Thigh', 'L_Knee', 'R_Knee'] as const;
const AX = new THREE.Vector3(1, 0, 0), AZ = new THREE.Vector3(0, 0, 1);
function useBody(model: THREE.Object3D, animations: THREE.AnimationClip[], root: React.RefObject<THREE.Group | null>) {
  const { actions } = useAnimations(animations, root);
  useEffect(() => { const a = Object.values(actions)[0]; if (a) { a.reset().play(); a.paused = true; a.time = 16.5; } }, [actions]);
  const bones = useMemo(() => {
    const found: Partial<Record<(typeof BONES)[number], THREE.Object3D>> = {};
    model.traverse((o) => { for (const k of BONES) if (!found[k] && new RegExp(`^${k}\\.?\\d+$`).test(o.name)) found[k] = o; });
    return found;
  }, [model]);
  const q = useMemo(() => ({ m: new THREE.Quaternion(), mi: new THREE.Quaternion(), p: new THREE.Quaternion(), r: new THREE.Quaternion() }), []);
  // The held clip frame of each moved bone. Three.js only rewrites a bone when the clip's value changes, and a held clip
  // never changes, so every frame starts again from this saved pose (otherwise the turns would add up frame after frame).
  const base = useRef<Map<THREE.Object3D, THREE.Quaternion> | null>(null);
  const frames = useRef(0);
  // Turn a bone by `angle` about `axis` given in the character's space (after the clip has posed it this frame).
  const turn = (name: (typeof BONES)[number], axis: THREE.Vector3, angle: number) => {
    const bone = bones[name]; if (!bone || !bone.parent || Math.abs(angle) < 1e-4) return;
    model.getWorldQuaternion(q.m); q.mi.copy(q.m).invert();
    bone.parent.getWorldQuaternion(q.p);
    q.r.setFromAxisAngle(axis, angle).premultiply(q.m).multiply(q.mi);       // the turn in world space
    q.r.premultiply(q.p.clone().invert()).multiply(q.p);                     // ... in the parent's space
    bone.quaternion.premultiply(q.r);
  };
  return (b: Body) => {
    // Save the pose once the clip has had a couple of frames to apply it, then restore it before each frame's turns.
    if (!base.current) { if (++frames.current < 3) return; base.current = new Map(Object.values(bones).map((o) => [o!, o!.quaternion.clone()])); }
    base.current.forEach((qq, o) => o.quaternion.copy(qq));
    // Relaxed and slow, as a body drifts in zero gravity: small strokes, small kicks.
    const { t } = b, sw = Math.sin(t * 1.1), sw2 = Math.sin(t * 1.3), st = Math.sin(b.step);
    turn('Spine_2', AX, b.crouch * 0.35 + b.tuck * 0.35 + b.swim * 0.06 * sw - b.leap * 0.15);
    turn('L_Arm', AX, -b.swim * 0.3 * sw - b.walk * 0.4 * st - b.leap * 1.2 + b.crouch * 0.5 - b.tuck * 0.3);
    turn('R_Arm', AX, b.swim * 0.3 * sw + b.walk * 0.4 * st - b.leap * 1.2 + b.crouch * 0.5 - b.tuck * 0.3);
    turn('L_Arm', AZ, b.swim * 0.15 * (1 + Math.cos(t * 1.1)) + b.leap * 0.25);
    turn('R_Arm', AZ, -b.swim * 0.15 * (1 + Math.cos(t * 1.1)) - b.leap * 0.25);
    turn('L_Elbow', AX, -(b.swim * 0.25 * (1 + sw) * 0.5 + b.walk * 0.3 + b.tuck * 0.6 + b.crouch * 0.35));
    turn('R_Elbow', AX, -(b.swim * 0.25 * (1 - sw) * 0.5 + b.walk * 0.3 + b.tuck * 0.6 + b.crouch * 0.35));
    turn('L_Thigh', AX, -b.swim * 0.22 * sw2 - b.walk * 0.45 * st - b.crouch * 1.0 - b.tuck * 1.1 + b.leap * 0.25);
    turn('R_Thigh', AX, b.swim * 0.22 * sw2 + b.walk * 0.45 * st - b.crouch * 1.0 - b.tuck * 1.1 + b.leap * 0.25);
    turn('L_Knee', AX, b.swim * 0.25 * (1 + Math.sin(t * 1.3 + 1)) * 0.5 + b.walk * 0.7 * Math.max(0, -Math.cos(b.step)) + b.crouch * 1.9 + b.tuck * 1.6);
    turn('R_Knee', AX, b.swim * 0.25 * (1 - Math.sin(t * 1.3 + 1)) * 0.5 + b.walk * 0.7 * Math.max(0, Math.cos(b.step)) + b.crouch * 1.9 + b.tuck * 1.6);
  };
}

/** Where the astronaut is ahead of the world camera when it reaches the glass, and how tall it is: the climbing-out
 *  astronaut on the desk starts from exactly this size and place on the screen, so the hand-over cannot be seen. */
const AT_GLASS = { ahead: 3.2, height: 2.4, y: -0.15 };

function WorldAstronaut({ url, p }: { url: string; p: React.MutableRefObject<number> }) {
  const g = useRef<THREE.Group>(null);
  const { model, animations, fit } = useAstronaut(url);
  const body = useBody(model, animations, g);
  const e = useMemo(() => new THREE.Euler(), []), qa = useMemo(() => new THREE.Quaternion(), []), qb = useMemo(() => new THREE.Quaternion(), []);
  useFrame(({ clock }) => {
    const el = g.current; if (!el) return;
    const t = clock.elapsedTime, v = p.current, z = worldZ(v);
    // Distance ahead of the camera: close at the start, drifting in as it turns, a steady lead through the tunnel, then it
    // walks up to the glass in the corridor.
    const turn = smooth(T.turn[0], T.turn[1], v);
    const walkIn = smooth(T.corridor[0] + 0.02, T.pull[1], v);
    const ahead = mix(mix(4.6, 15, turn), AT_GLASS.ahead, walkIn);
    // Free fall: tumbling on every axis through the lattice and the blast, upright again in the corridor. The drift stays
    // inside the lattice's central holes.
    const fall = smooth(T.fly, T.grid[0] + 0.03, v) * (1 - smooth(T.corridor[0], T.corridor[0] + 0.035, v));
    const drift = fall * 0.45;
    const crouch = smooth(T.crack[0] - 0.008, T.crack[1], v);
    el.position.set(Math.sin(v * 23 + t * 0.2) * drift, AT_GLASS.y + Math.cos(v * 17) * drift * 0.8 + Math.sin(t * 0.7) * 0.08 * (1 - walkIn) - crouch * 0.28, z - ahead);
    const face = turn * (1 - smooth(T.corridor[0] + 0.01, T.corridor[1], v));          // 0 faces us, 1 faces away
    qa.setFromEuler(e.set(Math.sin(t * 0.5) * 0.06 * (1 - walkIn), face * Math.PI + Math.sin(t * 0.3) * 0.2 * (1 - face) * (1 - walkIn), Math.sin(t * 0.4) * 0.06 * (1 - walkIn)));
    // Free fall as a slow, bounded drift (head dipping, rolling a little each way), never a continuous spin.
    qb.setFromEuler(e.set(0.35 + Math.sin(v * 9 + t * 0.25) * 0.55, Math.PI + Math.sin(v * 5 + t * 0.15) * 0.5, Math.sin(v * 7 + t * 0.2) * 0.6));
    el.quaternion.copy(qa).slerp(qb, fall);
    el.scale.setScalar(AT_GLASS.height);
    el.visible = v < T.burst[0];
    const walk = smooth(T.corridor[0] + 0.01, T.corridor[0] + 0.03, v) * (1 - crouch);
    body({ t, swim: 0.3 + 0.4 * turn + 0.5 * fall - 0.9 * walk - 0.3 * crouch, walk, step: ahead * 2.4, crouch, leap: 0, tuck: 0 });
  });
  return (
    <group ref={g}>
      <primitive object={model} scale={fit.s} position={[-fit.c.x * fit.s, -fit.c.y * fit.s, -fit.c.z * fit.s]} />
    </group>
  );
}

function Earth({ url, p }: { url: string; p: React.MutableRefObject<number> }) {
  const g = useRef<THREE.Group>(null);
  const { scene } = useGLTF(url);
  // Day colours lit by the sun only (city lights kept faint), clouds lit rather than glowing, its own thin blue haze kept,
  // and a blue atmosphere glowing on the rim.
  const model = useMemo(() => {
    const m = scene.clone(true);
    m.traverse((o) => {
      const mesh = o as THREE.Mesh; if (!mesh.isMesh) return;
      const mat = (mesh.material as THREE.MeshStandardMaterial).clone(); mesh.material = mat;
      // No environment light on the planet: the tunnel's overhead light panel would wash its top out white.
      mat.envMapIntensity = 0;
      // The world is drawn into a texture without tone mapping, under a strong key light: the planet's colours are scaled
      // to it, so its lit side stays blue instead of clipping to white.
      if (mat.transparent) { if (mat.map) { mat.opacity = 0.8; mat.color.setScalar(0.45); } mat.emissiveIntensity = 0; } else { mat.color.setScalar(0.42); mat.emissiveIntensity = 0.1; mat.roughnessMap = null; mat.metalnessMap = null; mat.roughness = 0.95; mat.metalness = 0; }
    });
    return m;
  }, [scene]);
  const atmo = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide, uniforms: { uColor: { value: new THREE.Color('#4a8cff') } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
    fragmentShader: 'uniform vec3 uColor; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.2); gl_FragColor = vec4(uColor * f * 2.2, f); }',
  }), []);
  useFrame(({ clock }) => {
    const el = g.current; if (!el) return;
    const v = p.current;
    el.visible = v < T.grid[0];
    el.position.set(0, -69 - smooth(T.turn[0], T.fly + 0.04, v) * 40, -32);
    el.rotation.set(0.25, clock.elapsedTime * 0.012 + 4.4, 0.15);
  });
  // The model is a sphere of radius about 98 (with cloud and haze shells); scaled to 60, its curve reads as a horizon.
  return (
    <group ref={g} scale={60 / 98}>
      <primitive object={model} />
      <mesh scale={104} material={atmo}><sphereGeometry args={[1, 64, 64]} /></mesh>

    </group>
  );
}

function Stars({ count }: { count: number }) {
  const geo = useMemo(() => {
    const rnd = seeded(9), a = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { const r = 30 + rnd() * 110, th = rnd() * Math.PI * 2; a[i * 3] = Math.cos(th) * r; a[i * 3 + 1] = Math.sin(th) * r * 0.7 + 20; a[i * 3 + 2] = 10 - rnd() * 140; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a, 3)); return g;
  }, [count]);
  return <points geometry={geo}><pointsMaterial size={0.18} color="#ffffff" transparent opacity={0.9} depthWrite={false} sizeAttenuation /></points>;
}

// The lattice: one instanced mesh each for the beams, the greebles and their lights. A vertex shader twists the whole
// structure about the flight axis by depth (straight, then anticlockwise, then clockwise) and makes the greebles crawl
// along their beams; uSpin turns it further with the scroll.
const TWIST_GLSL = /* glsl */`
attribute vec4 aMove;
uniform float uTime;
uniform float uSpin;
float twRamp(float z, float a, float b) { return smoothstep(0.0, 1.0, (a - z) / (a - b)); }
float twistAt(float z) { return twRamp(z, ${TWIST_A.toFixed(1)}, ${TWIST_B.toFixed(1)}) * 2.2 - twRamp(z, ${TWIST_B.toFixed(1)}, ${SPIRAL.toFixed(1)}) * 4.4 + twRamp(z, ${SPIRAL.toFixed(1)}, ${GRID_END.toFixed(1)}) * 7.0; }
vec2 twRot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
`;
function twist<M extends THREE.Material>(mat: M, u: { uTime: { value: number }; uSpin: { value: number } }) {
  mat.onBeforeCompile = (s) => {
    s.uniforms.uTime = u.uTime; s.uniforms.uSpin = u.uSpin;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\n${TWIST_GLSL}`)
      .replace('#include <defaultnormal_vertex>', THREE.ShaderChunk.defaultnormal_vertex.replace('transformedNormal = normalMatrix * transformedNormal;',
        '#ifdef USE_INSTANCING\n float twz = (instanceMatrix * vec4(position, 1.0)).z;\n#else\n float twz = position.z;\n#endif\n transformedNormal.xy = twRot(transformedNormal.xy, twistAt(twz) + uSpin);\n transformedNormal = normalMatrix * transformedNormal;'))
      .replace('#include <project_vertex>', THREE.ShaderChunk.project_vertex.replace('mvPosition = modelViewMatrix * mvPosition;',
        'mvPosition.xyz += aMove.xyz * sin(uTime * 1.4 + aMove.w);\n mvPosition.xy = twRot(mvPosition.xy, twistAt(mvPosition.z) + uSpin);\n mvPosition = modelViewMatrix * mvPosition;'));
  };
  mat.customProgramCacheKey = () => 'tb-twist';
  return mat;
}

type Inst = { m: THREE.Matrix4[]; move: number[]; color?: THREE.Color[] };
function instanced(geo: THREE.BufferGeometry, data: Inst) {
  const g = geo.clone();
  g.setAttribute('aMove', new THREE.InstancedBufferAttribute(new Float32Array(data.move), 4));
  return g;
}

function Lattice({ p, dense }: { p: React.MutableRefObject<number>; dense: boolean }) {
  const group = useRef<THREE.Group>(null);
  const u = useMemo(() => ({ uTime: { value: 0 }, uSpin: { value: 0 } }), []);
  const box = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const { beams, greebles, lights } = useMemo(() => {
    // A cubic lattice of square holes facing the camera: at every depth a grid of beams across the whole view, tied to the
    // next grid by beams along the path. The path runs through the middle of the central holes. Greebles cling to the
    // beams and crawl along them; clusters at the joints carry LEDs facing the camera.
    const rnd = seeded(23), C = 3.6, K = dense ? 4 : 3, span = 2 * K * C, LINES = Array.from({ length: 2 * K }, (_, k) => (k - K + 0.5) * C);
    const beams: Inst = { m: [], move: [] }, greebles: Inst = { m: [], move: [] }, lights: Inst = { m: [], move: [], color: [] };
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
    const put = (into: Inst, x: number, y: number, z: number, sx: number, sy: number, sz: number, move: [number, number, number, number] = [0, 0, 0, 0]) => {
      into.m.push(M.compose(pos.set(x, y, z), q, sc.set(sx, sy, sz)).clone()); into.move.push(...move);
    };
    // Lights by depth: white and cyan first, red and teal where it twists one way, green where it twists back, hot white
    // and violet where it winds into the spiral.
    const palette = (z: number) => z > TWIST_A ? ['#e8f4ff', '#5ff6ff', '#9fe8ff'] : z > TWIST_B ? ['#ff3b3b', '#2ef5d0', '#ff7a45'] : z > SPIRAL ? ['#5dff7a', '#c6ff3d', '#2ef5d0'] : ['#ffffff', '#b38cff', '#7fd4ff'];
    const led = (x: number, y: number, z: number, w: number, h: number, crawl: [number, number, number, number], white: number) => {
      put(lights, x, y, z, w, h, 0.03, crawl);
      const pal = rnd() < white ? ['#ffffff'] : palette(z);
      lights.color!.push(new THREE.Color(pal[Math.floor(rnd() * pal.length)]).multiplyScalar(2.4 + rnd() * 3));
    };
    for (let z = GRID_START; z > GRID_END; z -= C) {
      const t = 0.11;
      // The two directions of a grid differ in depth, so their faces never coincide where they cross (no z-fighting).
      for (const u of LINES) { put(beams, 0, u, z, span, t, t * 1.3); put(beams, u, 0, z, t * 1.15, span, t); }
      for (const x of LINES) for (const y of LINES) if (rnd() < 0.5) put(beams, x, y, z - C / 2, t * 0.8, t * 0.8, C);
      // Greebles along the grid's beams, many crawling along their beam.
      const count = dense ? 70 : 30;
      for (let k = 0; k < count; k++) {
        const horiz = rnd() < 0.5, line = LINES[Math.floor(rnd() * LINES.length)], along = (rnd() - 0.5) * span * 0.96;
        const a = 0.1 + rnd() * 0.3, b = 0.1 + rnd() * 0.3, len = 0.25 + rnd() * 1.1, crawl = rnd() < 0.55 ? 0.3 + rnd() * 1.0 : 0, ph = rnd() * 6.28;
        const side = rnd() < 0.5 ? 1 : -1, x = horiz ? along : line + side * (a / 2 + 0.06), y = horiz ? line + side * (b / 2 + 0.06) : along, zz = z + (rnd() - 0.5) * 0.4;
        const mv: [number, number, number, number] = horiz ? [crawl, 0, 0, ph] : [0, crawl, 0, ph];
        const depth = 0.1 + rnd() * 0.35;
        put(greebles, x, y, zz, horiz ? len : a, horiz ? b : len, depth, mv);
        if (rnd() < 0.4) led(x + (rnd() - 0.5) * (horiz ? len * 0.6 : 0), y + (rnd() - 0.5) * (horiz ? 0 : len * 0.6), zz + depth / 2 + 0.03, 0.06 + rnd() * 0.12, 0.04 + rnd() * 0.06, mv, 0.4);
      }
      // Clusters of small parts at the joints, most with an LED.
      for (const x of LINES) for (const y of LINES) {
        if (rnd() > (dense ? 0.32 : 0.18)) continue;
        const parts = 2 + Math.floor(rnd() * 3);
        for (let k = 0; k < parts; k++) {
          const sz = 0.08 + rnd() * 0.22, dx = (rnd() - 0.5) * 0.6, dy = (rnd() - 0.5) * 0.6, zz = z + 0.08 + rnd() * 0.3;
          const crawl: [number, number, number, number] = rnd() < 0.3 ? (rnd() < 0.5 ? [0.2 + rnd() * 0.4, 0, 0, rnd() * 6.28] : [0, 0.2 + rnd() * 0.4, 0, rnd() * 6.28]) : [0, 0, 0, 0];
          const depth = 0.1 + rnd() * 0.3;
          put(greebles, x + dx, y + dy, zz, sz, sz * (0.6 + rnd()), depth, crawl);
          if (rnd() < 0.6) led(x + dx, y + dy, zz + depth / 2 + 0.03, 0.05 + rnd() * 0.08, 0.05 + rnd() * 0.08, crawl, 0.55);
        }
      }
    }
    return { beams, greebles, lights };
  }, [dense]);
  const mats = useMemo(() => ({
    beam: twist(new THREE.MeshStandardMaterial({ color: '#4a4f5c', metalness: 0.9, roughness: 0.22, envMapIntensity: 2.2 }), u),
    greeble: twist(new THREE.MeshStandardMaterial({ color: '#2c3039', metalness: 0.8, roughness: 0.3, envMapIntensity: 1.8 }), u),
    light: twist(new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), u),
  }), [u]);
  const geos = useMemo(() => ({ beam: instanced(box, beams), greeble: instanced(box, greebles), light: instanced(box, lights) }), [box, beams, greebles, lights]);
  const setup = (data: Inst) => (im: THREE.InstancedMesh) => {
    data.m.forEach((m, j) => im.setMatrixAt(j, m));
    data.color?.forEach((c, j) => im.setColorAt(j, c));
    im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
  };
  useFrame(({ clock }) => {
    const v = p.current;
    if (group.current) group.current.visible = v > T.fly - 0.02 && v < T.blast[1] + 0.02;
    u.uTime.value = clock.elapsedTime;
    // On top of the twist in its shape, the lattice turns as you travel: anticlockwise, then back clockwise.
    u.uSpin.value = smooth(T.grid[0] + 0.1, T.grid[0] + 0.2, v) * 0.9 - smooth(T.grid[0] + 0.22, T.grid[1], v) * 1.8;
  });
  return (
    <group ref={group}>
      <instancedMesh args={[geos.beam, mats.beam, beams.m.length]} frustumCulled={false} onUpdate={setup(beams)} />
      <instancedMesh args={[geos.greeble, mats.greeble, greebles.m.length]} frustumCulled={false} onUpdate={setup(greebles)} />
      <instancedMesh args={[geos.light, mats.light, lights.m.length]} frustumCulled={false} onUpdate={setup(lights)} />
    </group>
  );
}

/** The lattice winds into a spiral and blows out: a supernova of light streaks in spiral arms around a white core that
 *  swells as you fall towards it, then flashes into the corridor. Streaks point outward and lengthen as the blast grows. */
const BLAST_Z = -344;   // just before the corridor: the camera reaches the core under the flash
function Supernova({ p, count }: { p: React.MutableRefObject<number>; count: number }) {
  const g = useRef<THREE.Group>(null), core = useRef<THREE.Mesh>(null), glow = useRef<THREE.Mesh>(null);
  const geo = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), []);
  const glowMat = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uI: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec2 vUv; uniform float uI; void main(){ float d = length(vUv - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - d), 3.0); vec3 c = mix(vec3(0.55, 0.65, 1.0), vec3(1.0), pow(max(0.0, 1.0 - d), 8.0)); gl_FragColor = vec4(c * a * uI, 1.0); }',
  }), []);
  const setup = useMemo(() => {
    const rnd = seeded(5), M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
    const inner = ['#ffffff', '#fff2c4', '#cfe6ff'], mid = ['#5ff6ff', '#7fa8ff', '#ffffff'], outer = ['#ff4fa3', '#b38cff', '#ff8a3d', '#5ff6ff'];
    return (im: THREE.InstancedMesh) => {
      for (let i = 0; i < count; i++) {
        const arm = i % 5, r = 0.8 + Math.pow(rnd(), 0.8) * 28, a = (arm / 5) * Math.PI * 2 + r * 0.22 + (rnd() - 0.5) * 0.35;
        pos.set(Math.cos(a) * r, Math.sin(a) * r, BLAST_Z + (rnd() - 0.5) * (6 + r * 0.6));
        q.setFromEuler(e.set(0, (rnd() - 0.5) * 0.3, a + 0.25));   // long axis (x) points outward, leaning with the spiral
        const len = 0.3 + r * (0.08 + rnd() * 0.12), th = 0.03 + rnd() * 0.06;
        im.setMatrixAt(i, M.compose(pos, q, sc.set(len, th, th)));
        const pal = r < 6 ? inner : r < 15 ? mid : outer;
        im.setColorAt(i, new THREE.Color(pal[Math.floor(rnd() * pal.length)]).multiplyScalar(2 + rnd() * 4));
      }
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
    };
  }, [count]);
  useFrame(({ clock }) => {
    const v = p.current, t = clock.elapsedTime, k = smooth(T.grid[1] - 0.03, T.blast[1], v);
    if (g.current) {
      g.current.visible = v > T.grid[1] - 0.06 && v < T.corridor[0] + 0.01;
      // Blow out from the axis: spread 0.35x -> 1.6x and keep turning with the spiral.
      g.current.scale.set(0.35 + k * 1.25, 0.35 + k * 1.25, 1);
      g.current.rotation.z = t * 0.25 + v * 9;
    }
    if (core.current) core.current.scale.setScalar(0.5 + k * 1.8 + Math.sin(t * 6) * 0.06);
    if (glow.current) glowMat.uniforms.uI.value = 0.5 + k * 1.1;
  });
  return (
    <group ref={g}>
      <instancedMesh args={[geo, mat, count]} onUpdate={setup} frustumCulled={false} />
      <mesh ref={core} position={[0, 0, BLAST_Z - 2]}><sphereGeometry args={[1, 32, 32]} /><meshBasicMaterial color={new THREE.Color('#ffffff').multiplyScalar(5)} toneMapped={false} /></mesh>
      <mesh ref={glow} position={[0, 0, BLAST_Z - 1]} material={glowMat}><planeGeometry args={[40, 40]} /></mesh>
      <pointLight position={[0, 0, BLAST_Z + 10]} color="#cfe0ff" intensity={600} distance={70} />
    </group>
  );
}

/** A white flash in front of the camera as the blast opens into the corridor. */
function Flash({ p }: { p: React.MutableRefObject<number> }) {
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#eef3ff', transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false }), []);
  useFrame(() => { const v = p.current; mat.opacity = smooth(T.blast[1] - 0.025, T.blast[1] - 0.008, v) * (1 - smooth(T.blast[1] - 0.004, T.blast[1] + 0.014, v)); });
  return <mesh position={[0, 0, -1]} renderOrder={11} material={mat}><planeGeometry args={[6, 6]} /></mesh>;
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

function Corridor({ p }: { p: React.MutableRefObject<number> }) {
  const g = useRef<THREE.Group>(null);
  const len = CORRIDOR_START - CORRIDOR_END, W = 9, H = 7, zc = (CORRIDOR_START + CORRIDOR_END) / 2;
  const tex = useMemo(() => { const t = corridorTexture(); t.repeat.set(len / 9, 1); return t; }, [len]);
  useFrame(() => { if (g.current) g.current.visible = p.current > T.blast[0]; });
  const wall = (pos: [number, number, number], rot: [number, number, number], w: number) => (
    <mesh position={pos} rotation={rot}><planeGeometry args={[len, w]} /><meshStandardMaterial map={tex} roughness={0.55} side={THREE.DoubleSide} /></mesh>
  );
  return (
    <group ref={g}>
      {wall([-W / 2, 0, zc], [0, Math.PI / 2, 0], H)}
      {wall([W / 2, 0, zc], [0, -Math.PI / 2, 0], H)}
      {wall([0, H / 2, zc], [Math.PI / 2, 0, Math.PI / 2], W)}
      {wall([0, -H / 2, zc], [-Math.PI / 2, 0, Math.PI / 2], W)}
      <mesh position={[0, 0, CORRIDOR_END]}><planeGeometry args={[W, H]} /><meshBasicMaterial color="#cfd8ff" toneMapped={false} /></mesh>
      {Array.from({ length: 8 }, (_, i) => (
        <group key={i} position={[0, 0, CORRIDOR_START - 6 - i * 11]}>
          {/* Glowing blocks set into the walls, in pairs, like light wells. */}
          <mesh position={[i % 2 ? W / 2 - 0.25 : -W / 2 + 0.25, -0.6, 0]}><boxGeometry args={[0.5, 2.4, 1.6]} /><meshBasicMaterial color="#ffffff" toneMapped={false} /></mesh>
          <pointLight position={[0, 2.4, 0]} intensity={36} distance={18} color="#ffffff" />
        </group>
      ))}
    </group>
  );
}

/** The rainbow ring around the view in the tunnel, after the reference site: a thin chromatic halo at the edge of a lens. */
function Halo({ p }: { p: React.MutableRefObject<number> }) {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uOpacity: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 vUv; uniform float uOpacity;
      void main(){ float d = length(vUv - 0.5) * 2.0;
        vec3 c = vec3(exp(-pow((d - 0.88) / 0.06, 2.0)), exp(-pow((d - 0.84) / 0.06, 2.0)), exp(-pow((d - 0.80) / 0.06, 2.0)));
        gl_FragColor = vec4(c * uOpacity * 0.16, 1.0); }`,
  }), []);
  useFrame(() => { const v = p.current; mat.uniforms.uOpacity.value = smooth(T.turn[1] - 0.04, T.words[3], v) * (1 - smooth(T.blast[0], T.blast[1], v)); });
  return <mesh position={[0, 0, -10]} renderOrder={10} material={mat}><planeGeometry args={[11, 11]} /></mesh>;
}

function World({ models, p, small, view }: { models: JourneyModels; p: React.MutableRefObject<number>; small: boolean; view: React.MutableRefObject<{ fov: number; aspect: number }> }) {
  const cam = useRef<THREE.PerspectiveCamera>(null);
  const fog = useMemo(() => new THREE.FogExp2('#000000', 0), []);
  const { scene } = useThree();
  useEffect(() => { scene.fog = fog; scene.background = new THREE.Color('#000000'); }, [scene, fog]);
  const key = useRef<THREE.PointLight>(null);
  useFrame(({ clock }) => {
    const c = cam.current; if (!c) return;
    const v = p.current, z = worldZ(v), t = clock.elapsedTime;
    const sway = smooth(T.fly, T.grid[0], v) * (1 - smooth(T.corridor[0], T.corridor[1], v));
    c.position.set(Math.sin(t * 0.3) * 0.3 * sway, 0.35 * (1 - smooth(T.turn[0], T.fly, v)), z);
    c.lookAt(c.position.x * 0.5, c.position.y * 0.6 - 0.15, z - 10);
    c.rotation.z += Math.sin(v * 9) * 0.06 * sway;
    if (c.fov !== view.current.fov || c.aspect !== view.current.aspect) { c.fov = view.current.fov; c.aspect = view.current.aspect; c.updateProjectionMatrix(); }
    fog.density = 0.022 * smooth(T.fly, T.grid[0], v) * (1 - smooth(T.blast[0], T.blast[1], v)) + 0.006 * smooth(T.blast[0], T.blast[1], v) * (1 - smooth(T.corridor[0], T.corridor[1], v));
    // The travelling key light lights the tunnel; over the Earth it would burn a white spot onto the planet.
    if (key.current) { key.current.position.set(0, 1.5, z - 7); key.current.intensity = 60 * smooth(T.turn[1], T.grid[0], v); }
  });
  return (
    <>
      <PerspectiveCamera ref={cam} makeDefault position={[0, 0.35, 0]} fov={WORLD_FOV} near={0.1} far={500}>
        <Halo p={p} />
        <Flash p={p} />
      </PerspectiveCamera>
      <ambientLight intensity={0.35} />
      <directionalLight position={[8, 6, 4]} intensity={2.6} color="#fff3e2" />
      <directionalLight position={[-6, 2, -6]} intensity={0.7} color="#7f8cff" />
      <pointLight ref={key} intensity={60} distance={30} color="#dfe8ff" />
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={5} color="#ffffff" position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[14, 4, 1]} />
        <Lightformer form="rect" intensity={1.2} color="#9fdcff" position={[6, 0, -2]} scale={[3, 10, 1]} />
        <Lightformer form="rect" intensity={1.2} color="#ffb3d6" position={[-6, 0, -2]} scale={[3, 10, 1]} />
      </Environment>
      <Stars count={small ? 1400 : 3200} />
      <Suspense fallback={null}><Earth url={models.earth} p={p} /></Suspense>
      <Lattice p={p} dense={!small} />
      <Supernova p={p} count={small ? 900 : 2200} />
      <Corridor p={p} />
      <Suspense fallback={null}><WorldAstronaut url={models.astronaut} p={p} /></Suspense>
      {/* Compile every material and upload every texture up front, hidden ones included, so no beat stalls on first sight. */}
      <Preload all />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The desk: the devices, the glass and the astronaut that climbs out.

const SHARDS = (() => {
  // A fan of triangles over the screen around the point of impact (slightly below centre), in screen units (-1..1).
  const rnd = seeded(41), c: [number, number] = [0.04, -0.12], N = 16, ring: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + rnd() * 0.25;
    const dx = Math.cos(a), dy = Math.sin(a), s = Math.min(Math.abs(1.02 / (dx || 1e-6)), Math.abs(1.02 / (dy || 1e-6)));
    ring.push([c[0] + dx * s, c[1] + dy * s]);
  }
  const out: { tri: [number, number][]; dir: THREE.Vector3; spin: THREE.Vector3; speed: number }[] = [];
  ring.forEach((pt, i) => {
    const nx = ring[(i + 1) % N], f = 0.3 + rnd() * 0.3;
    const mid: [number, number] = [c[0] + (pt[0] - c[0]) * f, c[1] + (pt[1] - c[1]) * f], mid2: [number, number] = [c[0] + (nx[0] - c[0]) * f, c[1] + (nx[1] - c[1]) * f];
    for (const tri of [[c, mid, mid2], [mid, pt, nx], [mid, nx, mid2]] as [number, number][][]) {
      const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
      out.push({ tri, dir: new THREE.Vector3(cx - c[0], cy - c[1], 0).normalize(), spin: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(9), speed: 0.6 + rnd() * 1.4 });
    }
  });
  return out;
})();

function crackTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const x = c.getContext('2d')!, rnd = seeded(77);
  x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineCap = 'round';
  const cx = 512 * (1 + 0.04), cy = 512 * (1 + 0.12);
  for (let i = 0; i < 22; i++) {
    let a = (i / 22) * Math.PI * 2 + rnd() * 0.2, px = cx, py = cy;
    x.lineWidth = 1.2 + rnd() * 2.2; x.beginPath(); x.moveTo(px, py);
    for (let s = 0; s < 9; s++) { a += (rnd() - 0.5) * 0.5; const l = 30 + rnd() * 80; px += Math.cos(a) * l; py += Math.sin(a) * l; x.lineTo(px, py); }
    x.stroke();
  }
  for (let r = 40; r < 420; r += 60 + rnd() * 50) { x.lineWidth = 1; x.beginPath(); for (let a = 0; a <= Math.PI * 2 + 0.1; a += 0.3) { const rr = r * (0.85 + rnd() * 0.3); x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } x.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function Glass({ p, sw, sh, solid }: { p: React.MutableRefObject<number>; sw: number; sh: number; solid: boolean }) {
  const shards = useRef<(THREE.Mesh | null)[]>([]);
  const crack = useRef<THREE.Mesh>(null), glint = useRef<THREE.PointLight>(null), glint2 = useRef<THREE.PointLight>(null);
  const crackTex = useMemo(() => crackTexture(), []);
  // Each shard is a thick, bevelled piece of glass (extruded from its outline), so its edges and faces catch the light.
  const geos = useMemo(() => SHARDS.map((s) => {
    const cx = (s.tri[0][0] + s.tri[1][0] + s.tri[2][0]) / 3, cy = (s.tri[0][1] + s.tri[1][1] + s.tri[2][1]) / 3;
    const shape = new THREE.Shape(s.tri.map(([x, y]) => new THREE.Vector2((x - cx) * sw / 2, (y - cy) * sh / 2)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.035, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2 });
    g.translate(0, 0, -0.0175); g.computeVertexNormals();
    return { g, cx: cx * sw / 2, cy: cy * sh / 2 };
  }), [sw, sh]);
  // Real refraction where the device can afford it (a transmission pass); a bright, reflective tinted glass otherwise.
  const mat = useMemo(() => solid
    ? new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 0, roughness: 0.03, transmission: 1, thickness: 0.08, ior: 1.52, clearcoat: 1, clearcoatRoughness: 0.02,
        specularIntensity: 1, specularColor: new THREE.Color('#ffffff'), envMapIntensity: 3, attenuationColor: new THREE.Color('#9fbaff'), attenuationDistance: 0.5, iridescence: 0.25, side: THREE.DoubleSide })
    : new THREE.MeshPhysicalMaterial({ color: '#cfdcff', metalness: 0.1, roughness: 0.02, transparent: true, opacity: 0.5, clearcoat: 1, envMapIntensity: 4, specularIntensity: 1, side: THREE.DoubleSide, depthWrite: false }), [solid]);
  useFrame(({ clock }) => {
    const v = p.current, k = smooth(T.burst[0], T.burst[1] + 0.02, v), on = v >= T.burst[0], t = clock.elapsedTime;
    if (crack.current) { crack.current.visible = v > T.crack[0] && !on; (crack.current.material as THREE.MeshBasicMaterial).opacity = smooth(T.crack[0], T.crack[1], v); }
    SHARDS.forEach((s, i) => {
      const m = shards.current[i]; if (!m) return;
      m.visible = on && k < 0.999;
      const d = k * s.speed;
      m.position.set(geos[i].cx + s.dir.x * d * 2.2, geos[i].cy + s.dir.y * d * 1.6 - k * k * 2.5, d * 4.5);
      m.rotation.set(s.spin.x * k, s.spin.y * k, s.spin.z * k);
    });
    // Two moving lights in front of the screen, so the flying pieces flash as they turn.
    if (glint.current) { glint.current.intensity = on ? 40 * (1 - k * 0.6) : 0; glint.current.position.set(Math.sin(t * 1.3) * 2.5, 1.6, 1.8); }
    if (glint2.current) { glint2.current.intensity = on ? 25 * (1 - k * 0.6) : 0; glint2.current.position.set(-1.8, -1 + Math.cos(t) * 0.6, 2.4); }
  });
  return (
    <group position-z={IMAC.lift + 0.02}>
      <mesh ref={crack} visible={false}><planeGeometry args={[sw, sh]} /><meshBasicMaterial map={crackTex} transparent opacity={0} depthWrite={false} toneMapped={false} /></mesh>
      {geos.map((g, i) => <mesh key={i} ref={(el) => { shards.current[i] = el; }} geometry={g.g} material={mat} visible={false} />)}
      <pointLight ref={glint} color="#ffffff" distance={8} intensity={0} />
      <pointLight ref={glint2} color="#cfe0ff" distance={8} intensity={0} />
    </group>
  );
}

/** The astronaut climbing out. It takes over from the one in the screen at the frame the glass breaks, at the same size
 *  and place on the screen and in the same crouch, then leaps: legs push off, arms swing forward, knees tuck in the air on
 *  an arc towards you, then it drops below the page with its legs dangling. */
function ExitAstronaut({ url, p, worldTan }: { url: string; p: React.MutableRefObject<number>; worldTan: number }) {
  const g = useRef<THREE.Group>(null);
  const { model, animations, fit } = useAstronaut(url);
  const body = useBody(model, animations, g);
  const { camera } = useThree();
  useFrame(({ clock }) => {
    const el = g.current; if (!el) return;
    const v = p.current, t = clock.elapsedTime;
    el.visible = v >= T.burst[0] && v < 0.999;
    if (!el.visible) return;
    // The screen is 2 units tall and shows the world through a lens of half-height tangent worldTan; there the astronaut
    // fills AT_GLASS.height of a view 2 * ahead * worldTan tall. Placed `back` behind the glass, it is scaled up to match.
    const camZ = camera.position.z - IMAC.lift, back = 0.35, D = camZ + back;
    const onScreen = (AT_GLASS.height / (2 * AT_GLASS.ahead * worldTan)) * 2;
    const h0 = onScreen * D / camZ, y0 = ((AT_GLASS.y - 0.28) / (AT_GLASS.ahead * worldTan)) * D / camZ - camera.position.y * back / camZ;
    const k = smooth(T.burst[0], T.burst[1], v), drop = smooth(T.drop[0], T.drop[1], v);
    const zNear = camera.position.z - 2.4;
    // The arc: up and out of the screen, peaking a third of the way, then down towards the bottom of the view.
    const y = mix(y0, -0.55, k) + Math.sin(Math.PI * Math.min(1, k * 1.4)) * 0.35 - drop * drop * 9;
    el.position.set(0.04 + Math.sin(k * 3) * 0.08, y, mix(-back, zNear, 1 - (1 - k) ** 2) + drop * 0.6);
    el.rotation.set(-0.12 + k * 0.35 + drop * 0.55, Math.sin(t * 0.4) * 0.12 * k, Math.sin(k * 6) * 0.06);
    el.scale.setScalar(h0);
    const push = smooth(T.burst[0], T.burst[0] + 0.008, v);
    body({ t, crouch: 1 - push, leap: push * (1 - smooth(T.burst[0] + 0.015, T.burst[0] + 0.03, v)) + drop * 0.6,
      tuck: smooth(T.burst[0] + 0.01, T.burst[0] + 0.025, v) * (1 - smooth(T.burst[1] - 0.012, T.drop[0] + 0.01, v)),
      swim: drop * 0.7, walk: 0, step: 0 });
  });
  return <group ref={g} visible={false}><primitive object={model} scale={fit.s} position={[-fit.c.x * fit.s, -fit.c.y * fit.s, -fit.c.z * fit.s]} /></group>;
}

function Desk({ models, progress, p, small }: { models: JourneyModels; progress: MotionValue<number>; p: React.MutableRefObject<number>; small: boolean }) {
  const { camera, size, viewport, scene } = useThree();
  const night = useMemo(() => new THREE.Color('#07080c'), []);
  const narrow = size.width < 760;
  const aspect = size.width / size.height;
  const ipad = screenSize(IPAD, narrow), imac = screenSize(IMAC, narrow);
  const fillI = fillRect(ipad.sw, ipad.sh, aspect), fillM = fillRect(imac.sw, imac.sh, aspect);
  const tanH = Math.tan(THREE.MathUtils.degToRad(DESK_FOV / 2));
  const dFullI = fillI.rh / 2 / tanH, dFullM = fillM.rh / 2 / tanH;
  // The world camera: a fixed view of the part that fills the viewport, widened to the whole screen in use.
  // A wider world view on a tall phone screen, so the astronaut and the tunnel are not cropped to a sliver.
  const tanW = Math.tan(THREE.MathUtils.degToRad((aspect < 0.8 ? WORLD_FOV * 1.35 : WORLD_FOV) / 2));
  const viewFor = (d: { sw: number; sh: number }, f: { rh: number }) => ({ fov: THREE.MathUtils.radToDeg(2 * Math.atan(tanW * d.sh / f.rh)), aspect: d.sw / d.sh });
  const view = useRef(viewFor(ipad, fillI));
  // One texture size that is sharp enough at full zoom for both screens.
  // The world is drawn at about the canvas's own resolution where it is shown; it never needs more than 2048 px a side.
  // Fixed when the canvas starts: a size that followed the live pixel ratio would rebuild the texture (blank frames) each
  // time the resolution steps down.
  const [q] = useState(() => Math.min(viewport.dpr, 1));
  const texW = Math.min(2048, Math.round(size.width * q * Math.max(ipad.sw / fillI.rw, imac.sw / fillM.rw)));
  const texH = Math.min(2048, Math.round(size.height * q * Math.max(ipad.sh / fillI.rh, imac.sh / fillM.rh)));
  const tab = useRef<THREE.Group>(null), mon = useRef<THREE.Group>(null), screen = useRef<THREE.Mesh>(null);
  // Where the tablet waits beside the intro text, and how far back the camera is then.
  const d0 = narrow ? dFullI * 2.1 : dFullI * 2.6;
  const halfW0 = d0 * tanH * aspect, halfH0 = d0 * tanH;
  const start = narrow ? new THREE.Vector3(0, -halfH0 * 0.28, 0) : new THREE.Vector3(halfW0 * 0.42, -halfH0 * 0.04, 0);
  // The desktop seen whole: about three quarters of the view's height, or 90% of its width on a phone.
  const imacH = 98.5 * imac.k, imacW = imac.sw;
  const dOut = Math.max((imacH / 0.78) / 2 / tanH, (imacW / 0.9) / 2 / tanH / aspect);
  const imacMid = (98.5 / 2 - 64.13) * imac.k;
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    p.current += (progress.get() - p.current) * Math.min(1, dt * 5);
    const v = p.current, z = smooth(T.zoom[0], T.zoom[1], v), useIpad = v < T.swap;
    // Light page around the tablet; once its screen fills the view the room is dark, as the desktop is shown in the dark.
    scene.background = v > T.zoom[1] - 0.01 ? night : null;
    const s = useIpad ? ipad : imac;
    if (tab.current) {
      tab.current.visible = useIpad;
      tab.current.position.lerpVectors(start, new THREE.Vector3(0, 0, 0), z);
      tab.current.rotation.set(mix(narrow ? 0.32 : 0.22, 0, z), mix(narrow ? 0 : -0.52, 0, z), mix(narrow ? 0 : 0.06, 0, z));
    }
    if (mon.current) mon.current.visible = !useIpad;
    const pull = smooth(T.pull[0], T.pull[1], v);
    if (useIpad) camera.position.set(0, 0, mix(d0, dFullI, z));
    else camera.position.set(0, mix(0, imacMid, pull), mix(dFullM, dOut, pull));
    camera.lookAt(0, camera.position.y, 0);
    // The screen follows whichever device is in use; the world camera is reframed for it.
    const parent = useIpad ? tab.current : mon.current, sc = screen.current;
    if (parent && sc) {
      parent.updateMatrixWorld();
      parent.matrixWorld.decompose(sc.position, sc.quaternion, tmp);
      sc.position.add(tmp.set(0, 0, (useIpad ? IPAD : IMAC).lift).applyQuaternion(sc.quaternion));
      sc.scale.set(s.sw, s.sh, 1);
    }
    const nv = useIpad ? viewFor(ipad, fillI) : viewFor(imac, fillM);
    view.current = nv;
  }, -1);
  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[4, 6, 8]} intensity={2.2} />
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={4} color="#ffffff" position={[0, 5, 6]} scale={[10, 3, 1]} />
        <Lightformer form="rect" intensity={2} color="#cdd3ff" position={[-7, 0, 3]} scale={[3, 8, 1]} />
        <Lightformer form="rect" intensity={2} color="#ffffff" position={[7, -1, 3]} scale={[3, 8, 1]} />
      </Environment>
      <group ref={tab}><Suspense fallback={null}><DeviceModel url={models.ipad} spec={IPAD} narrow={narrow} tint={ipadTint} /></Suspense></group>
      <group ref={mon} visible={false}>
        <Suspense fallback={null}><DeviceModel url={models.imac} spec={IMAC} narrow={narrow} tint={imacTint} /></Suspense>
        <Glass p={p} sw={imac.sw} sh={imac.sh} solid={!small} />
        <Suspense fallback={null}><ExitAstronaut url={models.astronaut} p={p} worldTan={Math.tan(THREE.MathUtils.degToRad(viewFor(imac, fillM).fov / 2))} /></Suspense>
      </group>
      <mesh ref={screen} position-z={0.004}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial toneMapped={false}>
          <RenderTexture attach="map" width={texW} height={texH} samples={small ? 0 : 2} anisotropy={4}>
            <World models={models} p={p} small={small} view={view} />
          </RenderTexture>
        </meshBasicMaterial>
      </mesh>
    </>
  );
}

export default function Journey({ progress, reduce, models }: { progress: MotionValue<number>; reduce: boolean; models: JourneyModels }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const p = useRef(0);
  const small = typeof window !== 'undefined' && window.innerWidth < 760;
  const [dpr] = useState(() => budgetDpr(small ? 1.6e6 : 2.4e6));
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && !document.hidden), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={host} className="journey-canvas" aria-hidden="true">
      <Canvas dpr={dpr} camera={{ position: [0, 0, 12], fov: DESK_FOV, near: 0.05, far: 200 }} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        frameloop={reduce ? 'demand' : visible ? 'always' : 'never'}>
        <AdaptiveResolution base={dpr} />
        <Desk models={models} progress={progress} p={p} small={small} />
        <Preload all />
        {!reduce && <FluidFX><Bloom intensity={1.1} luminanceThreshold={0.75} luminanceSmoothing={0.2} mipmapBlur radius={0.7} /></FluidFX>}
      </Canvas>
    </div>
  );
}

// Fetch the models as soon as this chunk loads, so the tablet is ready when the section scrolls in.
export function preloadJourney(m: JourneyModels) { Object.values(m).forEach((u) => useGLTF.preload(u)); }
