# TrustBench review site (TB-030)

A static React site over the versioned run store. Every number it shows opens to the runs it counts, and every run opens
to its raw record: report file, SHA-256 and JSON pointer. Design system: `DESIGN.md`, mirrored in the Figma file
"TrustBench — Design system" (https://www.figma.com/design/ZryhjfSxX6T2vC8iYC4Mdg) and in `src/styles/tokens.css`.

```bash
npm run web:data          # from the repository root: export the redacted store into web/public/data
npm run web:dev           # http://127.0.0.1:5173
npm run web:build         # export, typecheck and build into web/dist
npm run test:web          # typecheck, aggregation parity with app/views.py, Playwright on desktop, tablet and mobile
```

## Pages

| Route | Shows | Opens |
| --- | --- | --- |
| `/` | A real run replayed as a timed waterfall; counted figures; attacker success per defense, morphing on scroll from each defense's own paired baseline to its defended rate; benign utility under each defense; attribution accuracy by audit round | Any bar opens its runs |
| `/compare` | Any two dimensions as a heatmap, or one as ranked bars with Wilson intervals; any verdict; filters | Any cell or bar opens its runs, each marked counted or not |
| `/runs` | All runs, filterable and searchable, virtualized | Each run |
| `/runs/:id` | Verdicts, TB-029 attribution, timed waterfall (TB-027 spans) or step order, steps with the policy reason each call received, the gateway audit, final text, the raw record with source hash and download | — |
| `/policy` | Gateway decisions by reason, or denials the agent received from any defense, split by any dimension | Any segment opens its runs |
| `/outcomes` | How runs ended, and evaluator reason codes | Any segment or code opens its runs |
| `/attribution` | Localizer accuracy per audit round with intervals and notes | — |
| `/method` | Store version, commit, every report with its SHA-256, how to verify | — |

All view state (filters, axes, verdict, source) is in the URL.

## Data and redaction

`scripts/export-site-data.py` writes `public/data/` (git-ignored): `store.json`, `runs.json` (one row per run),
`records/<n>.json` (each report's redacted records, loaded on demand), `spans/<n>.json`, and `headline.json` (the
overview's numbers, comparison and recorded example, read from the evidence files named in `configs/site-headline.json`). A static site cannot hide data,
so the export is always redacted (`app/redact.py`); there is no unredacted mode. Raw records stay in the repository.

## Tests

- `src/lib/aggregate.test.ts`: the browser's aggregation equals `app/views.py` cell for cell and run ID for run ID, which
  `scripts/verify-dashboard.py` checks against the raw records.
- `tests/site.spec.ts` (Playwright, installed Chrome, desktop 1440×900, tablet 820×1180, Pixel 7): every page renders with no
  console errors or failed requests, no horizontal overflow, headings within two lines, body text at least 16px; navigation,
  internal links, the evidence drawer (cell → runs → raw record), URL-state controls, replay, JSON depth and download, skip
  link and focus, and reduced motion. Full-page screenshots of every page at all three sizes go to `screenshots/`.

## Motion

Section reveals rise 24px with opacity (ease-out `cubic-bezier(0.23, 1, 0.32, 1)`, staggered 60ms); charts draw with a wave
stagger under 500ms; the hero trace replays a real run's spans in time order; the defense chart morphs with scroll; the
evidence drawer uses the drawer curve; buttons press at `scale(0.97)`. Only transform and opacity animate. Under
`prefers-reduced-motion` the travel goes, fades stay, the scroll morph shows the defended values directly, and smooth
scrolling is off.
