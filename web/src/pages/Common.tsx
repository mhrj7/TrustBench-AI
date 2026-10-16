import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { Filters, Run } from '../lib/aggregate';
import type { Loadable } from '../lib/data';
import { dimLabel, value } from '../lib/format';
import { Reveal } from '../components/Motion';

export function Loading<T>({ state }: { state: Loadable<T> }) {
  return (
    <div className="section wrap" aria-live="polite">
      {state.state === 'error' ? <p className="body">Could not load the run store: {state.error}</p> : <p className="body ink-2">Loading the run store…</p>}
    </div>
  );
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="section wrap page-head">
      <div className="grid" style={{ rowGap: 24 }}>
        <Reveal className="span-7"><h1 className="headline page-title">{title}</h1></Reveal>
        {children && <Reveal i={1} className="span-5 page-lede body ink-2">{children}</Reveal>}
      </div>
    </header>
  );
}

/** Filters live in the URL (?model=a,b&system=c), so every view can be linked and reloaded. */
export function useUrlFilters(dims: string[]): [Filters, (dim: string, v: string[]) => void, () => void] {
  const [params, setParams] = useSearchParams();
  const filters: Filters = Object.fromEntries(dims.map((d) => [d, params.get(d) ? params.get(d)!.split(',') : []]));
  const set = (dim: string, v: string[]) => setParams((p) => { const n = new URLSearchParams(p); v.length ? n.set(dim, v.join(',')) : n.delete(dim); return n; }, { replace: true });
  const clear = () => setParams((p) => { const n = new URLSearchParams(p); dims.forEach((d) => n.delete(d)); return n; }, { replace: true });
  return [filters, set, clear];
}

export function useUrlValue(key: string, fallback: string): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  return [params.get(key) ?? fallback, (v) => setParams((p) => { const n = new URLSearchParams(p); v === fallback ? n.delete(key) : n.set(key, v); return n; }, { replace: true })];
}

/** One select per filter dimension; a single value per dimension keeps the control native and accessible. */
export function FilterBar({ runs, dims, filters, set, clear }: { runs: Run[]; dims: string[]; filters: Filters; set: (d: string, v: string[]) => void; clear: () => void }) {
  const active = Object.values(filters).some((v) => v && v.length);
  return (
    <div className="controls filterbar" role="group" aria-label="Filters">
      {dims.map((d) => {
        const options = [...new Set(runs.map((r) => String(r[d as keyof Run])))].sort();
        return (
          <label className="field" key={d}>
            <span>{dimLabel(d)}</span>
            <select className="select" name={d} value={filters[d]?.[0] ?? ''} onChange={(e) => set(d, e.target.value ? [e.target.value] : [])}>
              <option value="">All</option>
              {options.map((o) => <option key={o} value={o}>{value(d, o)}</option>)}
            </select>
          </label>
        );
      })}
      {active && <button className="btn btn-secondary" onClick={clear}>Clear Filters</button>}
    </div>
  );
}
