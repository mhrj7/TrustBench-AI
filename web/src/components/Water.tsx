// Water under the cursor, in every browser (the field itself is lib/fluid.ts):
//  - the wake: a fixed, pointer-transparent WebGL canvas over the page draws the moving water as a light, smoky trail with a
//    faint blue and pink edge, after the reference site; it works in Safari and on phones, and clears when the water settles;
//  - the WebGL scenes distort what they draw by the same field (components/FluidFX.tsx).
// As on the reference site, the page's own text is not refracted: a full-window SVG displacement filter did that in
// Chromium and halved the frame rate on high-density screens while the pointer moved. Off under reduced motion.
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { fluid } from '../lib/fluid';

export function WaterCursor() {
  const reduce = useReducedMotion();
  useEffect(() => { if (!reduce) fluid.start(); }, [reduce]);
  if (reduce) return null;
  return <WaterWake />;
}

const VERT = `attribute vec2 p; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `precision mediump float; varying vec2 uv; uniform sampler2D field;
void main(){
  vec4 f = texture2D(field, vec2(uv.x, 1.0 - uv.y));
  vec2 v = (f.rg - 0.5) * 2.0;
  float m = length(v);
  float a = smoothstep(0.02, 0.35, m);
  // A soft white body with a thin iridescent edge whose hue follows the direction of the flow.
  float ang = atan(v.y, v.x);
  vec3 tint = mix(vec3(0.42, 0.48, 1.0), vec3(1.0, 0.55, 0.85), 0.5 + 0.5 * sin(ang * 2.0));
  float edge = smoothstep(0.08, 0.2, m) * (1.0 - smoothstep(0.2, 0.5, m));
  vec3 col = mix(vec3(1.0), tint, edge * 0.8);
  gl_FragColor = vec4(col * a * 0.42, a * 0.42);
}`;

/** The visible wake over the page, in every browser. */
function WaterWake() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const gl = c.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) return;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const scale = 0.5;   // the wake is soft: half resolution is plenty
    const size = () => { c.width = Math.round(innerWidth * scale); c.height = Math.round(innerHeight * scale); gl.viewport(0, 0, c.width, c.height); };
    size();
    addEventListener('resize', size);
    const draw = () => {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fluid.cols, fluid.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, fluid.data);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (fluid.active) gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const off = fluid.on(draw);
    return () => { off(); removeEventListener('resize', size); };
  }, []);
  return <canvas ref={ref} className="water-wake" aria-hidden="true" />;
}
