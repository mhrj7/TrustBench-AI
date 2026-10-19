// Water under the cursor, in every browser (the field itself is lib/fluid.ts):
//  - the wake: a fixed, pointer-transparent WebGL canvas over the page draws the moving water as a light, smoky trail with a
//    faint blue and pink edge, after the reference site; it works in Safari and on phones, and clears when the water settles;
//  - the WebGL scenes distort what they draw by the same field (components/FluidFX.tsx);
//  - in Chromium browsers with a mouse (Chrome, Brave, Edge), the page under the water ripples too: an SVG displacement
//    filter used as backdrop-filter, applied only to a box around the moving water (cropped to the cells that are moving),
//    never to the whole window, which halved the frame rate on high-density screens. WebKit cannot filter a backdrop with
//    SVG, so Safari shows the wake and the scenes' distortion.
// Off under reduced motion.
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { fluid } from '../lib/fluid';

const ID = 'tb-water';
const STRENGTH = 64;   // pixels of bend at full flow: clearly water under a gentle stroke, readable when still
const canRefract = () => matchMedia('(pointer: fine)').matches && CSS.supports('backdrop-filter', `url(#${ID})`) && !/^((?!chrome|android).)*safari/i.test(navigator.userAgent);

export function WaterCursor() {
  const reduce = useReducedMotion();
  const [refract] = useState(() => typeof window !== 'undefined' && canRefract());
  useEffect(() => { if (!reduce) fluid.start(); }, [reduce]);
  if (reduce) return null;
  return <><WaterWake />{refract && <WaterRefraction />}</>;
}

const VERT = `attribute vec2 p; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `precision mediump float; varying vec2 uv; uniform sampler2D field;
void main(){
  vec4 f = texture2D(field, vec2(uv.x, 1.0 - uv.y));
  vec2 v = (f.rg - 0.5) * 2.0;
  float m = length(v);
  float a = smoothstep(0.03, 0.3, m);
  // Shaded like a liquid surface, so it reads on the light page as well as over the dark scenes: the side facing the
  // light is a white highlight, the other a blue-violet shade, with a thin iridescent rim whose hue follows the flow.
  vec2 d = m > 0.0001 ? v / m : vec2(0.0);
  float lit = dot(d, normalize(vec2(-0.6, -0.8)));
  vec3 col = mix(vec3(0.28, 0.30, 0.78), vec3(1.0), 0.5 + 0.5 * lit);
  vec3 tint = mix(vec3(0.35, 0.45, 1.0), vec3(1.0, 0.42, 0.78), 0.5 + 0.5 * sin(atan(v.y, v.x) * 2.0));
  float edge = smoothstep(0.06, 0.18, m) * (1.0 - smoothstep(0.18, 0.5, m));
  col = mix(col, tint, edge * 0.9);
  float alpha = a * 0.36;
  gl_FragColor = vec4(col * alpha, alpha);
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

/** Chromium with a mouse: the page under the moving water ripples. Only a box around the moving cells is filtered (the
 *  filter's cost grows with its area), updated 30 times a second, and nothing is filtered once the water settles. */
function WaterRefraction() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true'); svg.style.position = 'absolute';
    const filter = document.createElementNS(ns, 'filter'), flood = document.createElementNS(ns, 'feFlood'), feImg = document.createElementNS(ns, 'feImage'),
      over = document.createElementNS(ns, 'feComposite'), disp = document.createElementNS(ns, 'feDisplacementMap');
    filter.setAttribute('id', ID);
    for (const [k, v] of [['filterUnits', 'userSpaceOnUse'], ['primitiveUnits', 'userSpaceOnUse'], ['color-interpolation-filters', 'sRGB'], ['x', '0'], ['y', '0']]) filter.setAttribute(k, v);
    // The map sits on neutral grey (no shift). Each update loads a new image asynchronously; until it has decoded, an empty
    // map would shift the whole box by half the strength (a box-shaped jump following the cursor). On grey it shifts nothing.
    for (const [k, v] of [['flood-color', 'rgb(128,128,128)'], ['result', 'neutral']]) flood.setAttribute(k, v);
    for (const [k, v] of [['x', '0'], ['y', '0'], ['preserveAspectRatio', 'none'], ['result', 'img']]) feImg.setAttribute(k, v);
    for (const [k, v] of [['in', 'img'], ['in2', 'neutral'], ['operator', 'over'], ['result', 'map']]) over.setAttribute(k, v);
    for (const [k, v] of [['in', 'SourceGraphic'], ['in2', 'map'], ['scale', String(STRENGTH)], ['xChannelSelector', 'R'], ['yChannelSelector', 'G']]) disp.setAttribute(k, v);
    filter.append(flood, feImg, over, disp); svg.appendChild(filter); el.appendChild(svg);
    const layer = document.createElement('div'); layer.className = 'water-layer'; el.appendChild(layer);
    let on = false, odd = false, pending = false;
    // The box for the current stroke: set when the water starts moving and only ever grown, never moved, so the map and
    // the box cannot fall out of step (a moving box with a map one frame behind showed ghost copies of the text).
    let bi0 = 0, bj0 = 0, bi1 = -1, bj1 = -1;
    const show = (v: boolean) => {
      if (v === on) return;
      on = v;
      const f = v ? `url(#${ID})` : 'none';
      layer.style.setProperty('backdrop-filter', f); layer.style.setProperty('-webkit-backdrop-filter', f);
      layer.style.display = v ? 'block' : 'none';
    };
    show(false);
    const update = () => {
      if (!fluid.active) { show(false); bi1 = -1; return; }
      odd = !odd;
      if (!odd) return;   // 30 updates a second is smooth enough, and half the work
      // The moving cells' bounding box, two cells of margin, in grid cells.
      const { cols, rows, data } = fluid;
      let i0 = cols, i1 = -1, j0 = rows, j1 = -1;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) if (data[(j * cols + i) * 4 + 2] > 6) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
      if (i1 < 0) { show(false); bi1 = -1; return; }
      // A wide margin of still water, so the ripple fades to nothing well inside the box.
      i0 = Math.max(0, i0 - 4); j0 = Math.max(0, j0 - 4); i1 = Math.min(cols - 1, i1 + 4); j1 = Math.min(rows - 1, j1 + 4);
      if (bi1 >= 0) { i0 = Math.min(i0, bi0); j0 = Math.min(j0, bj0); i1 = Math.max(i1, bi1); j1 = Math.max(j1, bj1); }
      bi0 = i0; bj0 = j0; bi1 = i1; bj1 = j1;
      const w = i1 - i0 + 1, h = j1 - j0 + 1, cw = innerWidth / cols, ch = innerHeight / rows;
      const crop = new Uint8ClampedArray(w * h * 4);
      for (let j = 0; j < h; j++) crop.set(data.subarray(((j0 + j) * cols + i0) * 4, ((j0 + j) * cols + i0 + w) * 4), j * w * 4);
      // The outermost cells are forced to still water (no shift), so nothing near the border is pulled from outside the box.
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (i === 0 || j === 0 || i === w - 1 || j === h - 1) { const k = (j * w + i) * 4; crop[k] = 128; crop[k + 1] = 128; crop[k + 2] = 0; }
      canvas.width = w; canvas.height = h;
      ctx.putImageData(new ImageData(crop, w, h), 0, 0);
      const bw = Math.round(w * cw), bh = Math.round(h * ch), url = canvas.toDataURL('image/png');
      const box = { left: `${Math.round(i0 * cw)}px`, top: `${Math.round(j0 * ch)}px`, width: `${bw}px`, height: `${bh}px` };
      // Decode the new map first, then switch the map and move the box in the same frame: moving the box while the old map
      // is still shown would lay that map over the wrong part of the page (ghost copies of the text).
      if (pending) return;
      pending = true;
      const img = new Image();
      img.onload = img.onerror = () => {
        pending = false;
        if (!fluid.active) return;
        for (const n of [filter, flood, feImg]) { n.setAttribute('width', String(bw)); n.setAttribute('height', String(bh)); }
        feImg.setAttribute('href', url);
        Object.assign(layer.style, box);
        show(true);
      };
      img.src = url;
    };
    const off = fluid.on(update);
    return () => { off(); el.replaceChildren(); };
  }, []);
  return <div ref={host} className="water" aria-hidden="true" />;
}
