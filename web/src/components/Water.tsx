// Water under the cursor. A small velocity field covers the screen; moving the pointer drags the water along its path,
// and each frame the field carries itself forward (advection), spreads (diffusion) and settles (decay), so the wake
// stretches and curls behind the pointer like a finger drawn through water. The page itself is refracted by that wake:
// one fixed, pointer-transparent layer sends its backdrop through an SVG displacement filter whose map is the field
// (R = x velocity, G = y velocity around 128). The filter is only attached while the water is moving. Chromium supports an
// SVG filter in backdrop-filter; phones and Safari (WebKit) cannot, so they have no water effect. Off under reduced motion.
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

const COLS = 72;          // field resolution across the screen (coarse: the map is stretched smoothly anyway)
const STRENGTH = 34;      // displacement in px at full field strength: a light ripple, not deep water
const DECAY = 0.9;        // per-frame settling: the wake is gone in well under a second
const RADIUS = 3;         // pointer splat radius, in cells
const ID = 'tb-water';

/** True where the page itself can be refracted: Chromium, with a mouse or trackpad. */
const canRefract = () => matchMedia('(pointer: fine)').matches && CSS.supports('backdrop-filter', `url(#${ID})`) && !/^((?!chrome|android).)*safari/i.test(navigator.userAgent);

export function WaterCursor() {
  const reduce = useReducedMotion();
  const [refract] = useState(() => typeof window !== 'undefined' && canRefract());
  if (reduce) return null;
  // Phones and Safari cannot refract the page; they get no water rather than a stand-in.
  return refract ? <WaterRefraction /> : null;
}

function WaterRefraction() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let W = innerWidth, H = innerHeight, rows = Math.max(16, Math.round((COLS * H) / W));
    let vx = new Float32Array(COLS * rows), vy = new Float32Array(COLS * rows), tx = new Float32Array(COLS * rows), ty = new Float32Array(COLS * rows);
    const canvas = document.createElement('canvas');
    canvas.width = COLS; canvas.height = rows;
    const ctx = canvas.getContext('2d')!;
    let img = ctx.createImageData(COLS, rows);

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true'); svg.style.position = 'absolute';
    const filter = document.createElementNS(ns, 'filter');
    const feImg = document.createElementNS(ns, 'feImage');
    const disp = document.createElementNS(ns, 'feDisplacementMap');
    filter.setAttribute('id', ID);
    for (const [k, v] of [['filterUnits', 'userSpaceOnUse'], ['primitiveUnits', 'userSpaceOnUse'], ['color-interpolation-filters', 'sRGB'], ['x', '0'], ['y', '0']]) filter.setAttribute(k, v);
    for (const [k, v] of [['x', '0'], ['y', '0'], ['preserveAspectRatio', 'none'], ['result', 'map']]) feImg.setAttribute(k, v);
    for (const [k, v] of [['in', 'SourceGraphic'], ['in2', 'map'], ['scale', String(STRENGTH)], ['xChannelSelector', 'R'], ['yChannelSelector', 'G']]) disp.setAttribute(k, v);
    filter.append(feImg, disp); svg.appendChild(filter); el.appendChild(svg);
    const layer = document.createElement('div');
    layer.className = 'water-layer';
    el.appendChild(layer);
    const size = () => {
      W = innerWidth; H = innerHeight; rows = Math.max(16, Math.round((COLS * H) / W));
      vx = new Float32Array(COLS * rows); vy = new Float32Array(COLS * rows); tx = new Float32Array(COLS * rows); ty = new Float32Array(COLS * rows);
      canvas.height = rows; img = ctx.createImageData(COLS, rows);
      for (const n of [filter, feImg]) { n.setAttribute('width', String(W)); n.setAttribute('height', String(H)); }
    };
    size();

    let px = -1, py = -1, raf = 0, running = false, attached = false;
    const splat = (cx: number, cy: number, dx: number, dy: number) => {
      const r2 = RADIUS * RADIUS;
      for (let j = Math.max(0, Math.floor(cy - RADIUS)); j <= Math.min(rows - 1, Math.ceil(cy + RADIUS)); j++)
        for (let i = Math.max(0, Math.floor(cx - RADIUS)); i <= Math.min(COLS - 1, Math.ceil(cx + RADIUS)); i++) {
          const d2 = (i - cx) ** 2 + (j - cy) ** 2;
          if (d2 > r2) continue;
          const w = Math.exp(-d2 / (r2 * 0.35));
          vx[j * COLS + i] += dx * w; vy[j * COLS + i] += dy * w;
        }
    };
    const sample = (a: Float32Array, x: number, y: number) => {
      x = Math.min(COLS - 1.001, Math.max(0, x)); y = Math.min(rows - 1.001, Math.max(0, y));
      const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, k = j * COLS + i;
      return (a[k] * (1 - fx) + a[k + 1] * fx) * (1 - fy) + (a[k + COLS] * (1 - fx) + a[k + COLS + 1] * fx) * fy;
    };
    const step = () => {
      let energy = 0;
      // Advect: each cell takes the water that was upstream of it, so the wake travels with the motion.
      for (let j = 0; j < rows; j++) for (let i = 0; i < COLS; i++) {
        const k = j * COLS + i, bx = i - vx[k] * 0.9, by = j - vy[k] * 0.9;
        tx[k] = sample(vx, bx, by); ty[k] = sample(vy, bx, by);
      }
      // Diffuse and settle.
      for (let j = 1; j < rows - 1; j++) for (let i = 1; i < COLS - 1; i++) {
        const k = j * COLS + i;
        const ax = (tx[k - 1] + tx[k + 1] + tx[k - COLS] + tx[k + COLS]) * 0.25, ay = (ty[k - 1] + ty[k + 1] + ty[k - COLS] + ty[k + COLS]) * 0.25;
        vx[k] = (tx[k] * 0.6 + ax * 0.4) * DECAY; vy[k] = (ty[k] * 0.6 + ay * 0.4) * DECAY;
        energy += Math.abs(vx[k]) + Math.abs(vy[k]);
      }
      const d = img.data;
      for (let k = 0; k < COLS * rows; k++) {
        d[k * 4] = 128 + Math.max(-127, Math.min(127, vx[k] * 40));
        d[k * 4 + 1] = 128 + Math.max(-127, Math.min(127, vy[k] * 40));
        d[k * 4 + 2] = 128; d[k * 4 + 3] = 255;
      }
      return energy;
    };
    const attach = (on: boolean) => {
      if (on === attached) return;
      attached = on;
      const v = on ? `url(#${ID})` : 'none';
      layer.style.setProperty('backdrop-filter', v); layer.style.setProperty('-webkit-backdrop-filter', v);
    };
    let odd = false;
    const tick = () => {
      const energy = step();
      // Settled: clear the field completely and detach the filter, so no patch of the page stays bent.
      if (energy < 0.02 * COLS * rows / 100) { vx.fill(0); vy.fill(0); running = false; attach(false); return; }
      // The map is re-encoded every other frame (30 a second): smooth enough, and half the work.
      odd = !odd;
      if (odd) { ctx.putImageData(img, 0, 0); feImg.setAttribute('href', canvas.toDataURL('image/png')); attach(true); }
      raf = requestAnimationFrame(tick);
    };
    const move = (e: PointerEvent) => {
      const cx = (e.clientX / W) * COLS, cy = (e.clientY / H) * rows;
      if (px >= 0) {
        const dx = cx - px, dy = cy - py, len = Math.hypot(dx, dy);
        // Drag the water along the whole path since the last event, not just at its end.
        const n = Math.max(1, Math.ceil(len / 1.5));
        for (let s = 1; s <= n; s++) splat(px + (dx * s) / n, py + (dy * s) / n, Math.max(-1.6, Math.min(1.6, dx * 0.35)), Math.max(-1.6, Math.min(1.6, dy * 0.35)));
      }
      px = cx; py = cy;
      if (!running) { running = true; raf = requestAnimationFrame(tick); }
    };
    const leave = () => { px = -1; py = -1; };
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave);
    window.addEventListener('resize', size);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move); document.removeEventListener('pointerleave', leave); window.removeEventListener('resize', size);
      el.replaceChildren();
    };
  }, []);
  return <div ref={host} className="water" aria-hidden="true" />;
}
