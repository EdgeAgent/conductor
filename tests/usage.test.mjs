import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const Lib = createRequire(import.meta.url)("../src/lib.js");

test("extractUsage reads Ollama counts and OpenAI-style usage", () => {
  assert.deepEqual(Lib.extractUsage("local", { prompt_eval_count: 120, eval_count: 30 }), { prompt: 120, completion: 30 });
  assert.deepEqual(Lib.extractUsage("cloud", { usage: { prompt_tokens: 500, completion_tokens: 125 } }), { prompt: 500, completion: 125 });
  assert.equal(Lib.extractUsage("cloud", { choices: [] }), null);
  assert.equal(Lib.extractUsage("local", null), null);
});

test("pricing: local is free, table prices apply, overrides win, unknown is unpriced", () => {
  assert.equal(Lib.modelPrice("llama3.1:8b", "local").source, "local");
  assert.equal(Lib.callCostUsd(Lib.modelPrice("llama3.1:8b", "local"), { prompt: 1e6, completion: 1e6 }), 0);
  const p = Lib.modelPrice("openai/gpt-4o-mini", "cloud");
  assert.equal(p.source, "table");
  assert.ok(Math.abs(Lib.callCostUsd(p, { prompt: 1e6, completion: 1e6 }) - 0.75) < 1e-9);
  const o = Lib.modelPrice("openai/gpt-4o-mini", "cloud", { "openai/gpt-4o-mini": { in: 1, out: 2 } });
  assert.equal(o.source, "custom");
  assert.equal(Lib.callCostUsd(o, { prompt: 1e6, completion: 0 }), 1);
  assert.equal(Lib.modelPrice("some/unknown-model", "cloud"), null);
  assert.equal(Lib.modelPrice("vendor/model:free", "cloud").inPerM, 0);
});

test("recordUsage accumulates totals, day buckets, per-model and recent trace", () => {
  const t0 = new Date(2026, 10, 8, 10, 0, 0).getTime();
  let s = Lib.emptyUsageStore();
  s = Lib.recordUsage(s, { ts: t0, route: "cloud", model: "openai/gpt-4o-mini", prompt: 1000, completion: 500, costUsd: 0.00045 });
  s = Lib.recordUsage(s, { ts: t0 + 3600000, route: "local", model: "llama3.1:8b", prompt: 2000, completion: 800, costUsd: 0 });
  s = Lib.recordUsage(s, { ts: t0 + 7200000, route: "cloud", model: "some/unknown", prompt: 100, completion: 50, costUsd: null });
  assert.equal(s.total.calls, 3);
  assert.equal(s.total.prompt, 3100);
  assert.equal(s.total.completion, 1350);
  assert.equal(s.total.unpricedCalls, 1);
  assert.ok(Math.abs(s.total.costUsd - 0.00045) < 1e-12);
  assert.equal(s.total.models["cloud:openai/gpt-4o-mini"].calls, 1);
  assert.equal(s.recent.length, 3);
  assert.equal(s.recent[0].model, "some/unknown");
  const today = Lib.usageWindow(s, 1, t0 + 7200000);
  assert.equal(today.calls, 3);
  const week = Lib.usageWindow(s, 7, t0 + 7200000);
  assert.equal(week.calls, 3);
});

test("formatters", () => {
  assert.equal(Lib.formatTokens(950), "950");
  assert.equal(Lib.formatTokens(12400), "12.4k");
  assert.equal(Lib.formatUsd(0), "$0.00");
  assert.equal(Lib.formatUsd(0.0034), "$0.0034");
  assert.equal(Lib.formatUsd(null), "—");
});
