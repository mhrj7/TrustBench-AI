// Everything animates in: as text, icons, chips, rows and figures scroll into view they rise out of a short blur, one
// after another within their container. Applied site-wide (below each page's hero) by watching the page for new elements,
// so content added later, such as a story scene that swaps in, animates too. Uses the independent CSS \`translate\`
// property, so it never fights the transforms that motion components set. Off under reduced motion: content is just there.
import { useReducedMotion } from 'motion/react';
import { useEffect } from 'react';
import { useLocation } from 'react-router';

const TARGETS = [
  'p', 'h2', 'h3', 'li', 'dt', 'dd', '.btn', '.chip', '.bubble', '.doc', '.helper', '.gcheck', '.lane', '.verdict', '.figure', '.figure-sm',
  '.ratebar', '.legend', '.sim-step', '.sim-doc', '.sim-verdict', '.switch', '.interval', '.split-row', '.dots-wrap', '.reel-play',
  '.mini-term', '.mini-calls', '.work-tags', '.work-title', '.field', '.segmented', '.heatmap-cell', '.att-col', '.kv',
].map((t) => `main ${t}`).join(',');
// Containers that already animate themselves, or hold long scrolling lists.
const SKIP = '.hx, .stage, .drawer, .runlist, .runtable, table, .journey, .journey-copy, .space-copy, .next, .reel-rows, .sr-only, [data-no-reveal]';

export function useReveal() {
  const reduce = useReducedMotion();
  const loc = useLocation();
  useEffect(() => {
    if (reduce || typeof IntersectionObserver === 'undefined') return;
    const root = document.documentElement;
    root.classList.add('rv-ready');
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) {
        const el = e.target as HTMLElement;
        el.dataset.rv = 'in'; io.unobserve(el);
        // Once revealed, hand the element back to its own transitions (hover, press).
        setTimeout(() => { el.dataset.rv = 'done'; }, 1500);
      }
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.01 });
    const scan = () => {
      document.querySelectorAll<HTMLElement>(TARGETS).forEach((el) => {
        if (el.dataset.rv || el.closest(SKIP)) return;
        // Stagger by position among siblings that are also revealed.
        const sibs = el.parentElement ? [...el.parentElement.children].filter((c) => c.matches(TARGETS)) : [el];
        el.style.setProperty('--rv-i', String(Math.min(8, Math.max(0, sibs.indexOf(el)))));
        el.dataset.rv = 'wait';
        io.observe(el);
      });
    };
    scan();
    let queued = 0;
    const mo = new MutationObserver(() => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; scan(); }); });
    mo.observe(document.querySelector('main') ?? document.body, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); cancelAnimationFrame(queued); };
  }, [reduce, loc.pathname]);
}
