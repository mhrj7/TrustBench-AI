# TrustBench-AI development environment

## Locked toolchain

The TB-003 reference environment is the configuration verified on the Mac mini used for development:

| Component | Locked value | Lock mechanism |
| --- | --- | --- |
| Project location | `/Volumes/MHRJ/TrustBench-AI` | Smoke assertion and storage policy |
| Node.js | `26.5.0` | `.node-version`, `.nvmrc`, `package.json#engines` |
| npm | `12.0.0` | `packageManager`, `package.json#engines` |
| Eve | `0.79.0` | Exact dependency and `package-lock.json` |
| AI SDK | `7.0.140` | Exact dependency and `package-lock.json` |
| Zod | `4.5.4` | Exact dependency and `package-lock.json` |
| TypeScript | `7.0.2` | Exact dev dependency and `package-lock.json` |
| Node type definitions | `24.19.2` | Exact dev dependency and `package-lock.json` |
| npm cache | `/Volumes/MHRJ/.cache/npm` | Project `.npmrc` |

The package lock is committed source evidence. `npm ci` must be used for reproducible installation; `npm install` is reserved for intentional dependency changes followed by review of the lockfile diff.

## Credential-free setup and verification

From `/Volumes/MHRJ/TrustBench-AI`:

```bash
cp .env.example .env
npm ci
npm run verify
```

`npm run verify` performs TypeScript checking and runs `fixtures/smoke/environment.json`. The smoke fixture is local, deterministic, synthetic, read-only, and makes no model or network request. It deliberately fails if common provider credentials are present because this environment test must prove that basic development does not depend on secrets.

Expected smoke properties:

- `ok` is `true`.
- `fixture_id` is `smoke-environment-001`.
- `credentials_required` is `false`.
- `state_changes` is `0`.
- A SHA-256 fixture digest is printed for traceability.

## Clean-install verification protocol

The acceptance check copies only repository files into a new directory under `/Volumes/MHRJ`, executes `npm ci` with the external npm cache, and runs `npm run verify` with provider credential variables removed. Passing demonstrates that the locked repository can install and execute its first fixture without relying on the existing `node_modules` directory or provider credentials.

This is a development-environment check, not evidence that later provider-backed agent evaluations work without credentials.

## Storage rules

- Project dependencies remain in `/Volumes/MHRJ/TrustBench-AI/node_modules`.
- npm downloads remain in `/Volumes/MHRJ/.cache/npm`.
- Future datasets, model caches, traces, and run artifacts must use the paths in `docs/storage-policy.md`.
- Operating-system and Codex application files already installed internally are outside the project, but TrustBench does not deliberately install project packages there.

## Updating the environment

Any toolchain or package upgrade requires all of the following:

1. Update the explicit version in its lock mechanism.
2. Regenerate and review `package-lock.json` using the external npm cache.
3. Repeat the clean-install protocol.
4. Record the change in the run manifest when experiments begin.
5. Do not compare benchmark runs across environment changes without reporting the difference.

## TB-003 acceptance evidence

The exact local runtime and dependency versions are locked; caches and project files are directed to `/Volumes/MHRJ`; the clean-install protocol uses a fresh dependency directory; and the deterministic smoke fixture requires no credentials, network access, model call, or mutable external state.
