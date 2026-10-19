import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react';
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';

/** The launch film (web/public/media, kept out of git; the deployed site serves it). */
export const FILM_SRC = '/media/trustbench-launch.mp4';
export const FILM_POSTER = '/media/trustbench-launch-poster.jpg';

/**
 * A full-screen player for the launch film: the picture on black, PAUSE / progress / MUTE along the bottom, and a white
 * circle with an X that follows the pointer and closes the film on click (it shrinks away over the controls so they stay
 * usable). Touch screens get a fixed close button instead. Esc closes, Space pauses, M mutes.
 */
export function FilmPlayer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return createPortal(<AnimatePresence>{open && <Film onClose={onClose} />}</AnimatePresence>, document.body);
}

function Film({ onClose }: { onClose: () => void }) {
  const reduce = useReducedMotion();
  const video = useRef<HTMLVideoElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const [overControls, setOverControls] = useState(false);
  const [seen, setSeen] = useState(false); // the pointer has moved inside the film at least once
  const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  const x = useMotionValue(typeof window !== 'undefined' ? window.innerWidth / 2 : 0);
  const y = useMotionValue(typeof window !== 'undefined' ? window.innerHeight / 2 : 0);
  const sx = useSpring(x, reduce ? { duration: 0 } : { stiffness: 380, damping: 32, mass: 0.6 });
  const sy = useSpring(y, reduce ? { duration: 0 } : { stiffness: 380, damping: 32, mass: 0.6 });

  // lock the page behind the film, give focus to the close control, restore both on close
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = 'hidden';
    closeBtn.current?.focus({ preventScroll: true });
    return () => { html.style.overflow = before; prev?.focus?.({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === ' ' && (e.target as HTMLElement)?.tagName !== 'BUTTON') { e.preventDefault(); toggle(); }
      else if (e.key.toLowerCase() === 'm') setMuted((m) => !m);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => { if (video.current) video.current.muted = muted; }, [muted]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => setPlaying(false));
    else v.pause();
  };
  const seek = (e: RPointerEvent<HTMLDivElement>) => {
    const v = video.current;
    if (!v || !v.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    v.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * v.duration;
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    x.set(e.clientX); y.set(e.clientY);
    if (!seen) { sx.jump(e.clientX); sy.jump(e.clientY); setSeen(true); }
    setOverControls(!!(e.target as HTMLElement).closest('[data-film-control]'));
  };

  return (
    <motion.div className="film" role="dialog" aria-modal="true" aria-label="TrustBench launch film" data-lenis-prevent
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : 0.35, ease: [0.23, 1, 0.32, 1] }}
      onPointerMove={move} onPointerLeave={() => setOverControls(true)}
      onClick={(e) => { if (!coarse && !(e.target as HTMLElement).closest('[data-film-control]')) onClose(); }}>
      <video ref={video} className="film-video" src={FILM_SRC} poster={FILM_POSTER} autoPlay playsInline preload="auto"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setProgress(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)}
        onError={() => setFailed(true)} />
      {failed && <p className="film-missing">The film isn't part of this build. Watch it on the live site.</p>}

      <a className="film-mark" href="/" aria-label="TrustBench home" data-film-control onClick={(e) => { e.preventDefault(); onClose(); }}>
        <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="7" y="9" width="18" height="3" fill="currentColor" /><rect x="14.5" y="12" width="3" height="12" fill="currentColor" /><rect x="20" y="20" width="5" height="4" fill="#FFB21F" /></svg>
      </a>
      <a className="film-cta" href="/live" data-film-control>Run it live</a>

      <div className="film-bar" data-film-control>
        <button type="button" className="film-btn" onClick={toggle}>{playing ? 'Pause' : 'Play'}</button>
        <div className="film-track" role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e); }} onPointerMove={(e) => { if (e.buttons === 1) seek(e); }}
          onKeyDown={(e) => { const v = video.current; if (!v) return; if (e.key === 'ArrowRight') v.currentTime += 5; if (e.key === 'ArrowLeft') v.currentTime -= 5; }}>
          <div className="film-fill" style={{ transform: `scaleX(${progress})` }} />
        </div>
        <button type="button" className="film-btn" onClick={() => setMuted((m) => !m)}>{muted ? 'Unmute' : 'Mute'}</button>
      </div>

      <button ref={closeBtn} type="button" className={`film-close ${coarse ? 'is-fixed' : 'is-sr'}`} aria-label="Close film" data-film-control={coarse || undefined} onClick={onClose}>
        <CloseIcon />
      </button>
      {!coarse && (
        <motion.div className="film-cursor" aria-hidden="true" style={{ x: sx, y: sy }}
          animate={{ scale: seen && !overControls ? 1 : 0 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
          <CloseIcon />
        </motion.div>
      )}
    </motion.div>
  );
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5 L19 19 M19 5 L5 19" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" /></svg>;
}
