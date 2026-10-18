import Lenis from 'lenis';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Run } from '../lib/aggregate';
import { runPath, useDataset } from '../lib/data';
import { short } from '../lib/format';
import { Roll } from './Interactive';

const LINKS = [['/compare', 'Compare'], ['/runs', 'Runs'], ['/policy', 'Policy'], ['/outcomes', 'Outcomes'], ['/attribution', 'Attribution'], ['/account', 'Account']] as const;

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    // While the menu sheet is open the page behind it does not scroll, and Escape closes it.
    if (!open) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => { document.documentElement.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on(); window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <header className="nav" data-scrolled={scrolled || open} data-open={open} data-lenis-prevent={open || undefined}>
      <div className="wrap">
        <Link to="/" className="wordmark" aria-label="TrustBench, home"><span className="wordmark-mark" aria-hidden="true" />TrustBench</Link>
        <nav className="nav-links" aria-label="Main">
          {LINKS.map(([to, label]) => <NavLink key={to} to={to} className="roll-host"><Roll>{label}</Roll></NavLink>)}
        </nav>
        <Link to="/method" className="btn btn-secondary roll-host"><Roll>Evidence index</Roll></Link>
        <Link to="/live" className="btn btn-primary roll-host"><span className="btn-dot" /><Roll>Run it live</Roll></Link>
        <button className="nav-toggle" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Menu'}</button>
        {open && (
          <nav id="mobile-nav" className="nav-links" aria-label="Main (mobile)">
            {LINKS.map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}
            <NavLink to="/method">Evidence index</NavLink>
            <NavLink to="/live">Run it live</NavLink>
          </nav>
        )}
      </div>
    </header>
  );
}

export function Footer() {
  const data = useDataset();
  const store = data.state === 'ready' ? data.value.store : null;
  return (
    <footer className="footer">
      <div className="wrap stack-48">
        <div className="footer-word" aria-hidden="true">TrustBench</div>
        <div className="grid" style={{ rowGap: 32 }}>
          <p className="span-6 body ink-2">A benchmark for prompt-injection defenses in autonomous agents. The run views here are development-split evidence; the two confirmatory holdout results (TB-032 to TB-034) are reported in the repository's docs.</p>
          <div className="start-8 small stack-8">
            {store && <p>Run store <code translate="no">{store.store_version.slice(0, 12)}</code>, {store.reports.length} reports</p>}
            <p className="ink-2">Payloads are redacted in this site. Raw records stay in the repository.</p>
            <p><Link to="/method">How to verify these numbers</Link></p>
          </div>
        </div>
      </div>
    </footer>
  );
}

/** Smooth scrolling (Lenis) for pointer devices; native scrolling under reduced motion. Resets scroll on navigation. */
export function useSmoothScroll() {
  const reduce = useReducedMotion();
  const loc = useLocation();
  const lenis = useRef<Lenis | null>(null);
  useEffect(() => {
    if (reduce) return;
    // lerp-based smoothing (Lenis default feel), its own frame loop, smooth in-page anchor links offset under the bar,
    // and nested scrollers (drawer, run lists, menu sheet) keep their native scrolling.
    const l = new Lenis({ lerp: 0.085, smoothWheel: true, autoRaf: true, anchors: { offset: -72 }, allowNestedScroll: true });
    lenis.current = l;
    return () => { l.destroy(); lenis.current = null; };
  }, [reduce]);
  useEffect(() => { lenis.current ? lenis.current.scrollTo(0, { immediate: true }) : window.scrollTo(0, 0); }, [loc.pathname]);
}

/* ---- Evidence drawer: the runs behind any aggregate ---- */

export type Evidence = { title: string; summary?: ReactNode; runIds: string[]; counted?: Record<string, 'yes' | 'no' | 'not counted'> };
const EvidenceCtx = createContext<(e: Evidence) => void>(() => {});
export const useEvidence = () => useContext(EvidenceCtx);

export function EvidenceProvider({ children }: { children: ReactNode }) {
  const [ev, setEv] = useState<Evidence | null>(null);
  const loc = useLocation();
  useEffect(() => setEv(null), [loc.pathname]);
  useEffect(() => {
    if (!ev) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setEv(null);
    window.addEventListener('keydown', key);
    document.documentElement.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', key); document.documentElement.style.overflow = ''; };
  }, [ev]);
  const open = useCallback((e: Evidence) => setEv(e), []);
  return (
    <EvidenceCtx.Provider value={open}>
      {children}
      <AnimatePresence>{ev && <Drawer ev={ev} onClose={() => setEv(null)} />}</AnimatePresence>
    </EvidenceCtx.Provider>
  );
}

function Drawer({ ev, onClose }: { ev: Evidence; onClose: () => void }) {
  const reduce = useReducedMotion();
  const data = useDataset();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  // Counted runs first, then runs that did not meet the verdict, then runs not counted (other kinds, invalid).
  const order = { yes: 0, no: 1, 'not counted': 2 } as const;
  const runs = useMemo(() => (data.state === 'ready' ? (ev.runIds.map((id) => data.value.byId.get(id)).filter(Boolean) as Run[])
    .sort((a, b) => (ev.counted ? order[ev.counted[a.run_id] ?? 'not counted'] - order[ev.counted[b.run_id] ?? 'not counted'] : 0)) : []), [data, ev]);
  return (
    <>
      <motion.div className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
      <motion.aside className="drawer" role="dialog" aria-modal="true" aria-label={ev.title} data-lenis-prevent
        initial={{ x: reduce ? 0 : '100%', opacity: reduce ? 0 : 1 }} animate={{ x: 0, opacity: 1 }} exit={{ x: reduce ? 0 : '100%', opacity: reduce ? 0 : 1 }}
        transition={{ duration: 0.42, ease: [0.32, 0.72, 0, 1] }}>
        <button ref={closeRef} className="btn btn-secondary drawer-close" onClick={onClose}>Close</button>
        <div className="stack-24" style={{ clear: 'both', paddingTop: 8 }}>
          <h2 className="headline" style={{ fontSize: 'clamp(28px, 3vw, 40px)' }}>{ev.title}</h2>
          {ev.summary && <div className="body ink-2">{ev.summary}</div>}
          <p className="small ink-2">{runs.length.toLocaleString('en')} runs. Each opens to its redacted raw record, with the report file, SHA-256 and JSON pointer.</p>
          <RunList runs={runs} counted={ev.counted} />
        </div>
      </motion.aside>
    </>
  );
}

export function RunList({ runs, counted, height = 560 }: { runs: Run[]; counted?: Evidence['counted']; height?: number }) {
  const parent = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: runs.length, getScrollElement: () => parent.current, estimateSize: () => 64, overscan: 8 });
  if (!runs.length) return <p className="body ink-2">No runs behind this selection.</p>;
  return (
    <div ref={parent} className="runlist" style={{ maxHeight: height }} data-lenis-prevent role="list" aria-label="Runs">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((it) => {
          const r = runs[it.index];
          const c = counted?.[r.run_id];
          return (
            <Link key={r.run_id} role="listitem" to={runPath(r.run_id)} className="runlist-item" style={{ transform: `translateY(${it.start}px)` }}>
              <span className="runlist-main">
                <span className="runlist-title">{r.case_id} <span className="ink-3">r{r.repetition} · {r.arm}</span></span>
                <span className="runlist-sub ink-2">{short(r.model)} · {r.system} · {r.outcome}{r.invalid ? ' · invalid' : ''}</span>
              </span>
              {c && <span className={`runlist-flag ${c === 'yes' ? 'signal' : 'ink-2'}`}>{c === 'yes' ? 'Counted' : c === 'no' ? 'Not met' : 'Not counted'}</span>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
