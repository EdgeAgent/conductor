// Mesh identity — root CA + node certificates via openssl (Ed25519 root,
// node keys Ed25519 or P-256 for browser companions). Private keys are
// generated on this machine, stored 0600 in the mesh home, and NEVER
// returned over any interface — callers get fingerprints and certs only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export function meshPaths(home) {
  return {
    home,
    rootKey: join(home, "root.key"),
    rootCrt: join(home, "root.crt"),
    nodeKey: join(home, "node.key"),
    nodeCsr: join(home, "node.csr"),
    nodeCrt: join(home, "node.crt"),
    nodeMeta: join(home, "node.json"),
    chain: join(home, "chain.json"),
    peersDir: join(home, "peers"),
  };
}

function ssl(args, opts = {}) {
  return execFileSync("openssl", args, { encoding: "utf8", ...opts });
}

export function certFingerprint(crtFile) {
  const der = ssl(["x509", "-in", crtFile, "-outform", "DER"], { encoding: "buffer" });
  return createHash("sha256").update(der).digest("hex");
}

export function initRoot(home, { force = false } = {}) {
  const p = meshPaths(home);
  mkdirSync(home, { recursive: true });
  if (existsSync(p.rootKey) && !force) return { created: false, fingerprint: certFingerprint(p.rootCrt) };
  ssl(["genpkey", "-algorithm", "ED25519", "-out", p.rootKey]);
  chmodSync(p.rootKey, 0o600);
  ssl(["req", "-new", "-x509", "-key", p.rootKey, "-out", p.rootCrt, "-days", "3650",
    "-subj", "/CN=Edge Agency Mesh Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  return { created: true, fingerprint: certFingerprint(p.rootCrt) };
}

export function rootReady(home) {
  const p = meshPaths(home);
  return existsSync(p.rootKey) && existsSync(p.rootCrt);
}

// Generate this node's identity keypair + CSR (private key never leaves).
export function generateNodeKey(home, name, { algo = "ED25519" } = {}) {
  const p = meshPaths(home);
  mkdirSync(home, { recursive: true });
  if (algo === "ED25519") ssl(["genpkey", "-algorithm", "ED25519", "-out", p.nodeKey]);
  else ssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", p.nodeKey]);
  chmodSync(p.nodeKey, 0o600);
  ssl(["req", "-new", "-key", p.nodeKey, "-out", p.nodeCsr, "-subj", `/CN=${name}`]);
  writeFileSync(p.nodeMeta, JSON.stringify({ name, createdAt: new Date().toISOString() }, null, 2));
  return { name };
}

// Root-sign a CSR (or a bare public key via -force_pubkey) into a node cert.
export function signNodeCert(home, { csrFile, pubKeyFile, name, outFile, days = 825 }) {
  const p = meshPaths(home);
  if (!rootReady(home)) throw new Error("root CA not initialized on this machine");
  const args = ["x509", "-req", "-in", csrFile, "-CA", p.rootCrt, "-CAkey", p.rootKey,
    "-CAcreateserial", "-out", outFile, "-days", String(days),
    "-extfile", "-", "-extensions", "ext"];
  const ext = `[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=URI:mesh:${name},DNS:${name}\n`;
  if (pubKeyFile) args.push("-force_pubkey", pubKeyFile);
  execFileSync("openssl", args, { input: ext, encoding: "utf8" });
  return { fingerprint: certFingerprint(outFile) };
}

// This machine's own enrollment: generate key + self-issue via the local root.
export function enrollSelf(home, name) {
  const p = meshPaths(home);
  generateNodeKey(home, name);
  const { fingerprint } = signNodeCert(home, { csrFile: p.nodeCsr, name, outFile: p.nodeCrt });
  const meta = JSON.parse(readFileSync(p.nodeMeta, "utf8"));
  meta.certFingerprint = fingerprint;
  meta.rootFingerprint = certFingerprint(p.rootCrt);
  writeFileSync(p.nodeMeta, JSON.stringify(meta, null, 2));
  return meta;
}

export function nodeReady(home) {
  const p = meshPaths(home);
  return existsSync(p.nodeCrt) && existsSync(p.nodeKey) && existsSync(p.nodeMeta);
}

export function publicIdentity(home) {
  const p = meshPaths(home);
  const meta = JSON.parse(readFileSync(p.nodeMeta, "utf8"));
  return {
    name: meta.name,
    certFingerprint: meta.certFingerprint,
    rootFingerprint: meta.rootFingerprint,
    certPem: readFileSync(p.nodeCrt, "utf8"),
    rootCertPem: readFileSync(p.rootCrt, "utf8"),
  };
}
