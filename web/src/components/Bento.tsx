// Bento grid and card. A card follows the pointer with a soft glow and a small spring tilt, presses in on pointer-down
// (feedback on the press, not the release), and is a plain card under reduced motion.
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';

const SPRING = { stiffness: 260, damping: 26, mass: 0.6 };

export function Bento({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bento ${className}`}>{children}</div>;
}

export function Card({ children, span = 4, rows = 1, tone, className = '', style, label }:
  { children: ReactNode; span?: 3 | 4 | 5 | 6 | 7 | 8 | 12; rows?: 1 | 2; tone?: 'accent' | 'safe' | 'danger'; className?: string; style?: CSSProperties; label?: string }) {
  const reduce = useReducedMotion();
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const rx = useSpring(useTransform(py, [0, 1], [3, -3]), SPRING);
  const ry = useSpring(useTransform(px, [0, 1], [-4, 4]), SPRING);
  const glowX = useTransform(px, (v) => `${v * 100}%`);
  const glowY = useTransform(py, (v) => `${v * 100}%`);
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    px.set((e.clientX - r.left) / r.width);
    py.set((e.clientY - r.top) / r.height);
  };
  const leave = () => { px.set(0.5); py.set(0.5); };
  return (
    <motion.article aria-label={label} className={`card span-${span} rows-${rows} ${tone ? `tone-${tone}` : ''} ${className}`}
      style={{ ...style, ...(reduce ? {} : { rotateX: rx, rotateY: ry, transformPerspective: 900, '--gx': glowX, '--gy': glowY } as object) }}
      onPointerMove={reduce ? undefined : move} onPointerLeave={reduce ? undefined : leave}
      whileTap={reduce ? undefined : { scale: 0.985 }}
      initial={{ opacity: 0, y: reduce ? 0 : 28 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '0px 0px -10% 0px' }}
      transition={{ type: 'spring', bounce: 0, duration: 0.6 }}>
      <div className="card-glow" aria-hidden="true" />
      <div className="card-body">{children}</div>
    </motion.article>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}
