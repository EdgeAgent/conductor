#!/usr/bin/env node
// Conductor MCP bridge — run this on your machine, point your MCP client at it,
// and your agents can use the tools of whatever page is active in Chrome.
//
//   node conductor-bridge.mjs
//
// How it works: the bridge is an MCP server over stdio (what your client talks
// to) and a WebSocket server on ws://127.0.0.1:8787 (what the Conductor
// extension connects to, when you enable the bridge in its Settings).
// tools/list and tools/call are relayed to the extension; the extension runs
// them on the active tab. Read tools run immediately; write tools are refused
// unless you enabled bridge writes in Conductor's Settings (the side-panel
// chat is the approval path for writes).
import { WebSocketServer } from "ws";
import readline from "node:readline";

const PORT = 8787;
let extension = null;
let callSeq = 0;
const pending = new Map(); // id -> { resolve, reject, timer }

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("error", (err) => {
  console.error(`[conductor-bridge] WebSocket server error: ${err.message}`);
  if (String(err.message).includes("EADDRINUSE")) {
    console.error("[conductor-bridge] Port 8787 is taken — is another bridge already running?");
    process.exit(1);
  }
});
wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.kind === "hello") {
      extension = ws;
      console.error("[conductor-bridge] Conductor extension connected.");
    } else if (msg.kind === "tools") {
      for (const [id, p] of pending.entries()) {
        if (p.kind === "list") {
          pending.delete(id);
          clearTimeout(p.timer);
          p.resolve(msg.tools || []);
        }
      }
    } else if (msg.kind === "result") {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || "Tool call failed."));
      }
    } else if (msg.kind === "model-chat") {
      // Model proxy: the extension asks the bridge to call a LOCAL model
      // server (Ollama) because a plain Node process has no browser-origin
      // restrictions. Hard rule: only http://127.0.0.1 URLs are proxied —
      // the bridge must never become a general-purpose proxy, and cloud
      // model calls are never routed through here.
      handleModelChat(ws, msg).catch((err) => {
        try { ws.send(JSON.stringify({ kind: "model-result", id: msg.id, ok: false, error: String(err && err.message ? err.message : err) })); } catch { /* socket gone */ }
      });
    }
  });
  ws.on("close", () => {
    if (extension === ws) extension = null;
    console.error("[conductor-bridge] Conductor extension disconnected.");
  });
});
console.error(`[conductor-bridge] Listening for the extension on ws://127.0.0.1:${PORT}`);

function askExtension(payload, kind, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!extension || extension.readyState !== 1) {
      reject(new Error("Conductor extension is not connected. Open Chrome, enable 'Connect to the local MCP bridge' in Conductor Settings, and make sure this bridge is running."));
      return;
    }
    const id = "b" + (++callSeq);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for the extension (30s)."));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, kind });
    extension.send(JSON.stringify({ ...payload, id }));
  });
}

async function handleModelChat(ws, msg) {
  const replyModel = (payload) => ws.send(JSON.stringify({ kind: "model-result", id: msg.id, ...payload }));
  let url;
  try { url = new URL(String(msg.url || "")); } catch { return replyModel({ ok: false, error: "Bad model URL." }); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    return replyModel({ ok: false, error: "Bridge model proxy only calls http://127.0.0.1 — refusing anything else." });
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(msg.headers || {}) },
    body: JSON.stringify(msg.body || {}),
  });
  const text = await res.text();
  if (!res.ok) return replyModel({ ok: false, error: `Model call failed (${res.status})${text ? ": " + text.slice(0, 300) : ""}` });
  try { return replyModel({ ok: true, data: JSON.parse(text) }); }
  catch { return replyModel({ ok: false, error: "Model server returned non-JSON." }); }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "conductor-bridge", version: "1.2.0" },
      });
    case "ping":
      return reply(id, {});
    case "tools/list": {
      try {
        const tools = await askExtension({ kind: "list" }, "list");
        return reply(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema || { type: "object", properties: {} },
          })),
        });
      } catch (err) {
        return replyError(id, -32000, err.message);
      }
    }
    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        const result = await askExtension({ kind: "call", tool: name, args }, "call");
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return reply(id, { content: [{ type: "text", text }], isError: false });
      } catch (err) {
        return reply(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
      }
    }
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  handle(msg).catch((err) => console.error("[conductor-bridge] handler error:", err));
});
console.error("[conductor-bridge] MCP stdio ready. Point your MCP client at this command.");
