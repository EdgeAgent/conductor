// Mesh wire protocol — mTLS client + message handlers shared by the
// daemon's serve mode and its CLI. Transport: TLS with certificates
// signed by the mesh root CA (mutual auth is enforced by the TLS stack);
// messages are newline-delimited JSON. Peers are identified by their
// certificate fingerprint, never by address alone.
import { connect as tlsConnect } from "node:tls";
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { meshPaths } from "./identity.mjs";
import { sha256 } from "./chain.mjs";

export function peerIdentityFromCert(pemOrDer) {
  const cert = new X509Certificate(pemOrDer);
  const fp = createHash("sha256").update(cert.raw).digest("hex");
  const cn = (cert.subject || "").split("\n").map((s) => s.trim()).find((s) => s.startsWith("CN="));
  return { fingerprint: fp, name: cn ? cn.slice(3) : "unknown" };
}

export function tlsOptions(home) {
  const p = meshPaths(home);
  return {
    key: readFileSync(p.nodeKey),
    cert: readFileSync(p.nodeCrt),
    ca: readFileSync(p.rootCrt),
  };
}

// One request/response round trip to a peer's mTLS port.
export function meshRequest(home, { host, port }, message, { timeoutMs = 15000, expectedFingerprint = null } = {}) {
  return new Promise((resolve, reject) => {
    // Identity is the certificate fingerprint (pinned from the peer
    // registry), not the hostname — node certs carry mesh URIs, not IPs.
    // The CA chain is still fully validated by rejectUnauthorized.
    const socket = tlsConnect({ host, port, rejectUnauthorized: true, checkServerIdentity: () => undefined, ...tlsOptions(home) });
    let buf = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("mesh request timed out")); }, timeoutMs);
    socket.once("secureConnect", () => {
      const peerCert = socket.getPeerCertificate(true);
      const peer = peerIdentityFromCert(peerCert.raw);
      if (expectedFingerprint && peer.fingerprint !== expectedFingerprint) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`peer fingerprint mismatch: expected ${expectedFingerprint.slice(0, 12)}…, got ${peer.fingerprint.slice(0, 12)}…`));
        return;
      }
      socket.write(JSON.stringify({ ...message, from: peerIdentitySelf(home) }) + "\n");
      socket.once("data", (chunk) => {
        buf += chunk.toString("utf8");
        const idx = buf.indexOf("\n");
        if (idx === -1) return;
        clearTimeout(timer);
        try {
          const reply = JSON.parse(buf.slice(0, idx));
          resolve({ reply, peer });
        } catch (e) {
          reject(new Error("bad reply from peer: " + e.message));
        }
        socket.end();
      });
    });
    socket.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

let selfCache = null;
export function peerIdentitySelf(home) {
  if (selfCache) return selfCache;
  const p = meshPaths(home);
  selfCache = peerIdentityFromCert(readFileSync(p.nodeCrt));
  return selfCache;
}

export async function meshStatus(home, peer) {
  const { reply, peer: identity } = await meshRequest(home, peer, { kind: "status" }, { expectedFingerprint: peer.certFingerprint || null });
  return { ...reply, peerIdentity: identity };
}

export async function meshSync(home, peer, myChain) {
  const { reply, peer: identity } = await meshRequest(home, peer, {
    kind: "sync-request",
    head: myChain.length ? myChain[myChain.length - 1].hash : "GENESIS",
    entries: myChain.length,
  }, { expectedFingerprint: peer.certFingerprint || null });
  return { ...reply, peerIdentity: identity };
}

// Sender side of a handoff: the caller appends the HANDOFF entry to its
// own chain FIRST, then transmits; the peer's RECEIPT comes back here.
export async function meshHandoff(home, peer, handoffEntry, payload) {
  const { reply, peer: identity } = await meshRequest(home, peer, {
    kind: "handoff",
    handoffHash: handoffEntry.hash,
    payloadHash: sha256(JSON.stringify(payload)),
    payload,
  }, { expectedFingerprint: peer.certFingerprint || null });
  return { ...reply, peerIdentity: identity };
}
