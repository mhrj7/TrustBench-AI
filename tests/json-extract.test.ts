import assert from "node:assert/strict";
import test from "node:test";
import { extractJson } from "../src/agent/json-extract.ts";

test("reasoning blocks with draft JSON are ignored; the final fenced answer wins", () => {
  // Shape observed from gemma-4-26b on 2026-10-16 (A-019): the draft answer inside <thought> plus a fenced final answer.
  const text = '<thought>* Passage 1 is `false`.\n\n* `{"1": false}`</thought>```json\n{"1": true}\n```';
  assert.deepEqual(extractJson(text), { "1": true });
});

test("plain, prefixed and trailing-text JSON objects parse; the last balanced object is used", () => {
  assert.deepEqual(extractJson('{"1": false, "2": true}'), { "1": false, "2": true });
  assert.deepEqual(extractJson('Sure. {"a": "x}"} and finally {"b": 2} done'), { b: 2 });
  assert.deepEqual(extractJson('<think>{"draft": 1}</think> answer: {"final": 1}'), { final: 1 });
});

test("arrays are extracted when requested, and garbage yields null", () => {
  assert.deepEqual(extractJson('Tools: ["read_document", "save_research_note"]', "array"), ["read_document", "save_research_note"]);
  assert.equal(extractJson("no json at all"), null);
  assert.equal(extractJson("{not json}"), null);
  assert.equal(extractJson('["a"]'), null, "an array is not an object");
});

test("nested objects are never returned instead of the enclosing top-level object", () => {
  const plan = '{"steps": [{"id": "a", "tool": "t", "args": {"x": {"$ref": "b"}}}], "final": "Recorded {a}."}';
  assert.deepEqual(extractJson(`Here is the plan:\n${plan}`), JSON.parse(plan));
});

test("a stray unclosed brace in prose does not hide a later valid object", () => {
  assert.deepEqual(extractJson('Thinking { about it... final: {"1": false}'), { "1": false });
});
