// How sharply each WebGL canvas draws. A high-density screen at full window size can ask for ten million pixels a frame,
// which no scene here needs (the reference site renders below the device's density too): each canvas gets a pixel budget,
// and drops its resolution further, by steps, while frames come too slowly (drei's PerformanceMonitor).
import { PerformanceMonitor } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { createElement } from 'react';

/** The device pixel ratio for a canvas of about the window's size that should draw at most `budget` pixels. */
export function budgetDpr(budget: number, max = 2) {
  if (typeof window === 'undefined') return 1;
  return Math.max(0.6, Math.min(window.devicePixelRatio || 1, max, Math.sqrt(budget / Math.max(1, innerWidth * innerHeight))));
}

/** Put inside a Canvas: lowers the pixel ratio from `base` (down to 60% of it) while the frame rate stays low, and raises
 *  it again when frames recover. */
export function AdaptiveResolution({ base }: { base: number }) {
  const setDpr = useThree((s) => s.setDpr);
  return createElement(PerformanceMonitor, {
    factor: 1, flipflops: 4, bounds: (): [number, number] => [45, 58],
    onChange: ({ factor }: { factor: number }) => setDpr(Math.round(base * (0.6 + 0.4 * factor) * 100) / 100),
    onFallback: () => setDpr(Math.round(base * 0.6 * 100) / 100),
  });
}
