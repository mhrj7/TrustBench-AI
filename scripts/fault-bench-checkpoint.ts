// TB-040 availability cost of checkpoint integrity: time to write a durable checkpoint and the part of it spent computing
// its SHA-256. Usage: node --experimental-strip-types fault-bench-checkpoint.ts <store.sqlite> <writes>
import { createHash } from "node:crypto";
import { RunStore } from "../src/agent/run-store.ts";

const [storePath, writesArg] = process.argv.slice(2);
const writes = Number(writesArg);
const store = new RunStore(storePath!, 1);
const state = { steps: 3, budget: { model_calls: 3, input_tokens: 2400, output_tokens: 400 }, messages: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "tool", content: "x".repeat(600) })),
  pending_calls: [], response_text: "", records: [], failures: [], transitions: [], allowed_by_filter: null } as any;
const write: number[] = []; const hash: number[] = [];
for (let i = 0; i < writes; i++) {
  state.steps = i;
  let t = process.hrtime.bigint(); store.checkpoint(`bench-${i % 50}`, state); write.push(Number(process.hrtime.bigint() - t) / 1000);
  const text = JSON.stringify(state);
  t = process.hrtime.bigint(); createHash("sha256").update(text).digest("hex"); hash.push(Number(process.hrtime.bigint() - t) / 1000);
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
process.stdout.write(JSON.stringify({ writes, checkpoint_bytes: JSON.stringify(state).length, write_median_us: Math.round(median(write)), sha256_median_us: Math.round(median(hash) * 10) / 10 }));
