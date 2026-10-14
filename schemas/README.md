# Trace schema

`trace.ts` is the executable version 1.0.0 contract for TrustBench run events. It defines strict event envelopes, JSONL parsing and serialization, secret scanning, argument hashing, cross-event validation, and executed-tool-call reconstruction.

The contract rejects unknown fields instead of silently dropping them. Every event carries the schema version, run ID, task ID, contiguous sequence number, and offset-aware timestamp. The first event fixes the model revision, prompt hash, seed, evaluator version, configuration hash, and run limits.

Run `npm run test:trace` to validate the positive fixture and negative contract cases.
