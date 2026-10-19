// How sharply each WebGL canvas draws. A high-density screen at full window size can ask for ten million pixels a frame,
// which no scene here needs (the reference site renders below the device's density too): each canvas gets a pixel budget,
// and drops its resolution further, by steps, while frames come too slowly (drei's PerformanceMonitor).
import { PerformanceMonitor } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { createElement, useRef } from 'react';

/** The device pixel ratio for a canvas of about the window's size that should draw at most `budget` pixels. */
export function budgetDpr(budget: number, max = 2) {
  if (typeof window === 'undefined') return 1;
  return Math.max(0.6, Math.min(window.devicePixelRatio || 1, max, Math.sqrt(budget / Math.max(1, innerWidth * innerHeight))));
}

/** Put inside a Canvas: while the frame rate stays low, lowers the pixel ratio from `base` in two steps (75%, then 60%)
 *  and never raises it again during the visit. Raising and lowering would resize the canvas back and forth, and every
 *  resize shows as a flicker. */
export function AdaptiveResolution({ base }: { base: number }) {
  const setDpr = useThree((s) => s.setDpr);
  const step = useRef(0);
  return createElement(PerformanceMonitor, {
    bounds: (): [number, number] => [42, 120], flipflops: Infinity,
    onDecline: () => { if (step.current >= 2) return; step.current += 1; setDpr(Math.round(base * (step.current === 1 ? 0.75 : 0.6) * 100) / 100); },
  });
}
