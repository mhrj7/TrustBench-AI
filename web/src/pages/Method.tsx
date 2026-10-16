import { Link } from 'react-router';
import { useDataset } from '../lib/data';
import { Reveal } from '../components/Motion';
import { Loading, PageHead } from './Common';

export function Method() {
  const data = useDataset();
  if (data.state !== 'ready') return <Loading state={data} />;
  const { store, runs } = data.value;
  return (
    <>
      <PageHead title="The evidence index">
        This site is a view of one versioned run store. Its version is the SHA-256 over every file below; change one byte of evidence and the version changes.
      </PageHead>
      <section className="wrap stack-48">
        <Reveal className="panel stack-16">
          <dl className="kv">
            <dt>Store version</dt><dd><code translate="no" className="break">{store.store_version}</code></dd>
            <dt>Indexed at commit</dt><dd><code translate="no">{store.git_commit ?? 'unknown'}</code></dd>
            <dt>Exported</dt><dd>{new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(store.exported_at))}</dd>
            <dt>Runs</dt><dd className="num">{runs.length.toLocaleString('en')} ({runs.filter((r) => r.invalid).length} invalid, never counted)</dd>
            <dt>Attribution</dt><dd>{store.attribution_file ? <><code>{store.attribution_file.path}</code>, localizer {store.attribution_file.localizer_version}</> : 'not indexed'}</dd>
            <dt>Redaction</dt><dd>{store.redaction.mode}; {store.redaction.sensitive_values} registered sensitive values, matched in any dash or space spelling</dd>
          </dl>
        </Reveal>
        <div className="grid" style={{ rowGap: 32 }}>
          <Reveal className="span-6 stack-16">
            <h2 className="statement">How to check a number yourself</h2>
            <ol className="body ink-2 steps">
              <li>Open any cell, bar or count; the drawer lists the runs it counts.</li>
              <li>Open a run; its raw record shows the report file, SHA-256 and JSON pointer.</li>
              <li>Hash the file in the repository and compare: <code>shasum -a 256 &lt;report&gt;</code>.</li>
              <li>Recompute every aggregate from the raw records: <code>npm run verify:dashboard</code>.</li>
            </ol>
          </Reveal>
          <Reveal i={1} className="start-8 stack-16">
            <h2 className="statement">What this site does not show</h2>
            <p className="body ink-2">Unredacted payloads (they stay in the repository), the sealed holdout split, and any confirmatory estimate: these are pilot runs on the development split. See the <Link to="/attribution">attribution audit</Link> for how failures are localized.</p>
          </Reveal>
        </div>
        <Reveal className="stack-16">
          <h2 className="statement">Reports in this store</h2>
          <div className="table-wrap" data-lenis-prevent-horizontal><table>
            <thead><tr><th className="numc">#</th><th>Report</th><th className="numc">Runs</th><th>SHA-256</th></tr></thead>
            <tbody>{store.reports.map((r) => (
              <tr key={r.n}><td className="numc ink-3">{r.n}</td><td><code className="break">{r.path.replace('evidence/', '')}</code></td><td className="numc">{r.runs}</td><td><code className="ink-2">{r.sha256.slice(0, 16)}…</code></td></tr>
            ))}</tbody>
          </table></div>
        </Reveal>
      </section>
    </>
  );
}

export function NotFound() {
  return (
    <section className="section wrap stack-24">
      <h1 className="headline">Nothing at this address</h1>
      <p className="body ink-2">The page may have moved. <Link to="/">Go to the overview</Link> or <Link to="/runs">browse all runs</Link>.</p>
    </section>
  );
}
