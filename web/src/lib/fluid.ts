// One water field for the whole page, after the reference site: a small velocity field over the viewport that the pointer
// or a finger drags along its path; each frame it carries itself forward (advection), spreads (diffusion) and settles
// (decay). It is shared by three readers: the WebGL scenes (components/FluidFX.tsx, which distort what they draw), the
// light wake drawn over the page (components/Water.tsx) and, in Chromium, the refraction of the page under the water. Encoded as
// RGBA bytes: R = x velocity and G = y velocity around 128, B = speed. The field sleeps when still; `version` changes
// whenever the bytes do, and `size` whenever the grid is reallocated.
export const COLS = 72;
const DECAY = 0.9, RADIUS = 3;

type Listener = () => void;

class Fluid {
  cols = COLS; rows = 40; size = 0; version = 0; active = false;
  data = new Uint8Array(0);
  private vx = new Float32Array(0); private vy = new Float32Array(0); private tx = new Float32Array(0); private ty = new Float32Array(0);
  private px = -1; private py = -1; private last = 0; private raf = 0; private started = false;
  private listeners = new Set<Listener>();

  start() {
    if (this.started || typeof window === 'undefined') return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.started = true;
    this.resize();
    addEventListener('resize', () => this.resize());
    addEventListener('pointermove', (e) => this.move(e.clientX, e.clientY), { passive: true });
    addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) this.move(t.clientX, t.clientY); }, { passive: true });
    addEventListener('touchstart', (e) => { const t = e.touches[0]; if (t) { this.px = -1; this.move(t.clientX, t.clientY); } }, { passive: true });
    addEventListener('touchend', () => { this.px = -1; }, { passive: true });
    // Leaving the window (to the tabs, the address bar, past an edge) ends the stroke; otherwise the first move after coming
    // back would drag the water in a long streak from the point where the pointer left.
    document.documentElement.addEventListener('mouseleave', () => { this.px = -1; });
    addEventListener('blur', () => { this.px = -1; });
  }

  /** Called whenever the field changes (each frame while it moves, and once more when it settles). */
  on(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  private resize() {
    this.rows = Math.max(16, Math.round((COLS * innerHeight) / Math.max(1, innerWidth)));
    const n = COLS * this.rows;
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.tx = new Float32Array(n); this.ty = new Float32Array(n);
    this.data = new Uint8Array(n * 4);
    for (let k = 0; k < n; k++) { this.data[k * 4] = 128; this.data[k * 4 + 1] = 128; this.data[k * 4 + 3] = 255; }
    this.size++; this.version++;
  }

  private splat(cx: number, cy: number, dx: number, dy: number) {
    const r2 = RADIUS * RADIUS, rows = this.rows;
    for (let j = Math.max(0, Math.floor(cy - RADIUS)); j <= Math.min(rows - 1, Math.ceil(cy + RADIUS)); j++)
      for (let i = Math.max(0, Math.floor(cx - RADIUS)); i <= Math.min(COLS - 1, Math.ceil(cx + RADIUS)); i++) {
        const d2 = (i - cx) ** 2 + (j - cy) ** 2;
        if (d2 > r2) continue;
        const w = Math.exp(-d2 / (r2 * 0.35));
        this.vx[j * COLS + i] += dx * w; this.vy[j * COLS + i] += dy * w;
      }
  }

  private move(x: number, y: number) {
    const cx = (x / innerWidth) * COLS, cy = (y / innerHeight) * this.rows, now = performance.now();
    // A pause of more than a fifth of a second also starts a new stroke.
    if (now - this.last > 200) this.px = -1;
    this.last = now;
    if (this.px >= 0) {
      const dx = cx - this.px, dy = cy - this.py, n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 1.5));
      // Drag the water along the whole path since the last event, not just at its end.
      for (let s = 1; s <= n; s++) this.splat(this.px + (dx * s) / n, this.py + (dy * s) / n, Math.max(-1.6, Math.min(1.6, dx * 0.35)), Math.max(-1.6, Math.min(1.6, dy * 0.35)));
      if (!this.raf) this.raf = requestAnimationFrame(this.tick);
    }
    this.px = cx; this.py = cy;
  }

  private sample(a: Float32Array, x: number, y: number) {
    const rows = this.rows;
    x = Math.min(COLS - 1.001, Math.max(0, x)); y = Math.min(rows - 1.001, Math.max(0, y));
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, k = j * COLS + i;
    return (a[k] * (1 - fx) + a[k + 1] * fx) * (1 - fy) + (a[k + COLS] * (1 - fx) + a[k + COLS + 1] * fx) * fy;
  }

  private tick = () => {
    const { vx, vy, tx, ty, rows } = this;
    let energy = 0;
    for (let j = 0; j < rows; j++) for (let i = 0; i < COLS; i++) {
      const k = j * COLS + i, bx = i - vx[k] * 0.9, by = j - vy[k] * 0.9;
      tx[k] = this.sample(vx, bx, by); ty[k] = this.sample(vy, bx, by);
    }
    for (let j = 1; j < rows - 1; j++) for (let i = 1; i < COLS - 1; i++) {
      const k = j * COLS + i;
      const ax = (tx[k - 1] + tx[k + 1] + tx[k - COLS] + tx[k + COLS]) * 0.25, ay = (ty[k - 1] + ty[k + 1] + ty[k - COLS] + ty[k + COLS]) * 0.25;
      vx[k] = (tx[k] * 0.6 + ax * 0.4) * DECAY; vy[k] = (ty[k] * 0.6 + ay * 0.4) * DECAY;
      energy += Math.abs(vx[k]) + Math.abs(vy[k]);
    }
    // The outer ring of cells is outside the diffusion loop above, so clear it every step: water left on an edge (a stroke
    // that leaves the window through the top or a side) would otherwise never fade, keep feeding the cells next to it, and
    // keep the field from ever settling.
    for (let i = 0; i < COLS; i++) { vx[i] = vy[i] = 0; vx[(rows - 1) * COLS + i] = vy[(rows - 1) * COLS + i] = 0; }
    for (let j = 0; j < rows; j++) { vx[j * COLS] = vy[j * COLS] = 0; vx[j * COLS + COLS - 1] = vy[j * COLS + COLS - 1] = 0; }
    const settled = energy < 0.02 * COLS * rows / 100;
    if (settled) { vx.fill(0); vy.fill(0); }
    const d = this.data;
    for (let k = 0; k < COLS * rows; k++) {
      const a = vx[k] * 40, b = vy[k] * 40;
      d[k * 4] = 128 + Math.max(-127, Math.min(127, a));
      d[k * 4 + 1] = 128 + Math.max(-127, Math.min(127, b));
      d[k * 4 + 2] = Math.min(255, Math.hypot(a, b) * 2);
    }
    this.version++;
    this.active = !settled;
    this.listeners.forEach((fn) => fn());
    this.raf = settled ? 0 : requestAnimationFrame(this.tick);
  };
}

export const fluid = new Fluid();
