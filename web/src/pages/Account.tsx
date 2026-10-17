import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { type Catalog, type Job, type Me, changePassword, deleteAccount, deleteRun, ensureSession, forgotPassword, getCatalog, login, logout, me,
  myRuns, resendVerification, resetPassword, signup, tokenFromHash, verifyEmail } from '../lib/live';
import { short } from '../lib/format';
import { Reveal } from '../components/Motion';
import { PageHead } from './Common';

type Tab = 'signin' | 'signup' | 'forgot';

export default function Account() {
  const [who, setWho] = useState<Me | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const refresh = () => ensureSession().then(me).then(setWho).catch((e) => setOffline(String(e.message ?? e)));
  useEffect(() => { getCatalog().then(setCatalog).catch(() => undefined); refresh(); }, []);
  return (
    <>
      <PageHead title={who?.kind === 'account' ? 'Your account' : 'Sign in or create an account'}>
        {who?.kind === 'account'
          ? 'Runs you start while signed in are kept for your account on every device.'
          : `An account is optional: you can run everything as a guest. With one, your runs are kept for ${catalog?.auth?.accounts.retention_days ?? 30} days on every device instead of ${catalog?.auth?.retention_hours ?? 24} hours in this browser, and a verified account gets ${catalog?.auth?.accounts.verified_quota_multiplier ?? 3}× the run limits.`}
      </PageHead>
      <section className="wrap stack-32">
        {offline && <p className="panel body" role="status">The live-test service is not reachable from this copy of the site ({offline}).</p>}
        {who?.kind === 'account' ? <Profile who={who} onChange={refresh} /> : who && <SignIn catalog={catalog} onDone={refresh} />}
      </section>
    </>
  );
}

function SignIn({ catalog, onDone }: { catalog: Catalog | null; onDone: () => void }) {
  const [tab, setTab] = useState<Tab>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const minLength = catalog?.auth?.accounts.password_min_length ?? 12;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null); setMsg(null);
    try {
      if (tab === 'signin') { const s = await login(email, password); setPassword(''); setMsg(s.claimed_runs ? `Signed in. ${s.claimed_runs} guest run(s) moved to your account.` : 'Signed in.'); onDone(); }
      if (tab === 'signup') { setMsg((await signup(email, password)).message + ' Open the link in that email to finish; it signs you in.'); setPassword(''); }
      if (tab === 'forgot') setMsg((await forgotPassword(email)).message);
    } catch (x) { setErr(String((x as Error).message)); } finally { setBusy(false); }
  };
  const delivery = catalog?.auth?.accounts.email_delivery;
  return (
    <Reveal className="stack-24">
      <div className="segmented" role="tablist" aria-label="Account">
        {([['signin', 'Sign in'], ['signup', 'Create account'], ['forgot', 'Forgot password']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => { setTab(k); setErr(null); setMsg(null); }}>{label}</button>
        ))}
      </div>
      <form className="stack-24 account-form" onSubmit={submit}>
        <label className="field"><span>Email</span>
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        {tab !== 'forgot' && (
          <label className="field"><span>Password{tab === 'signup' ? ` (at least ${minLength} characters)` : ''}</span>
            <input className="input" type="password" autoComplete={tab === 'signup' ? 'new-password' : 'current-password'} required minLength={tab === 'signup' ? minLength : undefined}
              value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        )}
        {err && <p className="body" role="alert">{err}</p>}
        {msg && <p className="body" role="status">{msg}</p>}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Working…' : tab === 'signin' ? 'Sign in' : tab === 'signup' ? 'Create account' : 'Send reset link'}</button>
          {tab === 'signin' && err?.includes('verify') && <button type="button" className="btn btn-secondary" onClick={async () => setMsg((await resendVerification(email)).message)}>Send a new verification link</button>}
        </div>
      </form>
      <p className="small ink-2">Passwords are hashed with scrypt and never stored or logged. Repeated wrong passwords lock the account for a while.
        {delivery === 'outbox' ? ' This deployment has no outgoing mail configured, so verification and reset emails are not delivered; use the site as a guest.' : ''}
        {' '}Prefer not to sign up? <Link to="/live">Run it live as a guest</Link>.</p>
    </Reveal>
  );
}

function Profile({ who, onChange }: { who: Extract<Me, { kind: 'account' }>; onChange: () => void }) {
  const nav = useNavigate();
  const [runs, setRuns] = useState<Job[] | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => myRuns().then(setRuns).catch((e) => setErr(String(e.message)));
  useEffect(() => { load(); }, []);
  const act = async (f: () => Promise<unknown>, ok: string) => { setErr(null); setMsg(null); try { await f(); setMsg(ok); } catch (e) { setErr(String((e as Error).message)); } };
  return (
    <Reveal className="stack-48">
      <div className="verdicts">
        <div><span className="small ink-2">Signed in as</span><span className="body">{who.email}</span></div>
        <div><span className="small ink-2">Email</span><span className="body">{who.verified ? 'verified' : 'not verified'}</span></div>
        <div><span className="small ink-2">Runs kept for</span><span className="body">{who.retention_days} days</span></div>
        <div><span className="small ink-2">Run limits</span><span className="body">{who.quota_multiplier}× guest</span></div>
      </div>
      {err && <p className="body" role="alert">{err}</p>}
      {msg && <p className="body" role="status">{msg}</p>}
      <div className="stack-8">
        <h2 className="headline" style={{ fontSize: 28 }}>Your runs</h2>
        {runs === null ? <p className="body ink-2">Loading…</p> : runs.length === 0 ? <p className="body ink-2">No runs yet. <Link to="/live">Start one</Link>.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Started</th><th>Status</th><th>Defense</th><th>Model</th><th>Pairs</th><th /></tr></thead>
            <tbody>{runs.map((j) => (
              <tr key={j.id}><td>{j.created_at.replace('T', ' ').slice(0, 16)}</td><td>{j.status}</td><td>{j.system}</td><td>{j.model ? short(j.model.id) : 'scripted'}</td><td>{j.pairs}</td>
                <td><div className="row" style={{ gap: 8 }}><Link className="btn btn-secondary btn-sm" to={`/live?run=${j.id}`}>Open</Link>
                  <button className="btn btn-secondary btn-sm" onClick={() => act(async () => { await deleteRun(j.id); await load(); }, 'Run deleted with all its files.')}>Delete</button></div></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <form className="stack-24 account-form" onSubmit={(e) => { e.preventDefault(); act(async () => { await changePassword(current, next); setCurrent(''); setNext(''); }, 'Password changed. Other devices were signed out.'); }}>
        <h2 className="headline" style={{ fontSize: 28 }}>Change password</h2>
        <label className="field"><span>Current password</span><input className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label className="field"><span>New password</span><input className="input" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <div><button className="btn btn-secondary" type="submit">Change password</button></div>
      </form>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" onClick={() => act(async () => { await logout(); onChange(); }, 'Signed out.')}>Sign out</button>
      </div>
      <form className="stack-24 account-form panel" onSubmit={(e) => { e.preventDefault(); act(async () => { await deleteAccount(confirm); nav('/live'); }, 'Account deleted.'); }}>
        <h2 className="headline" style={{ fontSize: 28 }}>Delete account</h2>
        <p className="small ink-2">Removes the account, every run it owns with all their files, and every signed-in session. This cannot be undone.</p>
        <label className="field"><span>Password to confirm</span><input className="input" type="password" autoComplete="current-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        <div><button className="btn btn-secondary" type="submit">Delete my account</button></div>
      </form>
    </Reveal>
  );
}

/** /account/verify#token=...: the emailed verification link; it signs the new account in. */
export function Verify() {
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [detail, setDetail] = useState('');
  useEffect(() => {
    const token = tokenFromHash();
    if (!token) { setState('error'); setDetail('This link has no token.'); return; }
    verifyEmail(token).then((s) => { setState('done'); setDetail(s.claimed_runs ? `${s.claimed_runs} guest run(s) from this browser moved to your account.` : ''); history.replaceState(null, '', location.pathname); })
      .catch((e) => { setState('error'); setDetail(String(e.message)); });
  }, []);
  return (
    <>
      <PageHead title={state === 'done' ? 'Email verified' : state === 'error' ? 'Verification failed' : 'Verifying…'}>{detail}</PageHead>
      <section className="wrap"><div className="row" style={{ gap: 12 }}><Link className="btn btn-primary" to="/live">Run it live</Link><Link className="btn btn-secondary" to="/account">Your account</Link></div></section>
    </>
  );
}

/** /account/reset#token=...: the emailed password reset link. */
export function Reset() {
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'form' | 'done'>('form');
  const [err, setErr] = useState<string | null>(null);
  const token = tokenFromHash();
  return (
    <>
      <PageHead title={state === 'done' ? 'Password reset' : 'Choose a new password'}>{state === 'done' ? 'Every device was signed out. Sign in with the new password.' : 'The link works once and expires soon.'}</PageHead>
      <section className="wrap">
        {state === 'done' ? <Link className="btn btn-primary" to="/account">Sign in</Link> : (
          <form className="stack-24 account-form" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await resetPassword(token ?? '', password); setPassword(''); setState('done'); history.replaceState(null, '', location.pathname); } catch (x) { setErr(String((x as Error).message)); } }}>
            <label className="field"><span>New password</span><input className="input" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            {err && <p className="body" role="alert">{err}</p>}
            <div><button className="btn btn-primary" type="submit" disabled={!token}>Set new password</button></div>
          </form>
        )}
      </section>
    </>
  );
}
