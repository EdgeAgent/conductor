#!/usr/bin/env node
// Edge Agency Mesh daemon — one process, four doors:
//   serve        mTLS node server (LAN) + HTTP pairing/companion server
//   --native     Native Messaging host for the Conductor extension (stdio)
//   CLI          init-root / enroll / pairing-start / claim / status /
//                peers / sync / handoff / verify
// State lives in $MESH_HOME (default ~/.meshnode). Private keys are
// generated and kept there (0600); no interface ever returns them.
import { createServer } from "node:http";
import { createServer as tlsServer } from "node:tls";
import { randomBytes, sign as cryptoSign, verify as cryptoVerify, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as idn from "./identity.mjs";
import { appendEntry, loadChain, matchHandoff, saveChain, sha256, verifyChain } from "./chain.mjs";
import { meshHandoff, meshStatus, meshSync, peerIdentityFromCert, tlsOptions } from "./protocol.mjs";

const HOME = process.env.MESH_HOME || join(homedir(), ".meshnode");
const TLS_PORT = Number(process.env.MESH_TLS_PORT || 47832);
const PAIR_PORT = Number(process.env.MESH_PAIR_PORT || 47833);
const HERE = dirname(fileURLToPath(import.meta.url));
const P = idn.meshPaths(HOME);
mkdirSync(P.peersDir, { recursive: true });

const peersFile = join(HOME, "peers.json");
const pairingsFile = join(HOME, "pairings.json");
const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } };
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2));
const loadPeers = () => readJson(peersFile, {});
const savePeers = (p) => writeJson(peersFile, p);
const myName = () => JSON.parse(readFileSync(P.nodeMeta, "utf8")).name;
const myChain = () => loadChain(P.chain);
function chainAppend(type, data) {
  const chain = myChain();
  const entry = appendEntry(chain, { type, node: myName(), data });
  saveChain(P.chain, chain);
  return entry;
}
function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) return n.address;
    }
  }
  return "127.0.0.1";
}
function statusObject() {
  const chain = myChain();
  const v = verifyChain(chain);
  return {
    node: myName(),
    certFingerprint: JSON.parse(readFileSync(P.nodeMeta, "utf8")).certFingerprint,
    rootFingerprint: JSON.parse(readFileSync(P.nodeMeta, "utf8")).rootFingerprint,
    chainHead: v.head, chainEntries: v.entries, chainValid: v.ok,
    peers: Object.values(loadPeers()).map((p) => ({ name: p.name, kind: p.kind, certFingerprint: p.certFingerprint, lastSeen: p.lastSeen || null })),
    tlsPort: TLS_PORT, pairPort: PAIR_PORT, lanIp: lanIp(),
  };
}

// ---------------- Pairing ----------------
function startPairing() {
  const pairings = readJson(pairingsFile, {});
  const session = {
    id: randomBytes(6).toString("hex"),
    token: randomBytes(24).toString("base64url"),
    createdAt: Date.now(),
    exp: Date.now() + 10 * 60 * 1000,
    used: false,
  };
  pairings[session.id] = session;
  writeJson(pairingsFile, pairings);
  const host = lanIp();
  const claimUrl = `http://${host}:${PAIR_PORT}/pair#${session.token}`;
  chainAppend("PAIRING-START", { session: session.id, exp: session.exp });
  return { session: session.id, exp: session.exp, claimUrl, payload: { v: 1, kind: "mesh-pair", node: myName(), host, pairPort: PAIR_PORT, tlsPort: TLS_PORT, rootFingerprint: statusObject().rootFingerprint, token: session.token, session: session.id } };
}

function claimPairing({ token, name, publicKeyPem, tlsPort, host }) {
  const pairings = readJson(pairingsFile, {});
  const session = Object.values(pairings).find((s) => s.token === token);
  if (!session) throw new Error("Unknown pairing token.");
  if (session.used) throw new Error("Pairing token already used.");
  if (Date.now() > session.exp) throw new Error("Pairing token expired.");
  // Root-sign the claimant's public key into a node certificate.
  const tmpCsr = join(HOME, `claim-${session.id}.csr`);
  const tmpKey = join(HOME, `claim-${session.id}.key`);
  const pubFile = join(HOME, `claim-${session.id}.pub`);
  const crtFile = join(HOME, `claim-${session.id}.crt`);
  // A CSR is needed as the vehicle; generate a throwaway key for it and
  // force the claimant's public key into the issued cert instead.
  execFileSync("openssl", ["genpkey", "-algorithm", "ED25519", "-out", tmpKey]);
  execFileSync("openssl", ["req", "-new", "-key", tmpKey, "-out", tmpCsr, "-subj", `/CN=${name}`]);
  writeFileSync(pubFile, publicKeyPem);
  const { fingerprint } = idn.signNodeCert(HOME, { csrFile: tmpCsr, pubKeyFile: pubFile, name, outFile: crtFile });
  const certPem = readFileSync(crtFile, "utf8");
  session.used = true;
  session.claimedBy = name;
  session.certFingerprint = fingerprint;
  writeJson(pairingsFile, pairings);
  const kind = tlsPort ? "node" : "companion";
  const peers = loadPeers();
  peers[fingerprint] = { name, kind, certFingerprint: fingerprint, tlsPort: tlsPort || null, host: host || null, addedAt: new Date().toISOString(), lastSeen: new Date().toISOString() };
  savePeers(peers);
  chainAppend("ENROLLED", { name, kind, certFingerprint: fingerprint, session: session.id });
  // Session credential for browser companions: node-signed, 24h.
  const sessionToken = kind === "companion" ? issueSessionToken({ name, certFingerprint: fingerprint }) : null;
  return { certPem, rootCertPem: readFileSync(P.rootCrt, "utf8"), certFingerprint: fingerprint, sessionToken, daemon: statusObject() };
}

// Session tokens: base64url(json).base64url(ed25519 sig by node key).
// Node keys in this build are Ed25519 (enroll + claim both generate them).
function issueSessionToken({ name, certFingerprint }) {
  const body = { sub: certFingerprint, name, exp: Date.now() + 24 * 3600 * 1000, iss: myName() };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = cryptoSign(null, Buffer.from(payload), readFileSync(P.nodeKey, "utf8")).toString("base64url");
  return `${payload}.${sig}`;
}
function verifySessionToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  let body;
  try { body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (Date.now() > body.exp) return null;
  const cert = new X509Certificate(readFileSync(P.nodeCrt, "utf8"));
  const ok = cryptoVerify(null, Buffer.from(payload), cert.publicKey, Buffer.from(sig, "base64url"));
  return ok ? body : null;
}

// ---------------- mTLS server ----------------
function handleMeshMessage(msg, peer, reply) {
  const chain = myChain();
  switch (msg.kind) {
    case "status": {
      const v = verifyChain(chain);
      reply({ ok: true, node: myName(), chainHead: v.head, chainEntries: v.entries, chainValid: v.ok });
      break;
    }
    case "sync-request": {
      // Send my full chain (mesh scale is small); the requester verifies
      // and stores it as my peer-chain copy. Entries are data only.
      reply({ ok: true, node: myName(), chain });
      chainAppend("SYNC-SERVED", { to: peer.name, entries: chain.length });
      break;
    }
    case "handoff": {
      const payloadHash = sha256(JSON.stringify(msg.payload));
      if (payloadHash !== msg.payloadHash) { reply({ ok: false, error: "payload hash mismatch" }); break; }
      const entry = chainAppend("RECEIPT", { from: peer.name, handoffHash: msg.handoffHash, payloadHash, payload: msg.payload });
      reply({ ok: true, receiptHash: entry.hash, receiptSeq: entry.seq });
      break;
    }
    default:
      reply({ ok: false, error: "unknown message kind" });
  }
  const peers = loadPeers();
  if (peers[peer.fingerprint]) { peers[peer.fingerprint].lastSeen = new Date().toISOString(); savePeers(peers); }
}

function serveMtls() {
  const server = tlsServer({ ...tlsOptions(HOME), requestCert: true, rejectUnauthorized: true }, (socket) => {
    const peer = peerIdentityFromCert(socket.getPeerCertificate(true).raw);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, idx)); } catch { socket.end(); return; }
      handleMeshMessage(msg, peer, (obj) => socket.end(JSON.stringify(obj) + "\n"));
    });
    socket.on("error", () => {});
  });
  server.listen(TLS_PORT, () => console.log(`mesh mTLS server: ${myName()} on :${TLS_PORT}`));
  server.on("tlsClientError", (e) => console.log("tlsClientError:", e.message));
}

// ---------------- Pairing/companion HTTP server ----------------
function servePairing() {
  const page = readFileSync(join(HERE, "companion.html"), "utf8");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
    try {
      if (req.method === "GET" && url.pathname === "/pair") return send(200, page, "text/html; charset=utf-8");
      if (req.method === "POST" && url.pathname === "/pair/claim") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try { send(200, claimPairing({ ...JSON.parse(body), host: req.socket.remoteAddress })); }
          catch (e) { send(400, { error: e.message }); }
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
        const session = verifySessionToken(auth);
        if (!session) return send(401, { error: "bad or expired session token" });
        return send(200, statusObject());
      }
      if (req.method === "POST" && url.pathname === "/api/handoff") {
        const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
        const session = verifySessionToken(auth);
        if (!session) return send(401, { error: "bad or expired session token" });
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          try {
            const { to, payload } = JSON.parse(body || "{}");
            const result = await doHandoff(to, payload ?? { hello: "from companion", ts: Date.now() });
            send(200, result);
          } catch (e) { send(400, { error: e.message }); }
        });
        return;
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(500, { error: e.message });
    }
  });
  server.listen(PAIR_PORT, () => console.log(`mesh pairing server on :${PAIR_PORT} (LAN, one-time-token gated)`));
}

// ---------------- Handoff / sync drivers ----------------
function findPeer(nameOrFp) {
  const peers = loadPeers();
  const peer = peers[nameOrFp] || Object.values(peers).find((p) => p.name === nameOrFp);
  if (!peer) throw new Error(`unknown peer "${nameOrFp}"`);
  if (peer.kind !== "node" || !peer.tlsPort) throw new Error(`peer "${peer.name}" is a browser companion — it has no mTLS listener`);
  return peer;
}
const peerHost = (peer) => (peer.host || lanIp()).replace(/^::ffff:/, "");
async function doSync(peerRef) {
  const peer = findPeer(peerRef);
  const host = peerHost(peer);
  const res = await meshSync(HOME, { host, port: peer.tlsPort, certFingerprint: peer.certFingerprint }, myChain());
  const v = verifyChain(res.chain || []);
  if (!v.ok) throw new Error(`peer chain failed verification at ${v.at}: ${v.why}`);
  const dir = join(P.peersDir, peer.certFingerprint);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chain.json"), JSON.stringify(res.chain, null, 2));
  chainAppend("SYNC", { from: peer.name, entries: v.entries, head: v.head });
  return { peer: peer.name, entries: v.entries, head: v.head, valid: true };
}
async function doHandoff(peerRef, payload) {
  const peer = findPeer(peerRef);
  const host = peerHost(peer);
  const entry = chainAppend("HANDOFF", { to: peer.name, payloadHash: sha256(JSON.stringify(payload)), payload });
  const res = await meshHandoff(HOME, { host, port: peer.tlsPort, certFingerprint: peer.certFingerprint }, entry, payload);
  if (!res.ok) throw new Error(res.error || "handoff refused");
  const receipt = { type: "RECEIPT", data: { handoffHash: entry.hash, payloadHash: entry.data.payloadHash }, hash: res.receiptHash };
  const proven = matchHandoff(entry, receipt);
  chainAppend("HANDOFF-ACK", { to: peer.name, handoffHash: entry.hash, receiptHash: res.receiptHash, proven });
  return { handoffHash: entry.hash, receiptHash: res.receiptHash, proven, peer: peer.name };
}

// ---------------- Native Messaging ----------------
function nativeServe() {
  let inBuf = Buffer.alloc(0);
  const sendMsg = (obj) => {
    const s = Buffer.from(JSON.stringify(obj), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(s.length, 0);
    process.stdout.write(Buffer.concat([len, s]));
  };
  process.stdin.on("data", async (chunk) => {
    inBuf = Buffer.concat([inBuf, chunk]);
    while (inBuf.length >= 4) {
      const n = inBuf.readUInt32LE(0);
      if (inBuf.length < 4 + n) break;
      const raw = inBuf.subarray(4, 4 + n).toString("utf8");
      inBuf = inBuf.subarray(4 + n);
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      const reply = (obj) => sendMsg({ id: msg.id ?? null, ...obj });
      try {
        switch (msg.kind) {
          case "status": reply({ ok: true, ...statusObject() }); break;
          case "identity": {
            const s = statusObject();
            reply({ ok: true, name: s.node, certFingerprint: s.certFingerprint, rootFingerprint: s.rootFingerprint });
            break;
          }
          case "pairing-start": reply({ ok: true, ...startPairing() }); break;
          case "peers": reply({ ok: true, peers: statusObject().peers }); break;
          case "chain": {
            const chain = myChain();
            reply({ ok: true, chain, verify: verifyChain(chain) });
            break;
          }
          case "sync": reply({ ok: true, ...(await doSync(msg.peer)) }); break;
          case "handoff": reply({ ok: true, ...(await doHandoff(msg.peer, msg.payload ?? { hello: "from Conductor", ts: Date.now() })) }); break;
          default: reply({ ok: false, error: `unknown kind "${msg.kind}"` });
        }
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// ---------------- CLI ----------------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (flag) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : null; };
  switch (cmd) {
    case "--native": nativeServe(); break;
    case "init-root": console.log(JSON.stringify(idn.initRoot(HOME), null, 2)); break;
    case "enroll": {
      if (!idn.rootReady(HOME)) idn.initRoot(HOME);
      console.log(JSON.stringify(idn.enrollSelf(HOME, arg("--name") || "node-1"), null, 2));
      chainAppend("ENROLLED", { name: arg("--name") || "node-1", kind: "self", certFingerprint: JSON.parse(readFileSync(P.nodeMeta, "utf8")).certFingerprint });
      break;
    }
    case "serve": serveMtls(); servePairing(); break;
    case "pairing-start": console.log(JSON.stringify(startPairing(), null, 2)); break;
    case "claim": {
      // Join another node's mesh: generate my keypair, claim against its
      // pairing endpoint, save the issued cert + its root as my trust root.
      const claimUrl = arg("--url");
      const token = arg("--token");
      const name = arg("--name") || "node-2";
      const { generateKeyPairSync } = await import("node:crypto");
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" });
      const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
      const res = await fetch(claimUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, name, publicKeyPem: pubPem, tlsPort: TLS_PORT }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "claim failed");
      mkdirSync(HOME, { recursive: true });
      writeFileSync(P.nodeKey, privPem, { mode: 0o600 });
      writeFileSync(P.nodeCrt, data.certPem);
      writeFileSync(P.rootCrt, data.rootCertPem);
      writeFileSync(P.nodeMeta, JSON.stringify({ name, createdAt: new Date().toISOString(), certFingerprint: data.certFingerprint, rootFingerprint: data.daemon.rootFingerprint }, null, 2));
      const daemonUrl = new URL(claimUrl);
      const peers = loadPeers();
      peers[data.daemon.certFingerprint] = { name: data.daemon.node, kind: "node", certFingerprint: data.daemon.certFingerprint, tlsPort: data.daemon.tlsPort, host: daemonUrl.hostname, addedAt: new Date().toISOString() };
      savePeers(peers);
      chainAppend("ENROLLED", { name, kind: "node", certFingerprint: data.certFingerprint, via: "pairing-claim" });
      chainAppend("PEER-ADDED", { name: data.daemon.node, certFingerprint: data.daemon.certFingerprint });
      console.log(JSON.stringify({ enrolled: name, certFingerprint: data.certFingerprint, root: data.daemon.node }, null, 2));
      break;
    }
    case "status": console.log(JSON.stringify(statusObject(), null, 2)); break;
    case "peers": console.log(JSON.stringify(loadPeers(), null, 2)); break;
    case "sync": console.log(JSON.stringify(await doSync(rest[0]), null, 2)); break;
    case "handoff": console.log(JSON.stringify(await doHandoff(rest[0], { hello: "mesh handoff", ts: Date.now() }), null, 2)); break;
    case "verify": {
      const chain = myChain();
      console.log(JSON.stringify(verifyChain(chain), null, 2));
      break;
    }
    default:
      console.log("mesh-daemon: init-root | enroll --name X | serve | pairing-start | claim --url U --token T --name N | status | peers | sync <peer> | handoff <peer> | verify | --native");
  }
}

main().catch((e) => { console.error("mesh-daemon error:", e.message); process.exit(1); });
