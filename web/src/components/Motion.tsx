import { animate, motion, useInView, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;

/** Section entrance: rise 24px with opacity, once, staggered by index (60ms). Reduced motion keeps the fade only. */
export function Reveal({ children, i = 0, as = 'div', className }: { children: ReactNode; i?: number; as?: 'div' | 'section' | 'header'; className?: string }) {
  const reduce = useReducedMotion();
  const Tag = motion[as];
  return (
    <Tag className={className} initial={{ opacity: 0, y: reduce ? 0 : 24 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -12% 0px' }} transition={{ duration: 0.7, ease: EASE_OUT, delay: i * 0.06 }}>
      {children}
    </Tag>
  );
}

/** A figure that counts up once when it first enters the viewport. */
export function CountUp({ to, format = (v) => Math.round(v).toLocaleString('en'), className }: { to: number; format?: (v: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '0px 0px -10% 0px' });
  const reduce = useReducedMotion();
  const [v, setV] = useState(reduce ? to : 0);
  useEffect(() => {
    if (!inView || reduce) { if (reduce) setV(to); return; }
    const controls = animate(0, to, { duration: 1.1, ease: EASE_OUT, onUpdate: setV });
    return () => controls.stop();
  }, [inView, to, reduce]);
  return <span ref={ref} className={className} aria-label={format(to)}><span aria-hidden="true">{format(v)}</span></span>;
}
