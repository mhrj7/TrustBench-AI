// Water under the cursor, in every browser (the field itself is lib/fluid.ts):
//  - the wake: a fixed, pointer-transparent 2D canvas over the page draws the moving water as a lit liquid surface (clear
//    blue body, white highlight, blue shade, iridescent rim); it is the same in every browser, Safari and phones included,
//    is never dropped (no WebGL context to lose), and clears when the water settles;
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

/** The visible wake over the page, in every browser. Drawn with Canvas 2D, not WebGL: browsers cap how many WebGL
 *  contexts a page may hold (Safari and iPhone the fewest) and, past the cap or on a refresh before the old page's
 *  contexts are released, silently drop the oldest one, which made the water vanish on some loads. A 2D canvas has no
 *  such limit, is never dropped, and is never blocked.
 *
 *  Each frame the water field (one cell per grid square) is shaded as a lit liquid surface (the flow speed is its height
 *  and the slope its normal, lit from the top left): a clear blue body, a white highlight on the lit side, a deeper blue
 *  on the far side and an iridescent rim. The small image is then drawn smoothly scaled over the whole window. */
function WaterWake() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const cell = document.createElement('canvas');
    const cctx = cell.getContext('2d')!;
    let img: ImageData | null = null;
    const scale = 0.5;   // the wake is soft: half resolution is plenty
    const size = () => { c.width = Math.round(innerWidth * scale); c.height = Math.round(innerHeight * scale); };
    size();
    addEventListener('resize', size);
    const Lx = -0.5, Ly = 0.7, Lz = 0.6, Ln = Math.hypot(Lx, Ly, Lz), lx = Lx / Ln, ly = Ly / Ln, lz = Lz / Ln, lxy = Math.hypot(lx, ly);
    const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const draw = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      if (!fluid.active) return;
      const { cols, rows, data } = fluid;
      if (cell.width !== cols || cell.height !== rows || !img) { cell.width = cols; cell.height = rows; img = cctx.createImageData(cols, rows); }
      const out = img.data;
      const speed = (i: number, j: number) => {
        i = Math.min(cols - 1, Math.max(0, i)); j = Math.min(rows - 1, Math.max(0, j));
        const k = (j * cols + i) * 4, vx = (data[k] - 128) / 127, vy = (data[k + 1] - 128) / 127;
        return Math.hypot(vx, vy);
      };
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const k = (j * cols + i) * 4, vx = (data[k] - 128) / 127, vy = (data[k + 1] - 128) / 127, m = Math.hypot(vx, vy);
        const body = smooth(0.015, 0.2, m);
        if (body < 0.003) { out[k + 3] = 0; continue; }
        const gx = speed(i + 1, j) - speed(i - 1, j), gy = speed(i, j - 1) - speed(i, j + 1);
        let nx = -gx * 3, ny = gy * 3, nz = 0.35; const nn = Math.hypot(nx, ny, nz); nx /= nn; ny /= nn; nz /= nn;
        const dl = nx * lx + ny * ly + nz * lz, rz = 2 * dl * nz - lz;            // the reflected light, seen from the front
        const spec = Math.pow(Math.min(1, Math.max(0, rz)), 16);
        // After the reference site (lusion.co): a thin, glassy trail. A faint white haze for the body, a rainbow fringe on
        // its edges whose hues turn with the direction of the flow, and a white glint where the surface catches the light.
        const dx = vx / m, dy = vy / m, phase = 0.5 + 0.5 * (dx * dx - dy * dy) + m * 2.5;
        const rim = smooth(0.04, 0.12, m) * (1 - smooth(0.12, 0.34, m));
        const tr = 0.62 + 0.38 * Math.cos(6.2832 * phase), tg = 0.62 + 0.38 * Math.cos(6.2832 * (phase + 0.33)), tb = 0.72 + 0.28 * Math.cos(6.2832 * (phase + 0.67));
        const r = 0.97 + (tr - 0.97) * rim, g = 0.97 + (tg - 0.97) * rim, b = 1 + (tb - 1) * rim;
        const a = body * 0.2 + rim * 0.42 * body, s = Math.min(0.8, spec * 1.2) * body;
        const A = a * (1 - s) + s;
        out[k] = Math.round(255 * Math.min(1, (r * a * (1 - s) + s) / A));
        out[k + 1] = Math.round(255 * Math.min(1, (g * a * (1 - s) + s) / A));
        out[k + 2] = Math.round(255 * Math.min(1, (b * a * (1 - s) + s) / A));
        out[k + 3] = Math.round(255 * Math.min(0.8, A));
      }
      cctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cell, 0, 0, c.width, c.height);
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
