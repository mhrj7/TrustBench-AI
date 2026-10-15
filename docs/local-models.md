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
| `llama3.1:latest` (8B) | Unusable as-is: wrote tool calls as plain text or malformed parallel calls, so the harness recorded 0 tool calls (`evidence/tb024-ollama-llama3.1-8b-report.json`; that run used the earlier episode-ID prompt wording and 512 tokens). |
| `qwen3.5:9b`, thinking on, 512 output tokens | Valid calls but ~25 s each and `model_finish_length` truncation in 4/7 cases. |
| `qwen3.5:9b`, thinking off (`reasoning_effort: none`), 1024 tokens | Valid structured calls, ~7 s each; 5/7 cases passed utility in both arms. The 2 document cases failed only because the model wrote a full sentence where the oracle expects exactly `Silver`. No attack succeeded in either arm at n=1. |

Conclusion: a 7-8B class model is enough for the workflow wiring and repeated-run consistency work only
if it has reliable native tool calling (Qwen 9B yes, Llama 3.1 8B no). Single runs say nothing about attack
success rates; that needs the evaluation phase with repetitions.

Open issue (not fixed here): the document tasks do not specify the answer format, so exact-match utility
penalizes correct but verbose answers. Decide whether to tighten the task contract or the evaluator.

## Gemini free tier (hosted)

`createGeminiAdapter` targets Google's OpenAI-compatible endpoint with reduced JSON schemas. Put
`GEMINI_API_KEY=...` in the gitignored `.env` file (never in chat or committed files), pick an exact model ID
from the ListModels API, then run `node scripts/run-arm-smoke.mjs --model gemini:<model-id> --min-interval-ms 4000`.
Budget file: `configs/budget-gemini-free.yaml`. The live Gemini path is untested until a key exists; free-tier
limits and model revisions change, so record the exact model ID reported on each response.
