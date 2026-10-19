// The page's water field (lib/fluid.ts) applied inside a WebGL scene, as on the reference site: each pixel is shifted by
// the wake at its place on the screen, with the red and blue channels pulled a little further apart than the green, so the
// moving water bends what the scene draws with a thin rainbow edge. Works in every browser. Put <FluidFX /> inside a
// Canvas, optionally with extra effects (bloom in the journey).
import { useFrame, useThree } from '@react-three/fiber';
import { EffectComposer } from '@react-three/postprocessing';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { forwardRef, useMemo, type ReactElement } from 'react';
import * as THREE from 'three';
import { fluid } from '../lib/fluid';

const FRAG = /* glsl */ `
uniform sampler2D uField;
uniform vec4 uRect;      // the canvas in viewport units: x, y (from the top left), width, height
uniform float uStrength;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 vp = vec2(uRect.x + uv.x * uRect.z, uRect.y + (1.0 - uv.y) * uRect.w);
  vec4 f = texture2D(uField, vp);
  vec2 v = (f.rg - 0.5) * 2.0;
  vec2 off = vec2(v.x, -v.y) * uStrength;
  float r = texture2D(inputBuffer, uv - off * 1.25).r;
  float g = texture2D(inputBuffer, uv - off).g;
  float b = texture2D(inputBuffer, uv - off * 0.75).b;
  outputColor = vec4(r, g, b, inputColor.a);
}`;

class FluidEffectImpl extends Effect {
  constructor() {
    super('FluidEffect', FRAG, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['uField', new THREE.Uniform(null)], ['uRect', new THREE.Uniform(new THREE.Vector4(0, 0, 1, 1))], ['uStrength', new THREE.Uniform(0.06)],
      ]),
    });
  }
}

const FluidEffect = forwardRef<FluidEffectImpl>(function FluidEffect(_, ref) {
  const effect = useMemo(() => new FluidEffectImpl(), []);
  const { gl } = useThree();
  const tex = useMemo(() => ({ t: null as THREE.DataTexture | null, size: -1, version: -1 }), []);
  useFrame(() => {
    if (tex.size !== fluid.size) {
      tex.t?.dispose();
      tex.t = new THREE.DataTexture(fluid.data, fluid.cols, fluid.rows, THREE.RGBAFormat);
      tex.t.magFilter = tex.t.minFilter = THREE.LinearFilter;
      tex.size = fluid.size; tex.version = -1;
      effect.uniforms.get('uField')!.value = tex.t;
    }
    if (tex.t && tex.version !== fluid.version) { tex.t.image.data = fluid.data; tex.t.needsUpdate = true; tex.version = fluid.version; }
    const r = gl.domElement.getBoundingClientRect();
    effect.uniforms.get('uRect')!.value.set(r.left / innerWidth, r.top / innerHeight, r.width / innerWidth, r.height / innerHeight);
  });
  return <primitive ref={ref} object={effect} dispose={null} />;
});

export function FluidFX({ children }: { children?: ReactElement | ReactElement[] }) {
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      <FluidEffect />
      {children ?? <></>}
    </EffectComposer>
  );
}
