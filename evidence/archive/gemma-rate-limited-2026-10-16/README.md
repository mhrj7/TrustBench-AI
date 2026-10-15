# Gemma 4 first attempt (2026-10-16): archived, not used

These reports are kept for transparency and excluded from every table. Two Gemma jobs ran at the same time and exceeded the
Gemini free-tier input-token limit for `gemma-4-26b` (16,000 input tokens per minute, from the provider's 429 message), so
most pairs failed with `rate_limit` and were correctly marked invalid by the runner (valid pairs per report ranged from 1/32
to 15/18). The runs were repeated with token-aware pacing (protocol amendment A-018).
