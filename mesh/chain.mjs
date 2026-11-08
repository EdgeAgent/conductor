// Receipt chain — append-only, hash-chained (agent-proof format, sync
// Node version of the banked mesh chain). Entries are data, never
// instructions. A handoff is proven by two entries: HANDOFF in the
// sender's chain and RECEIPT in the receiver's chain whose
// data.handoffHash + data.payloadHash match the sender's entry.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const GENESIS = "GENESIS";
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function canonical(entry) {
  return JSON.stringify({
    seq: entry.seq, ts: entry.ts, type: entry.type,
    node: entry.node, data: entry.data, prev: entry.prev,
  });
}

export function loadChain(file) {
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
}
export function saveChain(file, chain) {
  writeFileSync(file, JSON.stringify(chain, null, 2));
}
export function appendEntry(chain, { type, node, data, ts }) {
  const entry = {
    seq: chain.length,
    ts: ts ?? new Date().toISOString(),
    type,
    node,
    data: data ?? {},
    prev: chain.length ? chain[chain.length - 1].hash : GENESIS,
    hash: "",
  };
  entry.hash = sha256(canonical(entry));
  chain.push(entry);
  return entry;
}
export function verifyChain(chain) {
  let prev = GENESIS;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    if (e.seq !== i) return { ok: false, at: i, why: "sequence gap" };
    if (e.prev !== prev) return { ok: false, at: i, why: "prev link broken" };
    if (sha256(canonical(e)) !== e.hash) return { ok: false, at: i, why: "hash mismatch" };
    prev = e.hash;
  }
  return { ok: true, entries: chain.length, head: prev };
}
export function matchHandoff(senderEntry, receiverEntry) {
  if (!senderEntry || senderEntry.type !== "HANDOFF") return false;
  if (!receiverEntry || receiverEntry.type !== "RECEIPT") return false;
  return (
    receiverEntry.data.handoffHash === senderEntry.hash &&
    receiverEntry.data.payloadHash === senderEntry.data.payloadHash
  );
}
