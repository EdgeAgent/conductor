import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const lib = createRequire(import.meta.url)("../src/lib.js");

const snapshot = {
  url: "https://shop.example.com/invoices",
  title: "Invoice Desk",
  headings: ["Invoices"],
  forms: [
    { cid: "f1", name: "add-invoice", method: "post", fields: [
      { cid: "i1", name: "client", label: "Client name", type: "text", required: true },
      { cid: "i2", name: "amount", label: "Amount", type: "number", required: true },
      { cid: "i3", name: "paid", label: "Paid", type: "checkbox" },
    ]},
    { cid: "f2", name: "search", method: "get", fields: [
      { cid: "i4", name: "q", label: "Search invoices", type: "search" },
    ]},
  ],
  buttons: [
    { cid: "b1", text: "Mark all paid" },
    { cid: "b2", text: "Load more" },
    { cid: "b3", text: "Mark all paid" },
  ],
  links: [{ cid: "l1", text: "Home", href: "/" }],
  tables: [{ cid: "t1", caption: "Invoices", columns: ["ID", "Client", "Amount"], rowCount: 12 }],
};

test("snapshot synthesis builds the always-on read tools", () => {
  const tools = lib.buildToolsFromSnapshot(snapshot);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("page_structure"));
  assert.ok(names.includes("extract_page_text"));
  assert.ok(names.includes("extract_links"));
  assert.ok(names.includes("extract_table_1"));
  assert.ok(tools.every((t) => t.id === t.name));
});

test("forms become typed tools; search/GET forms are read-class, POST forms write-class", () => {
  const tools = lib.buildToolsFromSnapshot(snapshot);
  const add = tools.find((t) => t.name === "submit_add_invoice");
  assert.ok(add);
  assert.equal(add.risk, "write");
  assert.equal(add.inputSchema.properties.amount.type, "number");
  assert.equal(add.inputSchema.properties.paid.type, "boolean");
  assert.deepEqual(add.inputSchema.required.sort(), ["amount", "client"]);
  const search = tools.find((t) => t.name === "submit_search");
  assert.equal(search.risk, "read");
});

test("buttons dedupe and get risk by label", () => {
  const tools = lib.buildToolsFromSnapshot(snapshot);
  const clicks = tools.filter((t) => t.name.startsWith("click_") && t.name !== "click_by_text");
  assert.equal(clicks.length, 2); // duplicate "Mark all paid" collapsed
  assert.equal(clicks.find((t) => t.name === "click_mark_all_paid").risk, "write");
  assert.equal(clicks.find((t) => t.name === "click_load_more").risk, "read");
});

test("native WebMCP tools wrap with annotation-driven risk", () => {
  const wrapped = lib.wrapNativeTools([
    { name: "getWeather", description: "Weather", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    { name: "bookFlight", description: "Book", inputSchema: { type: "object" } },
  ]);
  assert.equal(wrapped[0].risk, "read");
  assert.equal(wrapped[0].source, "webmcp");
  assert.equal(wrapped[1].risk, "write");
});

test("OpenAPI import turns paths into tools with method-based risk", () => {
  const spec = {
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/users/{id}": { get: { operationId: "getUser", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
      "/users": { post: { operationId: "createUser", requestBody: {} } },
    },
  };
  const tools = lib.toolsFromOpenApi(spec);
  assert.equal(tools.length, 2);
  assert.equal(tools.find((t) => t.name === "getuser").risk, "read");
  assert.equal(tools.find((t) => t.name === "createuser").risk, "write");
  assert.ok(tools.find((t) => t.name === "createuser").inputSchema.properties.body);
});

test("ollama tags parse to sorted names, tool-capable first", () => {
  const names = lib.parseOllamaTags({ models: [{ name: "tinyllama:1.1b" }, { name: "qwen2.5:7b" }, { name: "llama3.1:8b" }, {}] });
  assert.deepEqual(names, ["llama3.1:8b", "qwen2.5:7b", "tinyllama:1.1b"]);
  assert.deepEqual(lib.parseOllamaTags(null), []);
  assert.deepEqual(lib.parseOllamaTags({}), []);
  assert.equal(lib.isToolCapableModel("llama3.1:8b"), true);
  assert.equal(lib.isToolCapableModel("tinyllama:1.1b"), false);
});

test("route resolution is local-first and never silently cloud", () => {
  const up = { detected: true, models: ["llama3.1:8b"] };
  const down = { detected: false, models: [] };
  // auto: local when Ollama is up, even with a cloud key present
  assert.equal(lib.resolveRoute({ routePref: "auto", apiKey: "k" }, up).route, "local");
  assert.equal(lib.resolveRoute({}, up).model, "llama3.1:8b");
  // auto: cloud only because the user configured a key
  const cloud = lib.resolveRoute({ routePref: "auto", apiKey: "k", model: "m/x" }, down);
  assert.equal(cloud.route, "cloud");
  assert.equal(cloud.model, "m/x");
  // auto: nothing configured -> none (NOT a silent cloud default)
  assert.equal(lib.resolveRoute({ routePref: "auto" }, down).route, "none");
  // explicit prefs are honoured literally
  assert.equal(lib.resolveRoute({ routePref: "local" }, down).route, "none");
  assert.equal(lib.resolveRoute({ routePref: "local", localModel: "qwen2.5:7b" }, { detected: true, models: ["qwen2.5:7b"] }).model, "qwen2.5:7b");
  assert.equal(lib.resolveRoute({ routePref: "cloud" }, up).route, "none"); // no key
  assert.equal(lib.resolveRoute({ routePref: "cloud", apiKey: "k" }, down).route, "cloud");
});

test("chat requests are built per route (local = no key, no cloud URL)", () => {
  const msgs = [{ role: "user", content: "hi" }];
  const local = lib.buildChatRequest({ route: "local", model: "llama3.1:8b" }, { settings: { apiKey: "SECRET" }, messages: msgs, tools: [] });
  assert.equal(local.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(local.headers.Authorization, undefined);
  assert.equal(local.body.model, "llama3.1:8b");
  assert.equal(local.body.tools, undefined); // no tools -> field omitted
  const cloud = lib.buildChatRequest({ route: "cloud", model: "openrouter/free" }, { settings: { apiKey: "SECRET" }, messages: msgs, tools: [] });
  assert.equal(cloud.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(cloud.headers.Authorization, "Bearer SECRET");
  const proxied = lib.buildChatRequest({ route: "cloud", model: "x" }, { settings: { apiKey: "k", cloudBaseUrl: "http://127.0.0.1:11435/v1/" }, messages: msgs, tools: [] });
  assert.equal(proxied.url, "http://127.0.0.1:11435/v1/chat/completions");
});

test("route badge text and activity log append/cap", () => {
  assert.equal(lib.routeBadgeText({ route: "local" }), "Private · Local (Ollama)");
  assert.equal(lib.routeBadgeText({ route: "cloud" }), "Cloud (OpenRouter)");
  assert.equal(lib.routeBadgeText({ route: "none" }), "No model route");
  let log = [];
  for (let i = 0; i < 250; i++) log = lib.appendActivity(log, { ts: i, type: "tool", text: `e${i}` });
  assert.equal(log.length, 200);
  assert.equal(log[0].text, "e249"); // newest first
  assert.equal(log[199].text, "e50");
});

test("skills: seeds are valid, upsert/remove/prompt block behave", () => {
  const seeds = lib.seedSkills();
  assert.equal(seeds.length, 4);
  assert.ok(seeds.every((s) => s.builtin && s.name && s.instructions));
  assert.deepEqual(seeds.map((s) => s.name), ["Research this page", "Extract table to JSON", "Price watch summary", "Page action plan"]);
  const custom = lib.normalizeSkill({ name: " Mine ", instructions: " Do X " }, () => "id-1");
  assert.equal(custom.name, "Mine");
  assert.equal(custom.id, "id-1");
  assert.equal(lib.normalizeSkill({ name: "", instructions: "x" }, () => "i"), null);
  assert.equal(lib.normalizeSkill({ name: "x", instructions: " " }, () => "i"), null);
  let list = lib.upsertSkill(seeds, custom);
  assert.equal(list.length, 5);
  list = lib.upsertSkill(list, { ...custom, name: "Renamed" });
  assert.equal(list.length, 5);
  assert.equal(list.find((s) => s.id === "id-1").name, "Renamed");
  assert.equal(lib.removeSkill(list, "id-1").length, 4);
  const block = lib.skillPromptBlock(custom);
  assert.ok(block.includes("Do X") && block.includes("writes still ask first"));
  assert.equal(lib.skillPromptBlock(null), "");
});

test("scan summary counts flags and tolerates junk", () => {
  const sum = lib.summarizeScan({
    url: "https://shop.example/checkout", title: "Checkout",
    nativeTools: [{ name: "pay" }], synthesizedCount: 9,
    inventory: { forms: 2, fields: 11, tables: 0, buttons: 5, links: 20, headings: 3, passwordFields: 1, paymentLikely: true, fileInputs: 2 },
  }, 3);
  assert.equal(sum.apiToolCount, 3);
  assert.equal(sum.nativeTools.length, 1);
  assert.equal(sum.flags.length, 3);
  assert.ok(sum.flags[1].includes("payment"));
  const empty = lib.summarizeScan(null);
  assert.deepEqual(empty.flags, []);
  assert.equal(empty.inventory.forms, 0);
});

test("vault: defs/keys upsert, one key per origin, mask, clear", () => {
  let v = lib.emptyVault();
  const def = { id: "d1", name: "Billing API", origin: "https://api.example.com", source: "openapi", tools: [{ name: "get_invoices" }], savedAt: 1 };
  v = lib.upsertVaultDef(v, def);
  assert.equal(v.defs.length, 1);
  v = lib.upsertVaultDef(v, { ...def, name: "Billing API v2" });
  assert.equal(v.defs.length, 1);
  assert.equal(v.defs[0].name, "Billing API v2");
  v = lib.upsertVaultKey(v, { id: "k1", label: "prod", origin: "https://api.example.com", headerName: "Authorization", value: "sk-live-abcdef1234" });
  v = lib.upsertVaultKey(v, { id: "k2", label: "prod2", origin: "https://api.example.com/base", headerName: "X-Api-Key", value: "other-key-9999" });
  assert.equal(v.keys.length, 1); // same origin replaced
  assert.equal(lib.vaultKeyForOrigin(v, "https://api.example.com/anything").id, "k2");
  assert.equal(lib.vaultKeyForOrigin(v, "https://other.example.com"), null);
  assert.equal(lib.maskKeyValue("sk-live-abcdef1234"), "••••1234");
  assert.equal(lib.maskKeyValue(""), "");
  v = lib.removeVaultKey(v, "k2");
  assert.equal(v.keys.length, 0);
  v = lib.upsertVaultKey(v, { id: "k3", label: "x", origin: "https://a.io", headerName: "Authorization", value: "v123456" });
  v = lib.clearVaultKeys(v);
  assert.equal(v.keys.length, 0);
  assert.equal(v.defs.length, 1); // defs survive key clearing
  v = lib.removeVaultDef(v, "d1");
  assert.equal(v.defs.length, 0);
  assert.deepEqual(lib.normalizeVault(null), { defs: [], keys: [] });
  assert.deepEqual(lib.normalizeVault({ defs: [{ nope: 1 }], keys: "x" }), { defs: [], keys: [] });
});

test("vault: keys attach transiently and NEVER appear in any export", () => {
  const secret = "sk-live-abcdef1234";
  const tool = {
    name: "get_invoices", description: "List invoices", risk: "read", source: "api",
    inputSchema: { type: "object", properties: {} },
    action: { kind: "api", method: "GET", path: "/invoices", origin: "https://api.example.com" },
  };
  const attached = lib.attachVaultKey(tool, { headerName: "Authorization", value: secret });
  assert.equal(attached.action.headers.Authorization, secret);
  assert.equal(tool.action.headers, undefined); // original untouched — registry stays clean
  // Every export surface must be secret-free even for an attached tool:
  const mcp = JSON.stringify(lib.toolsToMcpExport([attached], { url: "https://api.example.com" }));
  assert.ok(!mcp.includes(secret), "MCP export leaked a vault key");
  const forModel = JSON.stringify(lib.toolsToOpenAi([attached]));
  assert.ok(!forModel.includes(secret), "model tool list leaked a vault key");
  const redacted = lib.redactTool(attached);
  assert.ok(!JSON.stringify(redacted).includes(secret), "redactTool leaked a vault key");
  assert.equal(lib.attachVaultKey(tool, null), tool);
});

test("vault: manual endpoint lines parse into api tools", () => {
  const tools = lib.toolsFromEndpointLines("https://api.example.com", [
    "GET /invoices — list invoices",
    "POST /invoices/{id}/pay",
    "not an endpoint",
    "DELETE /invoices/{id} — remove",
  ].join("\n"));
  assert.equal(tools.length, 3);
  assert.equal(tools[0].risk, "read");
  assert.equal(tools[0].description, "list invoices");
  assert.equal(tools[1].risk, "write");
  assert.equal(tools[1].action.origin, "https://api.example.com");
  assert.equal(tools[2].action.method, "DELETE");
});

test("merge prefers earlier sets on name collision; exports are well-formed", () => {
  const dom = lib.buildToolsFromSnapshot(snapshot);
  const native = lib.wrapNativeTools([{ name: "extract_page_text", description: "native wins", annotations: { readOnlyHint: true } }]);
  const merged = lib.mergeTools(native, dom);
  const winner = merged.find((t) => t.name === "extract_page_text");
  assert.equal(winner.source, "webmcp");
  const mcp = lib.toolsToMcpExport(merged, { url: snapshot.url });
  assert.ok(mcp.tools.length >= 8);
  assert.equal(mcp.tools[0].annotations.source, "webmcp");
  const oai = lib.toolsToOpenAi(merged);
  assert.equal(oai[0].type, "function");
  const rs = lib.riskSummary(merged);
  assert.equal(rs.reads + rs.writes, rs.total);
});
