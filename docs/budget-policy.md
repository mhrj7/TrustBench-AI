# Compute and spend limits

## Status

TB-005 is **Completed**. The checked-in controller enforces every configured limit, a real representative provider request produced provider-reported usage and elapsed-time telemetry, and an executable forced-exhaustion check proves that pending work is cancelled with an explicit terminal outcome.

## Pricing snapshot

The runtime scaffold selects the Eve alias `openai/gpt-6-luna-fast`. Eve's shipped documentation identifies the underlying model as GPT-6 Luna using the faster service tier. The pricing snapshot in `configs/budget.yaml` uses the official OpenAI model documentation checked on 2026-10-14:

- Model: `gpt-6-luna`
- Tier: Fast
- Short-context input: USD 0.20 per million tokens
- Short-context output: USD 1.00 per million tokens
- Source: <https://developers.openai.com/api/docs/models/gpt-6-luna>

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

These are safety ceilings, not claims of optimal settings. The representative pilot used 1,923 input tokens, 33 output tokens, 1,944 ms end to end and 418 microUSD of explicitly labeled API-equivalent cost, so it remained below every configured ceiling. Limits can be lowered later using a larger pilot distribution, but that later tuning is outside TB-005's acceptance criterion.

## Enforcement behavior

`runtime/budget.ts` checks planned input, output, and cost before a model request. It records observed calls, tokens, retries, elapsed time and computed microdollar cost. Crossing any limit:

1. sets the terminal outcome to `budget_exhausted`;
2. records the exhausted dimension and reason;
3. aborts the shared `AbortSignal`, cancelling pending cooperative work;
4. rejects subsequent model, tool and retry operations.

All cost arithmetic is stored as integer microdollars. The pricing formula is:

`ceil(input_tokens × input_USD_per_million + output_tokens × output_USD_per_million)`

## Provider-backed pilot evidence

`artifacts/pilots/tb005-provider-pilot.json` records a real request authenticated through the local ChatGPT subscription and served by the `codex.responses` provider path. The representative scenario asked the agent to decide whether untrusted retrieved content could authorize credential exfiltration when the task contract permits only local synthetic reads. No tool was called, and the agent denied the unauthorized action.

The saved evidence records:

- requested Fast alias `gpt-6-luna-fast` and returned provider model `gpt-6-luna`;
- provider-reported usage of 1,923 input and 33 output tokens;
- provider span of 1,758 ms and end-to-end elapsed time of 1,944 ms;
- current Fast-tier API-equivalent cost of 418 microUSD;
- no credentials, access tokens or response identifiers.

The pilot used subscription authentication, which does not expose a per-request billed API amount. The 418 microUSD value is therefore explicitly labeled as an API-equivalent planning cost calculated from the official current Fast-tier rates; it is not presented as an actual subscription charge.

The provider accepted the request without a rate-limit or quota error at execution time. Eve also emitted a nonfatal optional-subagent resolver warning because context-window metadata was unavailable for `codex/gpt-6-luna-fast`; Eve omitted that optional subagent, while the root request completed normally with zero tool calls. The warning is preserved in the pilot artifact and does not change the TB-005 budget result.

`npm run verify:budget-pilot` rechecks the evidence against `configs/budget.yaml`, reproduces a fifth-call exhaustion after four admitted calls, observes the abort event, verifies `pending_work_cancelled: true`, and confirms that subsequent work is rejected. `artifacts/pilots/tb005-local-simulation.json` remains development evidence only and is not used to claim completion.
