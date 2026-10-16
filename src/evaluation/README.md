# Repeated-run evaluation (TB-028)

`repeats.py` builds fixed task-seed schedules and evaluates repeated runs without pooling away their variation.

- **Unit and cluster.** A unit is the registry's experimental unit `(task_id, attack_variant_id, repetition)`; benign units use
  the variant `none`. A cluster is `(task_id, attack_variant_id)`. Scripted-only harness cases are not experimental units;
  a schedule refuses two cases that map to the same unit.
- **Schedule.** `python -m src.evaluation.repeats schedule --suite <cases> --out <file> --live-only` lists every unit with its
  registered run seed (registry seed + repetition × offset) and a seeded execution order. `content_sha256` covers the units
  and seeds only; `order_sha256` covers the order. `scripts/run-arm-smoke.mjs --schedule <file>` executes exactly those units
  in that order, refuses a seed that differs from the registered one, and records the unit and position of every case.
- **Statistics, per cluster first.** Success frequency, all-repeats success and any-repeat success per cluster; then the mean
  over clusters with a 95% cluster bootstrap (registry resamples and seed), the paired defended − baseline difference by
  cluster, the intra-cluster correlation (how correlated repeats are) and the number of clusters with mixed outcomes. The
  pooled per-run rate is reported only as a contrast. Provider-fault repeats are excluded and counted, never scored.
- **Order invariance.** Records are sorted by key before any computation, so execution or listing order cannot change
  pairing, denominators or results: `tests/evaluation/test_repeats.py` (shuffled inputs, duplicates, missing units) and
  `scripts/verify-repeats.py` (the same units executed in two orders through the real harness,
  `evidence/tb028-order-invariance-report.json`).
- **Results.** `npm run summarize:repeats` evaluates every live report with at least 3 repetitions into `evidence/tb028/` and
  generates `docs/repeated-runs.md`.
