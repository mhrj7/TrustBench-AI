// Water under the cursor: moving the pointer drops ripples that expand and fade, and each ripple refracts the real page
// beneath it. Each ripple is a fixed, pointer-transparent circle whose backdrop goes through its own SVG displacement filter;
// the displacement map is an expanding ring, pre-drawn as a handful of frames, and its strength decays over the ripple's
// life. Browsers that cannot reference an SVG filter from backdrop-filter (Safari, Firefox) still get the soft highlight
// ring, without the refraction. Off for touch screens and under reduced motion.
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';

const SIZE = 260;       // ripple diameter in CSS px
const FRAMES = 14;      // pre-drawn ring frames
const POOL = 12;        // ripples alive at once
const LIFE = 1100;      // ms
const STRENGTH = 36;    // peak displacement in px

/** One displacement-map frame: a ring at radius `t` (0..1 of the circle), pushing pixels outward on its leading edge and
 *  inward on its trailing edge, encoded as R = x, G = y around 128. */
function ringFrame(t: number) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  const R = 0.12 + t * 0.78, w = 0.16;
  for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
    const dx = (i - SIZE / 2) / (SIZE / 2), dy = (j - SIZE / 2) / (SIZE / 2), r = Math.hypot(dx, dy);
    const u = (r - R) / w;
    const wave = Math.abs(u) < 1 ? Math.sin(u * Math.PI) * (1 - u * u) : 0;
    const edge = r < 1 ? 1 - Math.pow(r, 6) : 0;   // fade to zero at the circle's rim so it never shows a seam
    const nx = r ? dx / r : 0, ny = r ? dy / r : 0;
    const k = (j * SIZE + i) * 4;
    img.data[k] = 128 + 127 * wave * edge * nx;
    img.data[k + 1] = 128 + 127 * wave * edge * ny;
    img.data[k + 2] = 128;
    img.data[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

export function WaterCursor() {
  const reduce = useReducedMotion();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || reduce || !matchMedia('(pointer: fine)').matches) return;
    const refract = CSS.supports('backdrop-filter', 'url(#x)') && !/^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const frames = refract ? Array.from({ length: FRAMES }, (_, f) => ringFrame(f / (FRAMES - 1))) : [];
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    el.appendChild(svg);
    type Drop = { div: HTMLDivElement; img?: SVGFEImageElement; map?: SVGFEDisplacementMapElement; born: number; frame: number };
    const drops: Drop[] = Array.from({ length: POOL }, (_, i) => {
      const div = document.createElement('div');
      div.className = 'ripple';
      div.style.width = div.style.height = `${SIZE}px`;
      el.appendChild(div);
      const d: Drop = { div, born: -1e9, frame: -1 };
      if (refract) {
        const f = document.createElementNS(ns, 'filter');
        f.setAttribute('id', `tb-ripple-${i}`);
        for (const [k, v] of [['x', '0'], ['y', '0'], ['width', `${SIZE}`], ['height', `${SIZE}`], ['filterUnits', 'userSpaceOnUse'], ['primitiveUnits', 'userSpaceOnUse'], ['color-interpolation-filters', 'sRGB']]) f.setAttribute(k, v);
        const img = document.createElementNS(ns, 'feImage');
        for (const [k, v] of [['x', '0'], ['y', '0'], ['width', `${SIZE}`], ['height', `${SIZE}`], ['result', 'map'], ['preserveAspectRatio', 'none']]) img.setAttribute(k, v);
        const map = document.createElementNS(ns, 'feDisplacementMap');
        for (const [k, v] of [['in', 'SourceGraphic'], ['in2', 'map'], ['scale', '0'], ['xChannelSelector', 'R'], ['yChannelSelector', 'G']]) map.setAttribute(k, v);
        f.append(img, map); svg.appendChild(f);
        div.style.setProperty('backdrop-filter', `url(#tb-ripple-${i})`);
        div.style.setProperty('-webkit-backdrop-filter', `url(#tb-ripple-${i})`);
        d.img = img; d.map = map;
      }
      return d;
    });
    let next = 0, lx = -1e4, ly = -1e4, lt = 0, raf = 0, alive = 0;
    const spawn = (x: number, y: number) => {
      const d = drops[next]; next = (next + 1) % POOL;
      d.born = performance.now(); d.frame = -1;
      d.div.style.transform = `translate3d(${x - SIZE / 2}px, ${y - SIZE / 2}px, 0)`;
      if (!alive) raf = requestAnimationFrame(tick);
      alive = POOL;
    };
    const move = (e: PointerEvent) => {
      const now = performance.now();
      const dist = Math.hypot(e.clientX - lx, e.clientY - ly);
      if (dist > 46 || (dist > 6 && now - lt > 140)) { spawn(e.clientX, e.clientY); lx = e.clientX; ly = e.clientY; lt = now; }
    };
    const tick = () => {
      const now = performance.now();
      let live = 0;
      for (const d of drops) {
        const t = (now - d.born) / LIFE;
        if (t >= 1) { if (d.div.style.opacity !== '0') d.div.style.opacity = '0'; continue; }
        live++;
        d.div.style.opacity = String(1 - t * t);
        d.div.style.setProperty('--t', t.toFixed(3));
        if (d.img && d.map) {
          const f = Math.min(FRAMES - 1, Math.floor(t * FRAMES));
          if (f !== d.frame) { d.img.setAttribute('href', frames[f]); d.frame = f; }
          d.map.setAttribute('scale', (STRENGTH * Math.pow(1 - t, 1.4)).toFixed(1));
        }
      }
      alive = live;
      if (live) raf = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => { cancelAnimationFrame(raf); window.removeEventListener('pointermove', move); el.replaceChildren(); };
  }, [reduce]);
  return <div ref={host} className="water" aria-hidden="true" />;
}
