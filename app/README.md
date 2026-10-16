# Run store, redaction and view logic (TB-030)

The Python side of the review site (`web/`). It has no UI of its own.

- `store.py`: the versioned run store. It reads the live evidence reports (`evidence/tb024-*-report.json`), their TB-027
  span files and the TB-029 attribution file. `scripts/dashboard-index.py` pins each file by SHA-256 in
  `reports/dashboard/run-index.json`; the store version is the SHA-256 of that list. A changed or missing file is reported,
  and a raw record whose report changed refuses to open. Every run keeps its source: report path, SHA-256 and JSON pointer.
- `redact.py`: the payload redaction set. It is the TB-027 sensitive-value set (checked equal to the TypeScript builder),
  minus values a trusted task contract itself names, plus the attack-oracle markers of private-data effects, which catch
  partial copies. Matching ignores case and treats every Unicode dash and space variant alike: gpt-oss writes non-breaking
  hyphens, which exact matching missed in 5 records.
- `views.py`: aggregation, policy reasons and outcome counts. Every aggregate keeps the run IDs it counts. The website's
  `web/src/lib/aggregate.ts` is a port, tested for identical cells and run IDs (`web/src/lib/aggregate.test.ts`).

```bash
npm run dashboard:index   # rebuild the index after evidence changes
npm run web:data          # export the redacted store for the website (web/public/data)
npm run verify:dashboard  # recompute every aggregate from the raw records and check the export
```

`scripts/verify-dashboard.py` opens every run's raw record and, for every grouping the site offers (the default and each
single dimension, unfiltered, with invalid runs, and per model), recomputes each aggregate from the raw records of exactly
the run IDs it lists; policy and outcome counts are checked in both directions. It then checks the website export: same
runs and fields, each exported record equal to the redacted raw record, and no sensitive value in any exported file (any
spelling variant). Results: `evidence/tb030-dashboard-report.json`. `npm run test:dashboard` covers the store, the view
logic and the redaction.
