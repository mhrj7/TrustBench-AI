import { useGLTF } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';

// The device models shared by the home page's journey (Journey.tsx) and the How it works model (SystemModel.tsx).
// Each model's screen is described in the model's own units: both files face +x (the screen's normals point
// that way, and the desktop's foot reaches forward under it). The device is turned to face +z, scaled so the screen is 2
// units tall and moved so the screen is centred on its group's origin. The desktop's glass leans back about 10 degrees on
// its hinge; the model is tipped by that much so the glass is upright and the full-screen hand-off stays exact.
export type DeviceSpec = { center: [number, number, number]; w: number; h: number; landscape: boolean; lift: number; tilt: number };
export const IPAD: DeviceSpec = { center: [1.062, 2.07, -4.373], w: 3.44 * 0.925, h: 4.74 * 0.948, landscape: true, lift: 0.004, tilt: 0 };
// The desktop's chin and rim stand a little proud of its glass, so its screen surface is lifted in front of them.
export const IMAC: DeviceSpec = { center: [2.3, 64.13, 0], w: 111.9, h: Math.hypot(61.82, 10.9), landscape: false, lift: 0.04, tilt: Math.atan2(10.9, 61.82) };
const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
export function screenSize(d: DeviceSpec, narrow: boolean) {
  const k = 2 / d.h, w = d.w * k, land = d.landscape && !narrow;
  return { k, sw: land ? 2 : w, sh: land ? w : 2, rot: land ? -Math.PI / 2 : 0 };
}

export function DeviceModel({ url, spec, narrow, tint }: { url: string; spec: DeviceSpec; narrow: boolean; tint: (m: THREE.Mesh) => void }) {
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

export const ipadTint = (m: THREE.Mesh) => { m.castShadow = false; const mat = m.material as THREE.MeshStandardMaterial; if (mat) { mat.envMapIntensity = 1.4; } };
export const imacTint = (m: THREE.Mesh) => {
  const n = m.name;
  // Re-coloured to a dark aluminium with a black bezel, so the screen reads like a studio display.
  const metal = new THREE.MeshStandardMaterial({ color: '#2a2c33', metalness: 0.9, roughness: 0.32, envMapIntensity: 1.3 });
  if (/Stand|LightBlue|Rotate|DarkBlue/.test(n)) m.material = metal;
  else if (/White|Black/.test(n)) m.material = new THREE.MeshStandardMaterial({ color: '#07080b', metalness: 0.2, roughness: 0.4 });
  else if (/Screen_Screen/.test(n)) m.visible = false;
};

