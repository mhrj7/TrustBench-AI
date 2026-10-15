# Free and local runtime models

Runtime models are interchangeable benchmark subjects (see `docs/model-usage-policy.md`).
`src/models/chat-completions.ts` supports any OpenAI-compatible `/chat/completions` endpoint.

## Ollama (local, zero cost)

- One install only: `/Applications/Ollama.app` (0.40.4, signature verified). A duplicate Homebrew
  `ollama` 0.32.1 launch agent was removed on 2026-10-15; it raced the app for port 11434 and served an
  empty model directory mismatch (client 0.40.4 vs server 0.32.1).
- Models live in `/Volumes/MHRJ/OllamaModels` (the app's configured directory). Originals remain in
  `/Volumes/SANDISK/ollama`; `llama3.1:latest` and `qwen3.5:9b` were copied locally, nothing was downloaded.
- Run both arms: `npm run arms:live-local` (qwen3.5:9b, non-thinking, temperature 0, seed 20261014).
  Budget file: `configs/budget-local.yaml` (zero price, same call/token/time ceilings, 240 s per run).

### Measured suitability (7 smoke cases x 2 arms, one run each; not a benchmark result)

| Model | Result |
| --- | --- |
| `llama3.1:latest` (8B) | Unusable as-is: wrote tool calls as plain text or malformed parallel calls, so the harness recorded 0 tool calls (measured before the holdout-containment change; that run's evidence file was removed because it included holdout fixtures). |
| `qwen3.5:9b`, thinking on, 512 output tokens | Valid calls but ~25 s each and `model_finish_length` truncation in 4/7 cases. |
| `qwen3.5:9b`, thinking off (`reasoning_effort: none`), 1024 tokens | Valid structured calls, ~7 s each. The earlier document failures were an unspecified answer format (fixed by prompt v3 and evaluator tb016.1.1.0). Current results: `docs/pilot-results-tb024.md`. |

Conclusion: a 7-8B class model is enough for the workflow wiring and repeated-run consistency work only
if it has reliable native tool calling (Qwen 9B yes, Llama 3.1 8B no). Single runs say nothing about attack
success rates; that needs the evaluation phase with repetitions.

Answer-format issue: fixed on 2026-10-15 (see `protocol/amendments.md` A-002/A-003).

## Measured Gemini results (2026-10-15)

- `gemini-3.8-flash`: tool calls valid, but the free tier allows only 20 requests per day per model
  (HTTP 429, "retry in 14h"); the first full run exhausted it and was discarded as invalid (it only measured quota).
- `gemini-3.5-flash-lite`: completed all 14 runs without retries (`evidence/tb024-gemini-gemini-3.5-flash-lite-report.json`).
  Valid structured tool calls, but it repeats calls and hit `step_limit_exceeded` in 2 of 14 runs; seeds are not
  supported by the compatibility endpoint (`seed` is omitted and recorded as unsupported). One run per case: wiring evidence only.
- The runner aborts without writing evidence when a quota-exhausted error is detected.

## NVIDIA NIM (hosted alternative)

Measured 2026-10-15 (`evidence/tb024-nvidia-openai-gpt-oss-20b-report.json`): `openai/gpt-oss-20b` made valid structured
tool calls with no provider retries; see `docs/pilot-results-tb024.md`. `nvidia/nemotron-nano-3-30b-a3b`
returned 404 for this account; `deepseek-ai/deepseek-v4.1-flash` made a valid call in a single probe but was slow and was
not run. Wiring evidence only, not an attack-success measurement.

`createNvidiaAdapter` targets `https://integrate.api.nvidia.com/v1`. Put `NVIDIA_API_KEY=...` in the gitignored
`.env` (never in `.env.example`, which is tracked), choose an exact model ID from `GET /v1/models`, then run
`node scripts/run-arm-smoke.mjs --model nvidia:<model-id> --min-interval-ms 3000`. Budget file:
`configs/budget-nvidia-free.yaml`. Check current free-credit limits on build.nvidia.com.

## Gemini free tier (hosted)

`createGeminiAdapter` targets Google's OpenAI-compatible endpoint with reduced JSON schemas. Put
`GEMINI_API_KEY=...` in the gitignored `.env` file (never in chat or committed files), pick an exact model ID
from the ListModels API, then run `node scripts/run-arm-smoke.mjs --model gemini:<model-id> --min-interval-ms 4000`.
Budget file: `configs/budget-gemini-free.yaml`. The live Gemini path is untested until a key exists; free-tier
limits and model revisions change, so record the exact model ID reported on each response.
