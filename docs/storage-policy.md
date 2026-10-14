# Storage policy

## Required location

All TrustBench-AI project code, dependencies, datasets, model artifacts, traces, reports, temporary experiment files, and caches must live on the external volume under `/Volumes/MHRJ`.

Project root: `/Volumes/MHRJ/TrustBench-AI`

Shared external caches:

- npm: `/Volumes/MHRJ/.cache/npm`
- Python/uv: `/Volumes/MHRJ/.cache/uv`
- pip: `/Volumes/MHRJ/.cache/pip`
- Hugging Face: `/Volumes/MHRJ/.cache/huggingface`
- model and benchmark downloads: `/Volumes/MHRJ/TrustBench-AI/data` or `/Volumes/MHRJ/TrustBench-AI/models`
- run artifacts: `/Volumes/MHRJ/TrustBench-AI/runs`

## Internal-disk rule

Do not deliberately place project repositories, virtual environments, `node_modules`, datasets, checkpoints, model caches, experiment outputs, or generated reports on the Mac's internal disk. System applications, the existing Codex runtime, and unavoidable operating-system temporary files may remain internal.

Before installing a new package manager or downloading a model/dataset, verify its cache, environment, and output paths point to `/Volumes/MHRJ`.

## Data handling

- Keep raw inputs immutable and content-addressed where practical.
- Keep generated data, traces, and reports in separate versioned directories.
- Do not commit credentials, provider keys, or real personal data.
- Use synthetic fixtures throughout the core benchmark.
- Record disk use before and after large downloads or training runs.
- Do not delete datasets, runs, or checkpoints without resolving their exact paths and confirming they are no longer required evidence.

