import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEntry, loadChain, matchHandoff, verifyChain, sha256 } from "../chain.mjs";

test("chain appends, links and verifies; tampering breaks it", () => {
  const chain = [];
  appendEntry(chain, { type: "ENROLLED", node: "a", data: { name: "a" } });
  appendEntry(chain, { type: "HANDOFF", node: "a", data: { payloadHash: sha256("{}") } });
  const v = verifyChain(chain);
  assert.equal(v.ok, true);
  assert.equal(v.entries, 2);
  chain[0].data.name = "forged";
  assert.equal(verifyChain(chain).ok, false);
});

test("dual-entry proof: HANDOFF matches RECEIPT on both hashes", () => {
  const sender = [];
  const payload = { hello: "mesh" };
  const handoff = appendEntry(sender, { type: "HANDOFF", node: "a", data: { payloadHash: sha256(JSON.stringify(payload)) } });
  const receiverEntry = { type: "RECEIPT", data: { handoffHash: handoff.hash, payloadHash: handoff.data.payloadHash } };
  assert.equal(matchHandoff(handoff, receiverEntry), true);
  const wrong = { type: "RECEIPT", data: { handoffHash: handoff.hash, payloadHash: "deadbeef" } };
  assert.equal(matchHandoff(handoff, wrong), false);
});
