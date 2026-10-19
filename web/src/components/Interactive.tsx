// Interaction pieces shared by the pages: the cursor ribbon, letter-roll text, the pinned card that grows with scroll, and
// the "keep scrolling" hand-off that rolls straight into the next page (an endless tour of the site).
import { motion, useMotionValueEvent, useReducedMotion, useScroll, useTransform, type MotionValue } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router';

/** A thick blue ribbon that trails the pointer inside its parent, each point springing after the one before it. */
export function Ribbon() {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const c = ref.current;
    if (!c || reduce) return;
    const host = c.parentElement!;
    const ctx = c.getContext('2d')!;
    const N = 26;
    const pts = Array.from({ length: N }, () => ({ x: -999, y: -999 }));
    const head = { x: -999, y: -999 };
    let on = false, alpha = 0, raf = 0, w = 0, h = 0;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = () => { w = host.clientWidth; h = host.clientHeight; c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`; };
    const move = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      head.x = e.clientX - r.left; head.y = e.clientY - r.top;
      if (!on) pts.forEach((p) => { p.x = head.x; p.y = head.y; });
      on = true;
    };
    const leave = () => { on = false; };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      alpha += ((on ? 1 : 0) - alpha) * 0.08;
      pts[0].x += (head.x - pts[0].x) * 0.42; pts[0].y += (head.y - pts[0].y) * 0.42;
      for (let i = 1; i < N; i++) { pts[i].x += (pts[i - 1].x - pts[i].x) * 0.36; pts[i].y += (pts[i - 1].y - pts[i].y) * 0.36; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (alpha < 0.01) return;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = `rgba(36, 51, 255, ${alpha})`;
      for (let i = 1; i < N; i++) {
        ctx.lineWidth = 34 * (1 - i / N) + 2;
        ctx.beginPath(); ctx.moveTo(pts[i - 1].x, pts[i - 1].y); ctx.lineTo(pts[i].x, pts[i].y); ctx.stroke();
      }
    };
    size();
    const ro = new ResizeObserver(size); ro.observe(host);
    const touch = (e: TouchEvent) => { const p = e.touches[0]; if (p) move({ clientX: p.clientX, clientY: p.clientY } as PointerEvent); };
    host.addEventListener('pointermove', move); host.addEventListener('pointerleave', leave);
    host.addEventListener('touchstart', touch, { passive: true }); host.addEventListener('touchmove', touch, { passive: true }); host.addEventListener('touchend', leave);
    tick();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); host.removeEventListener('pointermove', move); host.removeEventListener('pointerleave', leave);
      host.removeEventListener('touchstart', touch); host.removeEventListener('touchmove', touch); host.removeEventListener('touchend', leave); };
  }, [reduce]);
  return <canvas ref={ref} className="ribbon" aria-hidden="true" />;
}

/** Text whose letters roll up to a copy of themselves on hover of the nearest `.roll-host`, one after another. */
export function Roll({ children }: { children: string }) {
  return (
    <span className="roll">
      <span className="sr-only">{children}</span>
      <span className="roll-letters" aria-hidden="true">
        {[...children].map((ch, i) => (
          <span key={i} className="roll-ch" style={{ '--i': i } as React.CSSProperties} data-ch={ch === ' ' ? ' ' : ch}>{ch === ' ' ? ' ' : ch}</span>
        ))}
      </span>
    </span>
  );
}

/** A card pinned in view that grows from an inset to the full width while two words slide apart (the "reel"). */
export function GrowCard({ left, right, children, label }: { left: string; right: string; children: (t: MotionValue<number>) => ReactNode; label: string }) {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end end'] });
  const t = useTransform(scrollYProgress, [0.15, 0.7], [0, 1], { clamp: true });
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640;
  const inset = useTransform(t, [0, 1], [narrow ? '7%' : '11%', '0%']);
  const radius = useTransform(t, [0, 1], [28, 20]);
  const lx = useTransform(t, [0, 1], ['0%', '-32%']);
  const rx = useTransform(t, [0, 1], ['0%', '32%']);
  const words = useTransform(t, [0.55, 0.9], [1, 0]);
  return (
    <section ref={ref} className={`grow ${reduce ? 'is-static' : ''}`} aria-label={label}>
      <div className="grow-sticky">
        <div className="crossrow" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <span key={i}>+</span>)}</div>
        <motion.div className="grow-card" style={reduce ? undefined : { marginInline: inset, borderRadius: radius }}>
          {children(t)}
          <div className="grow-words" aria-hidden="true">
            <motion.span style={reduce ? { opacity: 0 } : { x: lx, opacity: words }}>{left}</motion.span>
            <motion.span style={reduce ? { opacity: 0 } : { x: rx, opacity: words }}>{right}</motion.span>
          </div>
        </motion.div>
        <div className="crossrow" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <span key={i}>+</span>)}</div>
      </div>
    </section>
  );
}

/** The site's page order for the endless scroll: the last page hands back to the first. */
export const TOUR: { path: string; title: string }[] = [
  { path: '/', title: 'The story' },
  { path: '/how', title: 'How it works' },
  { path: '/compare', title: 'Compare defenses' },
  { path: '/runs', title: 'Every run' },
  { path: '/policy', title: 'Why calls were stopped' },
  { path: '/outcomes', title: 'How runs ended' },
  { path: '/attribution', title: 'The audit' },
  { path: '/method', title: 'The evidence index' },
  { path: '/live', title: 'Run it live' },
];

/** After the footer: keep scrolling and the next page arrives. Only a person's own scrolling (wheel, touch, keys) can
 *  finish the hand-off, so a script that scrolls the page never navigates by accident. */
export function NextPage({ from }: { from: string }) {
  const i = TOUR.findIndex((p) => p.path === from);
  const next = TOUR[(i + 1) % TOUR.length];
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const reduce = useReducedMotion();
  const human = useRef(Number.NEGATIVE_INFINITY);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const mark = () => { human.current = performance.now(); };
    const evs = ['wheel', 'touchmove', 'keydown'] as const;
    evs.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, mark));
  }, []);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end end'] });
  const fill = useTransform(scrollYProgress, [0.2, 0.97], [0, 1], { clamp: true });
  const y = useTransform(scrollYProgress, [0, 1], ['30%', '0%']);
  useMotionValueEvent(scrollYProgress, 'change', (v) => {
    if (done || v < 0.985 || reduce) return;
    if (performance.now() - human.current > 1500) return;
    setDone(true);
    nav(next.path);
  });
  return (
    <div ref={ref} className="next" aria-label={`Next: ${next.title}`}>
      <div className="next-sticky">
        <motion.div className="next-inner" style={reduce ? undefined : { y }}>
          <p className="next-kicker">{reduce ? 'Next page' : 'Keep scrolling'}</p>
          <a className="next-title" href={next.path} onClick={(e) => { e.preventDefault(); nav(next.path); }}>{next.title}</a>
          <div className="next-bar" aria-hidden="true"><motion.span style={{ scaleX: fill }} /></div>
        </motion.div>
      </div>
    </div>
  );
}

/** The barrel: as an element travels up the screen it rotates like a panel on the inside of a drum, tipped back at the
 *  bottom of the viewport, flat in the middle, tipped forward at the top. Returns the rotation in degrees and a matching
 *  depth, both driven by the element's own scroll position. */
export function useBarrel(ref: RefObject<HTMLElement | null>, max = 34) {
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const rotateX = useTransform(scrollYProgress, [0, 0.5, 1], reduce ? [0, 0, 0] : [max, 0, -max]);
  const z = useTransform(scrollYProgress, [0, 0.5, 1], reduce ? [0, 0, 0] : [-120, 0, -120]);
  const opacity = useTransform(scrollYProgress, [0, 0.12, 0.88, 1], reduce ? [1, 1, 1, 1] : [0.35, 1, 1, 0.35]);
  return { rotateX, z, opacity };
}

/** A block that rides the barrel. */
export function Barrel({ children, className = '', max }: { children: ReactNode; className?: string; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { rotateX, z, opacity } = useBarrel(ref, max);
  return <motion.div ref={ref} className={`barrel ${className}`} style={{ rotateX, z, opacity, transformPerspective: 1100 }}>{children}</motion.div>;
}
