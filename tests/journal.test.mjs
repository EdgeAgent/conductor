import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const Lib = createRequire(import.meta.url)("../src/lib.js");

test("sha256Hex matches node:crypto on varied inputs", () => {
  const vectors = [
    "",
    "abc",
    "The quick brown fox jumps over the lazy dog",
    "x".repeat(55), "y".repeat(56), "z".repeat(64), "w".repeat(65),
    "long-entry-".repeat(40),
    "unicode: café — ✓ · 日本語",
    JSON.stringify({ seq: 0, ts: "2026-11-08T00:00:00.000Z", type: "ARM", text: "Session armed — 5 tabs snapshotted", meta: {}, prev: "GENESIS" }),
  ];
  for (const v of vectors) {
    assert.equal(Lib.sha256Hex(v), createHash("sha256").update(v, "utf8").digest("hex"), `mismatch for ${JSON.stringify(v.slice(0, 24))}`);
  }
});

test("journal chain appends, verifies, detects tampering", () => {
  const chain = [];
  Lib.journalAppend(chain, { type: "ARM", text: "Session armed", ts: "2026-11-08T10:00:00.000Z" });
  Lib.journalAppend(chain, { type: "TAB-OPEN", text: "https://example.com", ts: "2026-11-08T10:01:00.000Z" });
  const v = Lib.journalVerify(chain);
  assert.equal(v.ok, true);
  assert.equal(v.entries, 2);
  assert.equal(v.head, chain[1].hash);
  chain[0].text = "forged";
  const bad = Lib.journalVerify(chain);
  assert.equal(bad.ok, false);
  assert.equal(bad.at, 0);
});

test("planRestore: closes extras, reopens missing, skips internal", () => {
  const snap = [
    { id: 1, url: "https://a.com/", pinned: true },
    { id: 2, url: "https://b.com/" },
    { id: 3, url: "https://b.com/" },
    { id: 4, url: "chrome://extensions" },
  ];
  const cur = [
    { id: 10, url: "https://b.com/" },
    { id: 11, url: "https://c.com/" },
    { id: 12, url: "chrome://newtab" },
  ];
  const plan = Lib.planRestore(snap, cur);
  assert.deepEqual(plan.closeIds, [11]); // c.com was not in the snapshot
  assert.deepEqual(plan.open, [
    { url: "https://a.com/", pinned: true },
    { url: "https://b.com/", pinned: false },
  ]);
});

test("planRestore: identical sets plan nothing", () => {
  const tabs = [{ id: 1, url: "https://a.com/" }, { id: 2, url: "https://b.com/" }];
  const plan = Lib.planRestore(tabs, tabs.map((t) => ({ ...t, id: t.id + 100 })));
  assert.deepEqual(plan, { closeIds: [], open: [] });
});
