import '@fontsource-variable/geist';
import 'lenis/dist/lenis.css';
import '@fontsource-variable/jetbrains-mono';
import './styles/base.css';
import './styles/site.css';
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Outlet, Route, Routes, useLocation } from 'react-router';
import { EvidenceProvider, Footer, Nav, useSmoothScroll } from './components/Shell';
import Overview from './pages/Overview';
import { NextPage } from './components/Interactive';
import { WaterCursor } from './components/Water';
import { useReveal } from './components/Reveal';

const Compare = lazy(() => import('./pages/Compare'));
const Runs = lazy(() => import('./pages/Runs'));
const Run = lazy(() => import('./pages/Run'));
const Policy = lazy(() => import('./pages/Policy').then((m) => ({ default: m.Policy })));
const Outcomes = lazy(() => import('./pages/Policy').then((m) => ({ default: m.Outcomes })));
const Attribution = lazy(() => import('./pages/Attribution').then((m) => ({ default: m.Attribution })));
const Live = lazy(() => import('./pages/Live'));
const Account = lazy(() => import('./pages/Account'));
const Verify = lazy(() => import('./pages/Account').then((m) => ({ default: m.Verify })));
const Reset = lazy(() => import('./pages/Account').then((m) => ({ default: m.Reset })));
const Method = lazy(() => import('./pages/Method').then((m) => ({ default: m.Method })));
const NotFound = lazy(() => import('./pages/Method').then((m) => ({ default: m.NotFound })));

function Layout() {
  useSmoothScroll();
  const loc = useLocation();
  useReveal();
  return (
    <EvidenceProvider>
      <a className="skip" href="#main">Skip to content</a>
      <Nav />
      <main id="main">
        <Suspense fallback={<div className="section wrap"><p className="body ink-2">Loading…</p></div>}><Outlet /></Suspense>
      </main>
      <Footer />
      <NextPage key={loc.pathname} from={loc.pathname} />
      <WaterCursor />
    </EvidenceProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="live" element={<Live />} />
          <Route path="account" element={<Account />} />
          <Route path="account/verify" element={<Verify />} />
          <Route path="account/reset" element={<Reset />} />
          <Route path="compare" element={<Compare />} />
          <Route path="runs" element={<Runs />} />
          <Route path="runs/:id" element={<Run />} />
          <Route path="policy" element={<Policy />} />
          <Route path="outcomes" element={<Outcomes />} />
          <Route path="attribution" element={<Attribution />} />
          <Route path="method" element={<Method />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
