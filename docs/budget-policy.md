# Compute and spend limits

## Status

TB-005 is **In Progress**. Budget enforcement and pricing configuration are implemented and tested. A real representative provider request has not been run because no provider API credential is configured. The synthetic trace is explicitly excluded as completion evidence.

## Pricing snapshot

The runtime scaffold currently selects the Eve alias `openai/gpt-6-luna-fast`. Eve's shipped documentation identifies the underlying model as GPT-6 Luna using the faster service tier. The pricing snapshot in `configs/budget.yaml` uses the official OpenAI pricing page checked on 2026-10-14:

- Model: `gpt-6-luna`
- Tier: Fast
- Short-context input: USD 0.20 per million tokens
- Short-context output: USD 1.00 per million tokens
- Source: <https://platform.openai.com/pricing>

Pricing must be refreshed at provider-run time. A provider-backed run fails closed if the snapshot is older than 24 hours.

## Initial per-run limits

| Limit | Value | Rationale |
| --- | ---: | --- |
| Model calls | 4 | Bounds agent loops while permitting two tool-selection turns and correction. |
| Tool calls | 8 | Supports the three core workflows without open-ended execution. |
| Input tokens | 30,000 | Allows bounded retrieved context on the 16 GB development machine. |
| Output tokens | 4,000 | Bounds reasoning/output and cost. |
| Retries | 1 | Permits one transient recovery without retry amplification. |
| Elapsed time | 60 seconds | Stops stalled local benchmark episodes. |
| Cost | 10,000 microUSD (USD 0.01) | Equals the worst-case configured token limits at the recorded Fast-tier rates. |

These are initial safety ceilings, not measured optimal values. They must be reviewed after the real pilot and can be lowered before protocol freeze.

## Enforcement behavior

`runtime/budget.ts` checks planned input, output, and cost before a model request. It records observed calls, tokens, retries, elapsed time and computed microdollar cost. Crossing any limit:

1. sets the terminal outcome to `budget_exhausted`;
2. records the exhausted dimension and reason;
3. aborts the shared `AbortSignal`, cancelling pending cooperative work;
4. rejects subsequent model, tool and retry operations.

All cost arithmetic is stored as integer microdollars. The pricing formula is:

`ceil(input_tokens × input_USD_per_million + output_tokens × output_USD_per_million)`

## Required evidence before completion

TB-005 must remain In Progress until one provider-backed request records:

- exact model identifier and service tier returned or confirmed by the provider path;
- provider-reported input and output tokens;
- locally measured elapsed time;
- cost computed from a pricing snapshot checked at execution time;
- a stored pilot log with no secrets;
- a forced budget-exhaustion run showing pending cancellation and explicit `budget_exhausted` outcome.

`artifacts/pilots/tb005-local-simulation.json` is useful development evidence but is not a substitute for that provider pilot.
