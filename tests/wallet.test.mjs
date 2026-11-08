import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const Lib = createRequire(import.meta.url)("../src/lib.js");

const policy = Lib.WALLET_DEFAULT_POLICY; // $25/tx, $100/day, $5 approval line
const now = Date.now();
const ledgerWith = (amountUsd) => [{ ts: now, amountUsd, status: "sent", origin: "https://shop.example" }];

test("assess: API checkout POST and DOM pay clicks are money; reads are not", () => {
  const api = { name: "post_api_orders", risk: "write", action: { kind: "api", method: "POST", path: "/api/checkout", origin: "https://shop.example" } };
  assert.equal(Lib.walletAssess(api, { total: 42.5 }, "https://shop.example/cart").isMoney, true);
  assert.equal(Lib.walletAssess(api, { total: 42.5 }, "").amountUsd, 42.5);
  const click = { name: "click_by_text", risk: "write", description: "Click any button by text" };
  const a2 = Lib.walletAssess(click, { text: "Pay $19.99" }, "https://shop.example/checkout");
  assert.equal(a2.isMoney, true);
  assert.equal(a2.amountUsd, 19.99);
  const read = { name: "extract_page_text", risk: "read" };
  assert.equal(Lib.walletAssess(read, {}, "https://shop.example").isMoney, false);
  const nav = { name: "navigate_to", risk: "write", description: "Navigate the current tab to a URL." };
  assert.equal(Lib.walletAssess(nav, { url: "https://example.com/about" }, "").isMoney, false);
});

test("evaluate: caps deny, approval line flags, small known amounts pass", () => {
  const spend = (amountUsd) => ({ isMoney: true, amountUsd, origin: "https://shop.example", payee: "https://shop.example" });
  assert.equal(Lib.walletEvaluate(policy, [], spend(30)).decision, "denied"); // over $25/tx
  assert.match(Lib.walletEvaluate(policy, [], spend(30)).reasons[0], /per-action cap/);
  assert.equal(Lib.walletEvaluate(policy, ledgerWith(90), spend(20)).decision, "denied"); // daily cap
  assert.equal(Lib.walletEvaluate(policy, [], spend(10)).decision, "approval"); // >= $5 line
  assert.equal(Lib.walletEvaluate(policy, [], spend(3)).decision, "auto");
  assert.equal(Lib.walletEvaluate(policy, [], spend(null)).decision, "approval"); // unknown amount
  assert.equal(Lib.walletEvaluate({ ...policy, killed: true }, [], spend(3)).decision, "denied");
  assert.equal(Lib.walletEvaluate({ ...policy, enabled: false }, [], spend(300)).decision, "off");
});

test("evaluate: allowlist-only refuses unknown origins", () => {
  const p = { ...policy, allowlistOnly: true, allowlist: ["https://trusted.example"] };
  const spend = { isMoney: true, amountUsd: 3, origin: "https://shop.example", payee: "https://shop.example" };
  assert.equal(Lib.walletEvaluate(p, [], spend).decision, "denied");
  const ok = { ...spend, origin: "https://trusted.example", payee: "https://trusted.example" };
  assert.equal(Lib.walletEvaluate(p, [], ok).decision, "auto");
});

test("spentOnDay counts only today's sent entries", () => {
  const ledger = [
    { ts: now, amountUsd: 10, status: "sent" },
    { ts: now, amountUsd: 5, status: "denied" },
    { ts: now - 48 * 3600 * 1000, amountUsd: 99, status: "sent" },
  ];
  assert.equal(Lib.walletSpentOnDay(ledger, now), 10);
});
