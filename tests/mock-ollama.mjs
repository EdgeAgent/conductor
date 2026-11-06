// Mock Ollama + cloud-spy servers for Conductor's local-first routing tests.
//
// Port 11434 — Ollama stand-in:
//   GET  /api/tags              -> two models (llama3.1:8b tool-capable, tinyllama:1.1b not)
//   POST /v1/chat/completions   -> first call: an extract_page_text tool_call;
//                                  once a tool result is in history: a final text answer.
//   Origin policy mimics Ollama's defaults: preflight (OPTIONS) from an
//   origin outside the allowlist is refused with 403 and no CORS headers;
//   simple requests are processed. (Extension fetches with a host
//   permission don't preflight — that's the path Conductor uses.)
//
// Port 11435 — OpenRouter spy: counts chat calls so tests can prove the
// cloud is NOT called silently. GET /__stats on either port reports counts.
import http from "node:http";

const stats = { tags: 0, localChat: 0, cloudChat: 0 };
const ALLOW_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}
function json(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

const ollama = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  if (req.method === "OPTIONS") {
    if (origin && !ALLOW_ORIGIN.test(origin)) { res.writeHead(403); return res.end("origin not allowed"); }
    res.writeHead(204, { "Access-Control-Allow-Origin": origin || "*", "Access-Control-Allow-Methods": "POST, GET", "Access-Control-Allow-Headers": "content-type, authorization" });
    return res.end();
  }
  const cors = ALLOW_ORIGIN.test(origin) ? { "Access-Control-Allow-Origin": origin } : {};
  if (req.url === "/__stats") return json(res, 200, stats);
  if (req.url === "/__reset") { stats.tags = 0; stats.localChat = 0; stats.cloudChat = 0; return json(res, 200, { ok: true }); }
  if (req.method === "GET" && req.url === "/api/tags") {
    stats.tags++;
    return json(res, 200, {
      models: [
        { name: "llama3.1:8b", model: "llama3.1:8b", size: 4661224676, digest: "mock-digest-1" },
        { name: "tinyllama:1.1b", model: "tinyllama:1.1b", size: 668000000, digest: "mock-digest-2" },
      ],
    }, cors);
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    stats.localChat++;
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* keep {} */ }
    const msgs = body.messages || [];
    const hasToolResult = msgs.some((m) => m.role === "tool");
    if (hasToolResult) {
      return json(res, 200, {
        id: "chatcmpl-mock-local",
        model: body.model || "llama3.1:8b",
        choices: [{ index: 0, message: { role: "assistant", content: "Mock local answer: I read the page with a tool and finished the task." }, finish_reason: "stop" }],
      }, cors);
    }
    return json(res, 200, {
      id: "chatcmpl-mock-local",
      model: body.model || "llama3.1:8b",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_mock_1", type: "function", function: { name: "extract_page_text", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      }],
    }, cors);
  }
  return json(res, 404, { error: "not found" });
});

const cloud = http.createServer(async (req, res) => {
  if (req.url === "/__stats") return json(res, 200, stats);
  if (req.url === "/__reset") { stats.cloudChat = 0; return json(res, 200, { ok: true }); }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    stats.cloudChat++;
    await readBody(req);
    return json(res, 200, {
      id: "chatcmpl-mock-cloud",
      model: "mock/cloud-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Cloud mock answer: handled on OpenRouter because you chose cloud for this task." }, finish_reason: "stop" }],
    });
  }
  return json(res, 404, { error: "not found" });
});

// MOCK_ONLY=ollama|cloud runs just one server (tests kill Ollama while the
// cloud spy stays alive, to prove no silent cloud call happens).
if (process.env.MOCK_ONLY !== "cloud") {
  ollama.listen(11434, "127.0.0.1", () => console.error("[mock-ollama] Ollama mock on http://127.0.0.1:11434"));
}
if (process.env.MOCK_ONLY !== "ollama") {
  cloud.listen(11435, "127.0.0.1", () => console.error("[mock-ollama] Cloud spy on http://127.0.0.1:11435"));
}
