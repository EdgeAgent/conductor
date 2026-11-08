// Conductor core library — pure logic shared by the content script, service
// worker, side panel, and (in Node) the tests. UMD: works as a classic script
// (window.ConductorLib / self.ConductorLib) and via require() in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ConductorLib = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function slugify(text, fallback = "tool") {
    const s = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
    return s || fallback;
  }

  function uniqName(base, used) {
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${base}_${i++}`;
    used.add(name);
    return name;
  }

  const READ_BUTTON_RE = /^(show|view|see|expand|load|next|previous|prev|back|more|details|open|close|hide|collapse)\b/i;

  /**
   * Build tool definitions from a page snapshot (produced by the content script):
   * snapshot = { url, title, headings:[], forms:[{cid,name,method,fields:[{cid,name,label,type,required,options}]}],
   *              buttons:[{cid,text}], links:[{cid,text,href}], tables:[{cid,caption,columns:[],rowCount}] }
   * Tool = { id, name, description, inputSchema, risk:'read'|'write', source:'dom', action:{...} }
   */
  function buildToolsFromSnapshot(snapshot) {
    const tools = [];
    const used = new Set();
    if (!snapshot) return tools;
    const pageName = snapshot.title || snapshot.url || "this page";

    const add = (tool) => {
      tool.name = uniqName(tool.name, used);
      tool.id = tool.name;
      tools.push(tool);
    };

    add({
      name: "page_structure",
      description: `Get an outline of "${pageName}": headings, forms, tables, and main actions available.`,
      inputSchema: { type: "object", properties: {} },
      risk: "read",
      source: "dom",
      action: { kind: "structure" },
    });
    add({
      name: "extract_page_text",
      description: "Extract the readable text content of the current page (or of one section via a CSS selector).",
      inputSchema: {
        type: "object",
        properties: { selector: { type: "string", description: "Optional CSS selector to scope extraction." } },
      },
      risk: "read",
      source: "dom",
      action: { kind: "extract-text" },
    });
    add({
      name: "extract_links",
      description: "List the links on the current page with their text and URLs.",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
      source: "dom",
      action: { kind: "extract-links" },
    });

    (snapshot.tables || []).slice(0, 5).forEach((t, i) => {
      add({
        name: `extract_table_${i + 1}`,
        description: `Extract table ${i + 1}${t.caption ? ` ("${t.caption}")` : ""} as JSON rows. Columns: ${(t.columns || []).join(", ") || "unknown"}. About ${t.rowCount} rows.`,
        inputSchema: { type: "object", properties: { maxRows: { type: "number", description: "Cap rows returned (default 100)." } } },
        risk: "read",
        source: "dom",
        action: { kind: "extract-table", cid: t.cid },
      });
    });

    (snapshot.forms || []).slice(0, 5).forEach((f, i) => {
      const properties = {};
      const required = [];
      for (const field of f.fields || []) {
        const key = slugify(field.name || field.label, `field_${Object.keys(properties).length + 1}`);
        const prop = { description: field.label || field.name || key };
        if (field.type === "checkbox") prop.type = "boolean";
        else if (field.type === "number" || field.type === "range") prop.type = "number";
        else prop.type = "string";
        if (field.options && field.options.length) prop.enum = field.options.slice(0, 50);
        properties[key] = prop;
        if (field.required) required.push(key);
      }
      const label = f.name || `form ${i + 1}`;
      const isSearch = /search/i.test(label) || (f.fields || []).some((x) => x.type === "search");
      const isGet = (f.method || "get").toLowerCase() === "get";
      add({
        name: uniqName(`submit_${slugify(label, `form_${i + 1}`)}`, new Set()), // placeholder, add() re-uniques
        description: `${isSearch ? "Search using" : "Fill and submit"} the "${label}" form on this page. Fields: ${Object.keys(properties).join(", ") || "none"}.`,
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
        risk: isSearch || isGet ? "read" : "write",
        source: "dom",
        action: { kind: "submit-form", cid: f.cid },
      });
    });

    const seenButtons = new Set();
    for (const b of (snapshot.buttons || []).slice(0, 40)) {
      const text = (b.text || "").trim();
      if (text.length < 2 || text.length > 48 || seenButtons.has(text.toLowerCase())) continue;
      seenButtons.add(text.toLowerCase());
      if (tools.length >= 24) break;
      add({
        name: `click_${slugify(text, "button")}`,
        description: `Click the "${text}" button on this page.`,
        inputSchema: { type: "object", properties: {} },
        risk: READ_BUTTON_RE.test(text) ? "read" : "write",
        source: "dom",
        action: { kind: "click-element", cid: b.cid },
      });
    }

    add({
      name: "click_by_text",
      description: "Click any button or link on the page by its visible text.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      risk: "write",
      source: "dom",
      action: { kind: "click-by-text" },
    });
    add({
      name: "fill_field",
      description: "Type a value into a form field identified by its label or placeholder text.",
      inputSchema: {
        type: "object",
        properties: { label: { type: "string" }, value: { type: "string" } },
        required: ["label", "value"],
      },
      risk: "write",
      source: "dom",
      action: { kind: "fill-field" },
    });
    add({
      name: "navigate_to",
      description: "Navigate the current tab to a URL.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      risk: "write",
      source: "dom",
      action: { kind: "navigate" },
    });

    return tools;
  }

  /** Wrap tools discovered natively via WebMCP (navigator.modelContext) into Conductor's shape. */
  function wrapNativeTools(rawTools) {
    const used = new Set();
    const out = [];
    for (const t of rawTools || []) {
      if (!t || !t.name) continue;
      const name = uniqName(slugify(t.name, "native_tool"), used);
      const readOnly = t.annotations && (t.annotations.readOnlyHint === true || t.annotations.readOnly === true);
      out.push({
        id: name,
        name,
        description: t.description || `Native WebMCP tool "${t.name}" exposed by this page.`,
        inputSchema: t.inputSchema || { type: "object", properties: {} },
        risk: readOnly ? "read" : "write",
        source: "webmcp",
        action: { kind: "webmcp", nativeName: t.name },
      });
    }
    return out;
  }

  /** Import an API Lens OpenAPI export: paths become callable tools (executed in page context). */
  function toolsFromOpenApi(spec) {
    const out = [];
    const used = new Set();
    const origin = (spec && spec.servers && spec.servers[0] && spec.servers[0].url) || "";
    for (const [path, item] of Object.entries((spec && spec.paths) || {})) {
      for (const [method, op] of Object.entries(item || {})) {
        if (!op || typeof op !== "object") continue;
        const m = method.toUpperCase();
        const rawName = op.operationId || `${m}_${path}`;
        const name = uniqName(slugify(rawName, "api_call"), used);
        const properties = {};
        const required = [];
        for (const p of op.parameters || []) {
          if (p.in === "body") continue;
          properties[p.name] = { type: (p.schema && p.schema.type) || "string", description: `${p.in} parameter` };
          if (p.required) required.push(p.name);
        }
        if (op.requestBody) {
          properties.body = { type: "object", description: "JSON request body." };
        }
        out.push({
          id: name,
          name,
          description: op.summary || `${m} ${path} (imported from API Lens)`,
          inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
          risk: m === "GET" || m === "HEAD" ? "read" : "write",
          source: "api",
          action: { kind: "api", method: m, path, origin },
        });
      }
    }
    return out;
  }

  /** Merge tool sets: WebMCP native wins name collisions, then API imports, then DOM. */
  function mergeTools(...sets) {
    const byName = new Map();
    for (const set of sets) {
      for (const t of set || []) {
        if (!byName.has(t.name)) byName.set(t.name, t);
      }
    }
    return [...byName.values()];
  }

  // ---------------- Local-first model routing (Ollama / OpenRouter) ----------------
  // Pure routing logic shared by the service worker (which executes model
  // calls) and the tests. Kevin's hard rule: page data goes to the cloud ONLY
  // when the user configured a cloud key as their route, or explicitly flips
  // "use cloud for this task" — never as a silent fallback.

  const OLLAMA_URL = "http://127.0.0.1:11434";
  const OPENROUTER_URL = "https://openrouter.ai/api/v1";
  const RECOMMENDED_LOCAL_MODEL = "llama3.1:8b";

  // Families with reliable OpenAI-style tool calling in Ollama. Used ONLY to
  // order/annotate the model picker — every installed model stays selectable.
  const TOOL_MODEL_RE = /(llama3\.[123]|llama-3\.[123]|qwen2\.5|qwen3|mistral|mixtral|command-r|devstral|firefunction|hermes|phi[34]|gemma[23]|deepseek)/i;

  function isToolCapableModel(name) {
    return TOOL_MODEL_RE.test(String(name || ""));
  }

  /** /api/tags payload -> sorted model names (tool-capable first, then A-Z). */
  function parseOllamaTags(json) {
    const names = ((json && json.models) || []).map((m) => (m && m.name) || "").filter(Boolean);
    return names.sort((a, b) => {
      const d = Number(isToolCapableModel(b)) - Number(isToolCapableModel(a));
      return d !== 0 ? d : a.localeCompare(b);
    });
  }

  /**
   * Decide the route for a chat round.
   * settings: { routePref: 'auto'|'local'|'cloud', apiKey, model, localModel, cloudBaseUrl }
   * ollama:   { detected: bool, models: [names] }
   * Returns { route: 'local'|'cloud'|'none', model, reason }.
   */
  function resolveRoute(settings, ollama) {
    const s = settings || {};
    const pref = s.routePref || "auto";
    const detected = !!(ollama && ollama.detected);
    const localModel = s.localModel || (detected && ollama.models && ollama.models[0]) || "";
    const hasLocal = detected && !!localModel;
    if (pref === "cloud") {
      return s.apiKey
        ? { route: "cloud", model: s.model || "openrouter/free", reason: "You chose the Cloud route." }
        : { route: "none", model: "", reason: "Cloud route chosen, but no OpenRouter API key is set." };
    }
    if (pref === "local") {
      return hasLocal
        ? { route: "local", model: localModel, reason: "You chose the Local route." }
        : { route: "none", model: "", reason: "Local route chosen, but Ollama isn't reachable or has no model selected." };
    }
    // auto: local-first
    if (hasLocal) return { route: "local", model: localModel, reason: "Ollama detected — running privately on this machine." };
    if (s.apiKey) return { route: "cloud", model: s.model || "openrouter/free", reason: "No Ollama found — using the OpenRouter key you configured." };
  return { route: "none", model: "", reason: "No Ollama detected and no OpenRouter key configured." };
  }

  /** Build the fetch request for one chat round on a resolved route. */
  function buildChatRequest(route, opts) {
    const { settings, messages, tools } = opts || {};
    const s = settings || {};
    const body = {
      model: route.model,
      messages: messages || [],
      temperature: 0.2,
      stream: false,
    };
    if (tools && tools.length) body.tools = toolsToOpenAi(tools);
    if (route.route === "local") {
      return {
        url: `${OLLAMA_URL}/v1/chat/completions`,
        headers: { "Content-Type": "application/json" },
        body,
      };
    }
    const base = String(s.cloudBaseUrl || OPENROUTER_URL).replace(/\/+$/, "");
    return {
      url: `${base}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${s.apiKey || ""}`,
        "X-Title": "Conductor",
      },
      body,
    };
  }

  function routeBadgeText(routeInfo) {
    if (!routeInfo) return "Checking route…";
    if (routeInfo.route === "local") return "Private · Local (Ollama)";
    if (routeInfo.route === "cloud") return "Cloud (OpenRouter)";
    return "No model route";
  }

  // ---------------- Model usage, pricing & traces (v2.1) ----------------
  // Every model call is accounted: tokens in/out and an estimated cost from
  // a dated reference price table (USD per 1M tokens). Prices are ESTIMATES
  // for display — the provider bill is the truth. The local (Ollama) route
  // always costs $0. Users can override any model's price in Settings via
  // settings.priceOverrides = { "model/id": { in, out } }.

  const PRICE_TABLE_DATE = "2026-11";
  const MODEL_PRICES = {
    "openrouter/free": { in: 0, out: 0 },
    "openai/gpt-4o-mini": { in: 0.15, out: 0.60 },
    "openai/gpt-4o": { in: 2.50, out: 10.00 },
    "openai/gpt-4.1-mini": { in: 0.40, out: 1.60 },
    "anthropic/claude-sonnet-4": { in: 3.00, out: 15.00 },
    "anthropic/claude-3.5-haiku": { in: 0.80, out: 4.00 },
    "google/gemini-2.5-flash": { in: 0.30, out: 2.50 },
    "google/gemini-2.5-pro": { in: 1.25, out: 10.00 },
    "deepseek/deepseek-chat": { in: 0.27, out: 1.10 },
    "meta-llama/llama-3.3-70b-instruct": { in: 0.10, out: 0.32 },
    "qwen/qwen-2.5-72b-instruct": { in: 0.33, out: 0.40 },
  };

  function modelPrice(model, route, overrides) {
    if (route === "local") return { inPerM: 0, outPerM: 0, source: "local" };
    const o = overrides && model ? overrides[model] : null;
    if (o && isFinite(+o.in) && isFinite(+o.out)) return { inPerM: +o.in, outPerM: +o.out, source: "custom" };
    const t = model ? MODEL_PRICES[model] : null;
    if (t) return { inPerM: t.in, outPerM: t.out, source: "table" };
    if (/free/i.test(String(model || ""))) return { inPerM: 0, outPerM: 0, source: "free" };
    return null; // unknown model: tokens still counted, cost shown as —
  }

  /** Pull {prompt, completion} token counts out of a provider response. Pure. */
  function extractUsage(route, data) {
    if (!data || typeof data !== "object") return null;
    if (route === "local") {
      const p = data.prompt_eval_count, c = data.eval_count;
      if (typeof p === "number" || typeof c === "number") {
        return { prompt: Math.max(0, p | 0) || 0, completion: Math.max(0, c | 0) || 0 };
      }
    }
    const u = data.usage;
    if (u && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number")) {
      return { prompt: Math.max(0, u.prompt_tokens | 0) || 0, completion: Math.max(0, u.completion_tokens | 0) || 0 };
    }
    return null;
  }

  function callCostUsd(price, usage) {
    if (!price || !usage) return null;
    return (usage.prompt * price.inPerM + usage.completion * price.outPerM) / 1e6;
  }

  function emptyUsageBucket() {
    return { calls: 0, prompt: 0, completion: 0, costUsd: 0, unpricedCalls: 0, models: {} };
  }
  function emptyUsageStore() {
    return { days: {}, total: emptyUsageBucket(), recent: [] };
  }
  function usageDayKey(ts) {
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
  function addToBucket(bucket, rec) {
    bucket.calls += 1;
    bucket.prompt += rec.prompt | 0;
    bucket.completion += rec.completion | 0;
    if (typeof rec.costUsd === "number") bucket.costUsd += rec.costUsd;
    else bucket.unpricedCalls += 1;
    const key = `${rec.route}:${rec.model}`;
    const m = bucket.models[key] || (bucket.models[key] = { calls: 0, prompt: 0, completion: 0, costUsd: 0, unpricedCalls: 0 });
    m.calls += 1;
    m.prompt += rec.prompt | 0;
    m.completion += rec.completion | 0;
    if (typeof rec.costUsd === "number") m.costUsd += rec.costUsd;
    else m.unpricedCalls += 1;
  }
  /** Record one call into the store (returns a new store). Pure. */
  function recordUsage(store, rec) {
    const s = store && store.days ? store : emptyUsageStore();
    const next = { days: { ...s.days }, total: JSON.parse(JSON.stringify(s.total)), recent: (s.recent || []).slice() };
    const day = usageDayKey(rec.ts || Date.now());
    const dayBucket = next.days[day] ? JSON.parse(JSON.stringify(next.days[day])) : emptyUsageBucket();
    addToBucket(dayBucket, rec);
    next.days[day] = dayBucket;
    addToBucket(next.total, rec);
    next.recent.unshift({ ts: rec.ts, route: rec.route, model: rec.model, prompt: rec.prompt | 0, completion: rec.completion | 0, costUsd: typeof rec.costUsd === "number" ? rec.costUsd : null });
    next.recent = next.recent.slice(0, 100);
    // keep at most 62 day buckets
    const keys = Object.keys(next.days).sort();
    while (keys.length > 62) delete next.days[keys.shift()];
    return next;
  }
  /** Sum the last N day-buckets (including today). Pure. */
  function usageWindow(store, daysBack, nowTs) {
    const out = emptyUsageBucket();
    if (!store || !store.days) return out;
    for (let i = 0; i < daysBack; i++) {
      const b = store.days[usageDayKey(nowTs - i * 86400000)];
      if (!b) continue;
      out.calls += b.calls; out.prompt += b.prompt; out.completion += b.completion;
      out.costUsd += b.costUsd; out.unpricedCalls += b.unpricedCalls;
      for (const [k, m] of Object.entries(b.models || {})) {
        const t = out.models[k] || (out.models[k] = { calls: 0, prompt: 0, completion: 0, costUsd: 0, unpricedCalls: 0 });
        t.calls += m.calls; t.prompt += m.prompt; t.completion += m.completion; t.costUsd += m.costUsd; t.unpricedCalls += m.unpricedCalls;
      }
    }
    return out;
  }
  function formatTokens(n) {
    n = Math.max(0, Math.round(+n || 0));
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1000).toFixed(n < 100000 ? 1 : 0).replace(/\.0$/, "") + "k";
    return (n / 1e6).toFixed(2).replace(/0$/, "") + "M";
  }
  function formatUsd(x) {
    if (typeof x !== "number" || !isFinite(x)) return "—";
    if (x === 0) return "$0.00";
    if (x < 0.01) return "$" + x.toFixed(4);
    if (x < 1) return "$" + x.toFixed(3).replace(/0$/, "");
    return "$" + x.toFixed(2);
  }

  /** Append one entry to the activity log (newest first, capped). Pure. */
  function appendActivity(entries, entry, cap = 200) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    list.unshift(entry);
    return list.slice(0, cap);
  }

  // ---------------- Skills library (pure helpers) ----------------
  // Skills are user-owned instruction packs. They shape the chat's system
  // prompt only — they never change tool risk or bypass the approval gate.

  function seedSkills() {
    return [
      {
        id: "builtin-research",
        name: "Research this page",
        description: "Summarize the page, pull out the key facts, and cite what's actually on it.",
        instructions: "Research this page thoroughly. Use read tools (page structure, page text, links) to gather the facts first. Then report: (1) a 3-5 sentence summary, (2) the key facts as a bullet list with the actual values/names/dates from the page, (3) anything uncertain or missing, labelled as such. Never invent facts that aren't on the page.",
        origin: "",
        builtin: true,
      },
      {
        id: "builtin-extract-table",
        name: "Extract table to JSON",
        description: "Pull the page's main table out as clean JSON rows.",
        instructions: "Extract the main table on this page as JSON. Use the extract_table tool for the most relevant table (ask me which one only if there are several large tables). Return valid JSON only in a code block, then one line saying how many rows you extracted. Do not add commentary inside the JSON.",
        origin: "",
        builtin: true,
      },
      {
        id: "builtin-price-watch",
        name: "Price watch summary",
        description: "Extract product name, price, and availability from a product page.",
        instructions: "This is a price-watch task. From this page extract: product name, current price (with currency), any sale/list price, availability (in stock / out of stock / unknown), seller or store name, and the page URL. Present it as a short labelled list. If a value isn't on the page, write 'not shown' — never guess a price.",
        origin: "",
        builtin: true,
      },
      {
        id: "builtin-action-plan",
        name: "Page action plan",
        description: "List what an agent could do on this site, split into reads vs writes — no actions taken.",
        instructions: "Produce an action plan for this page, and take NO actions. List: (1) what you can read or extract here (the read tools and what each would give), (2) what you could change or submit (the write tools) — clearly marked as needing my approval, (3) anything risky or sensitive you noticed (payment forms, password fields, personal data). Keep it short and concrete.",
        origin: "",
        builtin: true,
      },
    ];
  }

  function normalizeSkill(raw, makeId) {
    const name = String((raw && raw.name) || "").trim();
    const instructions = String((raw && raw.instructions) || "").trim();
    if (!name || !instructions) return null;
    return {
      id: (raw && raw.id) || makeId(),
      name,
      description: String((raw && raw.description) || "").trim(),
      instructions,
      origin: String((raw && raw.origin) || "").trim(),
      builtin: !!(raw && raw.builtin),
    };
  }

  function upsertSkill(list, skill) {
    const out = (Array.isArray(list) ? list : []).slice();
    const i = out.findIndex((s) => s.id === skill.id);
    if (i >= 0) out[i] = skill;
    else out.push(skill);
    return out;
  }

  function removeSkill(list, id) {
    return (Array.isArray(list) ? list : []).filter((s) => s.id !== id);
  }

  /** The exact block an active skill adds to the system prompt. */
  function skillPromptBlock(skill) {
    if (!skill) return "";
    return `\n\nActive skill — "${skill.name}":\n${skill.instructions}\n(Follow the skill's instructions for this task. Tool approval rules are unchanged: writes still ask first.)`;
  }

  // ---------------- API Vault (pure helpers) ----------------
  // The vault persists API definitions (endpoint sets per origin) and,
  // optionally, one API key per origin. SECURITY INVARIANTS (tested):
  //  - keys live only in the vault object (chrome.storage.local, on-device);
  //  - exports NEVER contain key values or attached headers (redactTool);
  //  - a key is attached to a tool only transiently, at execution time,
  //    by attachVaultKey — stored/registry tools never carry it.

  function emptyVault() {
    return { defs: [], keys: [] };
  }

  function originOf(url) {
    try { return new URL(String(url || "")).origin; } catch { return ""; }
  }

  function normalizeVault(raw) {
    const v = raw && typeof raw === "object" ? raw : {};
    return {
      defs: (Array.isArray(v.defs) ? v.defs : []).filter((d) => d && d.id && d.origin && Array.isArray(d.tools)),
      keys: (Array.isArray(v.keys) ? v.keys : []).filter((k) => k && k.id && k.origin && k.value),
    };
  }

  function upsertVaultDef(vault, def) {
    const v = normalizeVault(vault);
    const i = v.defs.findIndex((d) => d.id === def.id);
    if (i >= 0) v.defs[i] = def;
    else v.defs.push(def);
    return v;
  }

  function removeVaultDef(vault, id) {
    const v = normalizeVault(vault);
    v.defs = v.defs.filter((d) => d.id !== id);
    return v;
  }

  function upsertVaultKey(vault, key) {
    const v = normalizeVault(vault);
    // one key per origin: a new key for an origin replaces the old one
    v.keys = v.keys.filter((k) => originOf(k.origin) !== originOf(key.origin));
    v.keys.push(key);
    return v;
  }

  function removeVaultKey(vault, id) {
    const v = normalizeVault(vault);
    v.keys = v.keys.filter((k) => k.id !== id);
    return v;
  }

  function clearVaultKeys(vault) {
    const v = normalizeVault(vault);
    v.keys = [];
    return v;
  }

  /** The key entry for an origin (exact origin match after normalization). */
  function vaultKeyForOrigin(vault, origin) {
    const v = normalizeVault(vault);
    const target = originOf(origin);
    if (!target || target === "null") return null;
    return v.keys.find((k) => originOf(k.origin) === target) || null;
  }

  /** UI mask: never render a full key. Shows the last 4 only. */
  function maskKeyValue(value) {
    const s = String(value || "");
    if (!s) return "";
    return "••••" + s.slice(-4);
  }

  /**
   * Return a THROWAWAY copy of a tool with the vault key attached as a
   * header, for execution inside the user's tab. The input tool (the one
   * in the registry / shown to the model) is never mutated.
   */
  function attachVaultKey(tool, keyEntry) {
    if (!tool || !keyEntry || !keyEntry.value) return tool;
    const headerName = String(keyEntry.headerName || "Authorization").trim() || "Authorization";
    return {
      ...tool,
      action: {
        ...(tool.action || {}),
        headers: { ...((tool.action && tool.action.headers) || {}), [headerName]: keyEntry.value },
      },
    };
  }

  /** Strip anything credential-shaped from a tool before export. */
  function redactTool(tool) {
    if (!tool || !tool.action) return tool;
    const action = { ...tool.action };
    delete action.headers;
    return { ...tool, action };
  }

  /** Parse manual endpoint lines: "GET /invoices — list invoices". */
  function toolsFromEndpointLines(origin, text) {
    const out = [];
    const used = new Set();
    for (const rawLine of String(text || "").split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = line.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/\S*)(?:\s*[—–-]{1,2}\s*(.+))?$/i);
      if (!m) continue;
      const method = m[1].toUpperCase();
      const path = m[2];
      const name = uniqName(slugify(`${method}_${path}`, "api_call"), used);
      out.push({
        id: name,
        name,
        description: (m[3] || `${method} ${path}`).trim(),
        inputSchema: { type: "object", properties: method === "GET" || method === "HEAD" ? {} : { body: { type: "object", description: "JSON request body." } } },
        risk: method === "GET" || method === "HEAD" ? "read" : "write",
        source: "api",
        action: { kind: "api", method, path, origin },
      });
    }
    return out;
  }

  // ---------------- Site scanner (pure helpers) ----------------

  /**
   * Turn a raw page scan into display rows. raw comes from the content
   * script; apiToolCount is what the panel knows for the origin.
   */
  function summarizeScan(raw, apiToolCount = 0) {
    const s = raw || {};
    const inv = s.inventory || {};
    const flags = [];
    if (inv.passwordFields > 0) flags.push(`${inv.passwordFields} password field${inv.passwordFields === 1 ? "" : "s"} on this page`);
    if (inv.paymentLikely) flags.push("A form on this page looks like a payment form");
    if (inv.fileInputs > 0) flags.push(`${inv.fileInputs} file upload input${inv.fileInputs === 1 ? "" : "s"}`);
    return {
      url: s.url || "",
      title: s.title || "",
      nativeTools: s.nativeTools || [],
      synthesizedCount: s.synthesizedCount || 0,
      apiToolCount,
      inventory: {
        forms: inv.forms || 0,
        fields: inv.fields || 0,
        tables: inv.tables || 0,
        buttons: inv.buttons || 0,
        links: inv.links || 0,
        headings: inv.headings || 0,
      },
      flags,
    };
  }

  function riskSummary(tools) {
    const reads = (tools || []).filter((t) => t.risk === "read").length;
    return { total: (tools || []).length, reads, writes: (tools || []).length - reads };
  }

  // ---------------- Takeover mode (pure helpers) ----------------
  // The Robot Orchestra pause/takeover pattern, in the browser: the user can
  // seize the target tab at any moment (manual), a deterministic page-signal
  // detector can ask for their hands (login / CAPTCHA / payment / OTP), and
  // the model itself can ask via the request_takeover tool. While a tab is
  // taken over, NOTHING executes on it — every caller (panel chat, MCP
  // bridge) is refused by the same gate (toolAllowedDuringTakeover).
  // State is per-tab; the service worker owns the map, these helpers are the
  // transitions. All pure and unit-tested.

  const TAKEOVER_TOOL_NAME = "request_takeover";

  /**
   * The pseudo-tool the panel adds to the model's tool list (it is NOT a
   * page tool: page synthesis never produces it, the bridge never lists it,
   * and it can never be executed — the panel intercepts calls to it and
   * turns them into a takeover request). Read-class because it changes
   * nothing on the page; the panel still shows the user a card.
   */
  const TAKEOVER_REQUEST_TOOL = {
    id: TAKEOVER_TOOL_NAME,
    name: TAKEOVER_TOOL_NAME,
    description: "Ask the user to take control of this tab for a step you must not do alone: signing in or typing a password, entering a one-time / 2FA code, solving a CAPTCHA, or entering payment card details. The agent pauses until the user hands control back. Give a short, plain-language reason.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "Short reason the user is needed, in plain language." } },
      required: ["reason"],
    },
    risk: "read",
    source: "conductor",
    action: { kind: "takeover-request" },
  };

  /** Canonical idle state: no takeover on a tab. */
  function emptyTakeoverState() {
    return { active: false, source: "", reason: "", since: 0, url: "", title: "" };
  }

  /** Coerce anything stored/passed around into a valid takeover state. */
  function normalizeTakeoverState(raw) {
    if (!raw || typeof raw !== "object") return emptyTakeoverState();
    return {
      active: raw.active === true,
      source: typeof raw.source === "string" ? raw.source : "",
      reason: typeof raw.reason === "string" ? raw.reason : "",
      since: typeof raw.since === "number" ? raw.since : 0,
      url: typeof raw.url === "string" ? raw.url : "",
      title: typeof raw.title === "string" ? raw.title : "",
    };
  }

  /** Transition: begin a takeover. opts: { source, reason, at, url, title }. */
  function startTakeoverState(opts) {
    const o = opts || {};
    return {
      active: true,
      source: o.source || "manual",
      reason: o.reason || "",
      since: typeof o.at === "number" ? o.at : 0,
      url: o.url || "",
      title: o.title || "",
    };
  }

  /** Transition: end a takeover (back to the idle state). */
  function endTakeoverState() {
    return emptyTakeoverState();
  }

  /** Read a tab's state from a Map or a plain object keyed by tabId. */
  function takeoverForTab(map, tabId) {
    if (map == null || tabId == null) return emptyTakeoverState();
    const raw = map instanceof Map ? map.get(tabId) : map[tabId];
    return normalizeTakeoverState(raw);
  }

  /** Return the collection with a tab's state set (Map mutated, object copied). */
  function withTakeoverForTab(map, tabId, state) {
    const value = normalizeTakeoverState(state);
    if (map instanceof Map) { map.set(tabId, value); return map; }
    return { ...(map || {}), [tabId]: value };
  }

  /** Return the collection with a tab's state removed (tab closed / ended). */
  function withoutTakeoverForTab(map, tabId) {
    if (map instanceof Map) { map.delete(tabId); return map; }
    const out = { ...(map || {}) };
    delete out[tabId];
    return out;
  }

  /**
   * THE execution gate. While a takeover is active on a tab, every tool
   * execution on that tab is refused — reads and writes alike. The reason
   * string is shown to the user (step card) and to the model (tool result),
   * and the refusal is written to the activity log by the caller.
   */
  function toolAllowedDuringTakeover(state) {
    if (state && state.active === true) {
      return {
        allowed: false,
        reason: "Refused: you have taken control of this tab, so Conductor is paused and cannot run any tools on it until you hand control back.",
      };
    }
    return { allowed: true, reason: "" };
  }

  /**
   * Turn deterministic page signals (computed by the content script from
   * the live DOM) into a takeover verdict. Priority is deliberate —
   * payment > captcha > otp > login — and every hit is returned so the UI
   * can be honest about everything found. Detection is heuristic by
   * nature: it will miss obfuscated widgets and unusual markup. The
   * manual Take over button is the guarantee; this is the safety net.
   * signals: { login, captcha, payment, otp } booleans.
   */
  function detectTakeoverNeed(signals) {
    const s = signals || {};
    const hits = [];
    if (s.payment) hits.push({ kind: "payment", reason: "This page is asking for payment card details. Card numbers are a step you should do with your own hands — Conductor will never type them." });
    if (s.captcha) hits.push({ kind: "captcha", reason: "This page shows a human-verification challenge (CAPTCHA). Only you can complete it — Conductor won't touch it." });
    if (s.otp) hits.push({ kind: "otp", reason: "This page is asking for a one-time verification code (2FA). That code is meant for you only — the agent should never see it or type it." });
    if (s.login) hits.push({ kind: "login", reason: "This page has a sign-in form with a password field. Passwords get typed by you, never by the agent." });
    if (!hits.length) return { needed: false, kind: "", reason: "", hits: [] };
    return { needed: true, kind: hits[0].kind, reason: hits[0].reason, hits };
  }

  /**
   * The hand-back note: compare the page as it was when the user took
   * over with the fresh snapshot after they hand back. URL and title are
   * the minimum visible change set.
   */
  function handbackSummary(before, after) {
    const b = before || {};
    const a = after || {};
    if (!b.url && !b.title) return "Conductor re-read the page from a fresh snapshot.";
    const changes = [];
    if ((a.url || "") !== (b.url || "")) changes.push(`the page moved to ${a.url || "(unknown URL)"}`);
    if ((a.title || "") !== (b.title || "")) changes.push(`the title is now “${a.title || "(untitled)"}”`);
    if (!changes.length) return "The page looks unchanged since you took over (same URL and title).";
    return `While you drove, ${changes.join(" and ")}.`;
  }

  /** OpenAI-style function-calling format (what OpenRouter expects). */
  function toolsToOpenAi(tools) {
    return (tools || []).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: "object", properties: {} } },
    }));
  }

  /** MCP tools/list export. */
  function toolsToMcpExport(tools, page) {
    return {
      conductor: {
        kind: "conductor-page-tools",
        version: 1,
        page: page || null,
        note: "Tools discovered/synthesized by Conductor for this page. Risk: read = no side effects expected; write = can change state and requires user approval in Conductor.",
      },
      tools: (tools || []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema || { type: "object", properties: {} },
        annotations: { readOnlyHint: t.risk === "read", source: t.source },
      })),
    };
  }

  // ---------------- Session Journal (v1.4 — Flight Recorder module) ----
  // Tamper-evident, hash-chained record of agent + tab activity, built for
  // Conductor from the Agent Flight Recorder design. Synchronous SHA-256
  // (lib.js must stay sync/UMD for panel + worker + Node tests).

  function sha256Hex(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const bytes = unescape(encodeURIComponent(ascii));
    const bitLen = bytes.length * 8;
    let padded = bytes + "\x80";
    while (padded.length % 64 !== 56) padded += "\x00";
    for (let i = 7; i >= 0; i--) padded += String.fromCharCode(Math.floor(bitLen / Math.pow(2, i * 8)) & 0xff);
    const w = new Array(64);
    for (let block = 0; block < padded.length; block += 64) {
      for (let t = 0; t < 16; t++) {
        const o = block + t * 4;
        w[t] = (padded.charCodeAt(o) << 24) | (padded.charCodeAt(o + 1) << 16) | (padded.charCodeAt(o + 2) << 8) | padded.charCodeAt(o + 3);
      }
      for (let t = 16; t < 64; t++) {
        const s0 = rr(w[t - 15], 7) ^ rr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rr(w[t - 2], 17) ^ rr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
      for (let t = 0; t < 64; t++) {
        const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[t] + w[t]) | 0;
        const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
  }

  const JOURNAL_GENESIS = "GENESIS";
  function journalCanonical(e) {
    return JSON.stringify({ seq: e.seq, ts: e.ts, type: e.type, text: e.text, meta: e.meta || {}, prev: e.prev });
  }
  function journalAppend(chain, { type, text, meta, ts }) {
    const list = Array.isArray(chain) ? chain : [];
    const entry = {
      seq: list.length,
      ts: ts || new Date().toISOString(),
      type: String(type || "note"),
      text: String(text || ""),
      meta: meta || {},
      prev: list.length ? list[list.length - 1].hash : JOURNAL_GENESIS,
      hash: "",
    };
    entry.hash = sha256Hex(journalCanonical(entry));
    list.push(entry);
    return entry;
  }
  function journalVerify(chain) {
    if (!Array.isArray(chain)) return { ok: false, at: 0, why: "not an array" };
    let prev = JOURNAL_GENESIS;
    for (let i = 0; i < chain.length; i++) {
      const e = chain[i];
      if (e.seq !== i) return { ok: false, at: i, why: "sequence gap" };
      if (e.prev !== prev) return { ok: false, at: i, why: "prev link broken" };
      if (sha256Hex(journalCanonical(e)) !== e.hash) return { ok: false, at: i, why: "hash mismatch" };
      prev = e.hash;
    }
    return { ok: true, entries: chain.length, head: prev };
  }

  // Restore planner (Flight Recorder semantics): URL-multiset matching so
  // it survives browser restarts — tabs are matched by URL, not by id.
  // Internal pages (chrome://, extension pages) are never closed/reopened.
  function planRestore(snapshotTabs, currentTabs) {
    const internal = (u) => !u || /^(chrome|about|edge|brave|view-source|chrome-extension):/.test(u);
    const count = (tabs) => {
      const m = new Map();
      for (const t of tabs || []) if (!internal(t.url)) m.set(t.url, (m.get(t.url) || 0) + 1);
      return m;
    };
    const snapCount = count(snapshotTabs);
    const curCount = count(currentTabs);
    const closeIds = [];
    const seen = new Map();
    for (const t of currentTabs || []) {
      if (internal(t.url) || typeof t.id !== "number") continue;
      const n = (seen.get(t.url) || 0) + 1;
      seen.set(t.url, n);
      if (n > (snapCount.get(t.url) || 0)) closeIds.push(t.id);
    }
    const snapPinned = new Map();
    for (const t of snapshotTabs || []) if (!internal(t.url) && !snapPinned.has(t.url)) snapPinned.set(t.url, !!t.pinned);
    const open = [];
    for (const [url, n] of snapCount) {
      const missing = n - (curCount.get(url) || 0);
      for (let i = 0; i < missing; i++) open.push({ url, pinned: snapPinned.get(url) || false });
    }
    return { closeIds, open };
  }

  // ---------------- Wallet guard (v1.6) ----------------
  // Agent Wallet's policy engine, adapted from crypto sends to browser
  // actions: hard caps, an approval line, an origin allowlist, a kill
  // switch, and a spend ledger. The guard never moves money itself — it
  // decides whether a proposed money action may proceed to the normal
  // approval flow, needs the human with context, or is refused outright.

  const WALLET_DEFAULT_POLICY = {
    enabled: true,
    perTxCapUsd: 25,
    dailyCapUsd: 100,
    approvalAboveUsd: 5,
    allowlistOnly: false,
    allowlist: [], // origins, lowercase-compared
    killed: false,
  };
  function walletNormalizePolicy(p) {
    const d = WALLET_DEFAULT_POLICY;
    const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
    return {
      enabled: p && p.enabled !== undefined ? !!p.enabled : d.enabled,
      perTxCapUsd: num(p && p.perTxCapUsd, d.perTxCapUsd),
      dailyCapUsd: num(p && p.dailyCapUsd, d.dailyCapUsd),
      approvalAboveUsd: num(p && p.approvalAboveUsd, d.approvalAboveUsd),
      allowlistOnly: !!(p && p.allowlistOnly),
      allowlist: Array.isArray(p && p.allowlist) ? p.allowlist.map((s) => String(s).toLowerCase()) : [],
      killed: !!(p && p.killed),
    };
  }
  function walletDayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function walletSpentOnDay(ledger, now = Date.now()) {
    return (ledger || [])
      .filter((e) => e.status === "sent" && walletDayKey(e.ts) === walletDayKey(now))
      .reduce((sum, e) => sum + (Number(e.amountUsd) || 0), 0);
  }

  const WALLET_MONEY_PATH = /(checkout|payment|pay|purchase|order|subscribe|billing|charge|donate|cart)/i;
  const WALLET_MONEY_VERB = /\b(pay|buy|checkout|purchase|subscribe|order|donate|tip|book now|confirm order|place order)\b/i;
  function walletExtractAmount(tool, args) {
    const keyHit = (obj, depth) => {
      if (!obj || typeof obj !== "object" || depth > 3) return null;
      for (const [k, v] of Object.entries(obj)) {
        if (/^(amount|total|price|cost|sum|grand_total|subtotal)$/i.test(k)) {
          const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, ""));
          if (Number.isFinite(n) && n > 0) return n;
        }
      }
      for (const v of Object.values(obj)) {
        const hit = keyHit(v, depth + 1);
        if (hit != null) return hit;
      }
      return null;
    };
    const fromKeys = keyHit(args || {}, 0);
    if (fromKeys != null) return fromKeys;
    const text = `${(tool && tool.name) || ""} ${(tool && tool.description) || ""} ${JSON.stringify(args || {})}`;
    const m = text.match(/\$\s?(\d[\d,]*(?:\.\d{2})?)/) || text.match(/(\d[\d,]*(?:\.\d{2})?)\s?(?:USD|dollars)\b/i);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }
  /** Is this tool call a money action, and for how much (null = unknown)? */
  function walletAssess(tool, args, pageUrl) {
    if (!tool) return { isMoney: false };
    let origin = "";
    try { origin = new URL((tool.action && tool.action.origin) || pageUrl || "").origin; } catch { /* keep "" */ }
    let isMoney = false;
    if (tool.action && tool.action.kind === "api") {
      const m = String(tool.action.method || "GET").toUpperCase();
      if (m !== "GET" && m !== "HEAD" && WALLET_MONEY_PATH.test(tool.action.path || "")) isMoney = true;
    }
    if (!isMoney && tool.risk === "write") {
      const text = `${tool.name || ""} ${tool.description || ""} ${JSON.stringify(args || {})}`;
      if (WALLET_MONEY_VERB.test(text)) isMoney = true;
    }
    if (!isMoney) return { isMoney: false };
    return { isMoney: true, amountUsd: walletExtractAmount(tool, args), origin, payee: origin };
  }
  /** decision: 'off' | 'auto' | 'approval' | 'denied' (Agent Wallet semantics). */
  function walletEvaluate(policy, ledger, spend, now = Date.now()) {
    const p = walletNormalizePolicy(policy);
    if (!p.enabled) return { decision: "off", reasons: ["Wallet guard is off."] };
    const reasons = [];
    const amount = spend && spend.amountUsd != null ? Number(spend.amountUsd) : null;
    if (p.killed) return { decision: "denied", reasons: ["Kill switch is ON — all spending is frozen."] };
    if (amount != null && !(amount > 0)) return { decision: "denied", reasons: ["Amount must be greater than zero."] };
    if (amount != null && amount > p.perTxCapUsd) {
      return { decision: "denied", reasons: [`$${amount.toFixed(2)} exceeds the per-action cap of $${p.perTxCapUsd.toFixed(2)}.`] };
    }
    const spent = walletSpentOnDay(ledger, now);
    if (amount != null && spent + amount > p.dailyCapUsd) {
      return { decision: "denied", reasons: [`Would exceed the daily cap: $${spent.toFixed(2)} already spent today of $${p.dailyCapUsd.toFixed(2)}.`] };
    }
    const listed = (spend && spend.payee) ? p.allowlist.includes(String(spend.payee).toLowerCase()) : false;
    if (p.allowlistOnly && !listed) {
      return { decision: "denied", reasons: ["This site is not on the allowlist, and allowlist-only mode is on."] };
    }
    let needsApproval = false;
    if (amount == null) {
      needsApproval = true;
      reasons.push("The amount couldn't be read from the page — approval required.");
    } else if (amount >= p.approvalAboveUsd) {
      needsApproval = true;
      reasons.push(`$${amount.toFixed(2)} is at/above the $${p.approvalAboveUsd.toFixed(2)} approval line.`);
    }
    if (p.allowlist.length && !listed && spend && spend.payee) {
      needsApproval = true;
      reasons.push("First-time site (not on the allowlist) — approval required.");
    }
    return needsApproval ? { decision: "approval", reasons } : { decision: "auto", reasons };
  }

  // ---------------- API Lens module (v1.5) ----------------
  // Endpoint discovery ported from API Lens core (MIT, Kevin's own project):
  // recorded page calls -> templated endpoints -> inferred schemas -> an
  // OpenAPI spec -> callable tools via toolsFromOpenApi. Secrets are
  // redacted by default; only shapes and non-sensitive examples are kept.

  function lensStableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return "[" + value.map(lensStableStringify).join(",") + "]";
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + lensStableStringify(value[k])).join(",") + "}";
  }

  const LENS_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const LENS_HEX_RE = /^[0-9a-f]{16,}$/i;
  const LENS_DIGITS_RE = /^\d+$/;
  const LENS_TOKEN_RE = /^[A-Za-z0-9_-]{22,}$/;
  function lensClassifySegment(seg) {
    if (LENS_UUID_RE.test(seg)) return "uuid";
    if (LENS_DIGITS_RE.test(seg)) return "id";
    if (LENS_HEX_RE.test(seg)) return "hash";
    if (LENS_TOKEN_RE.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return "token";
    return null;
  }
  function lensTemplateUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return { template: rawUrl, params: [], origin: "", path: rawUrl }; }
    const counts = {};
    const params = [];
    const segs = u.pathname.split("/").map((seg) => {
      if (!seg) return seg;
      let decoded = seg;
      try { decoded = decodeURIComponent(seg); } catch { /* keep raw */ }
      const kind = lensClassifySegment(decoded);
      if (!kind) return seg;
      counts[kind] = (counts[kind] || 0) + 1;
      const name = counts[kind] === 1 ? kind : `${kind}_${counts[kind]}`;
      params.push({ name, kind, example: decoded });
      return `{${name}}`;
    });
    return { template: segs.join("/") || "/", params, origin: u.origin, path: u.pathname };
  }
  function lensQueryParamsOf(rawUrl) {
    try {
      const u = new URL(rawUrl);
      const out = {};
      for (const [k, v] of u.searchParams.entries()) {
        if (out[k] === undefined) out[k] = v;
        else if (Array.isArray(out[k])) out[k].push(v);
        else out[k] = [out[k], v];
      }
      return out;
    } catch { return {}; }
  }

  function lensInferSchema(value) {
    if (value === null) return { type: "null" };
    if (Array.isArray(value)) {
      if (value.length === 0) return { type: "array", items: {} };
      let items = lensInferSchema(value[0]);
      for (let i = 1; i < value.length; i++) items = lensMergeSchemas(items, lensInferSchema(value[i]));
      return { type: "array", items };
    }
    switch (typeof value) {
      case "string": return { type: "string" };
      case "number": return { type: Number.isInteger(value) ? "integer" : "number" };
      case "boolean": return { type: "boolean" };
      case "object": {
        const properties = {};
        for (const [k, v] of Object.entries(value)) properties[k] = lensInferSchema(v);
        const counts = {};
        for (const k of Object.keys(properties)) counts[k] = 1;
        return { type: "object", properties, _counts: counts, _n: 1 };
      }
      default: return {};
    }
  }
  function lensMergeSchemas(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (lensStableStringify(a) === lensStableStringify(b)) return a;
    const ta = a.type, tb = b.type;
    if (ta === "integer" && tb === "number") return { type: "number" };
    if (ta === "number" && tb === "integer") return { type: "number" };
    if (ta === "object" && tb === "object") {
      const properties = { ...(a.properties || {}) };
      const counts = { ...(a._counts || {}) };
      for (const [k, v] of Object.entries(b.properties || {})) {
        if (properties[k]) {
          properties[k] = lensMergeSchemas(properties[k], v);
          counts[k] = (counts[k] || 0) + ((b._counts || {})[k] || 0);
        } else {
          properties[k] = v;
          counts[k] = (b._counts || {})[k] || 0;
        }
      }
      return { type: "object", properties, _counts: counts, _n: (a._n || 1) + (b._n || 1) };
    }
    if (ta === "array" && tb === "array") {
      return { type: "array", items: lensMergeSchemas(a.items || {}, b.items || {}) };
    }
    const options = [];
    const push = (s) => {
      if (s && s.type === undefined && s.anyOf) options.push(...s.anyOf);
      else if (s) options.push(s);
    };
    push(a); push(b);
    const seen = new Set();
    const deduped = options.filter((s) => {
      const k = lensStableStringify(s);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (deduped.length === 1) return deduped[0];
    return { anyOf: deduped };
  }
  function lensFinalizeSchema(schema) {
    if (!schema || typeof schema !== "object") return schema || {};
    if (schema.anyOf) return { anyOf: schema.anyOf.map(lensFinalizeSchema) };
    const out = {};
    if (schema.type) out.type = schema.type;
    if (schema.type === "object") {
      out.properties = {};
      const counts = schema._counts || {};
      const n = schema._n || 1;
      const required = [];
      for (const [k, v] of Object.entries(schema.properties || {})) {
        out.properties[k] = lensFinalizeSchema(v);
        if ((counts[k] || 0) >= n) required.push(k);
      }
      if (required.length) out.required = required.sort();
    }
    if (schema.type === "array") out.items = lensFinalizeSchema(schema.items || {});
    return out;
  }
  function lensInferJsonSchema(values) {
    const list = (values || []).filter((v) => v !== undefined);
    if (!list.length) return null;
    let s = lensInferSchema(list[0]);
    for (let i = 1; i < list.length; i++) s = lensMergeSchemas(s, lensInferSchema(list[i]));
    return lensFinalizeSchema(s);
  }

  const LENS_SENSITIVE_HEADERS = [
    "authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token",
    "x-session-id", "proxy-authorization", "x-csrf-token", "x-xsrf-token",
  ];
  const LENS_SENSITIVE_BODY_KEYS = /^(password|passwd|pwd|secret|token|access_token|refresh_token|api_key|apikey|auth|ssn|credit_card|card_number|cvv)$/i;
  const LENS_REDACTED = "•••redacted•••";
  function lensRedactHeaders(headers, keepSecrets = false) {
    if (!headers || keepSecrets) return headers || {};
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = LENS_SENSITIVE_HEADERS.includes(k.toLowerCase()) ? LENS_REDACTED : v;
    }
    return out;
  }
  function lensRedactBody(value, keepSecrets = false) {
    if (keepSecrets || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => lensRedactBody(v, keepSecrets));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = LENS_SENSITIVE_BODY_KEYS.test(k) ? LENS_REDACTED : lensRedactBody(v, keepSecrets);
    }
    return out;
  }
  function lensDetectAuth(headers) {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = v;
    if (h["authorization"]) {
      if (String(h["authorization"]).toLowerCase().startsWith("bearer")) return { type: "bearer", header: "Authorization" };
      if (String(h["authorization"]).toLowerCase().startsWith("basic")) return { type: "basic", header: "Authorization" };
      return { type: "header", header: "Authorization" };
    }
    for (const name of ["x-api-key", "x-auth-token"]) {
      if (h[name]) return { type: "apiKey", header: name };
    }
    if (h["cookie"]) return { type: "cookie", header: "Cookie" };
    return null;
  }

  function lensEndpointKey(entry) {
    const { template, origin } = lensTemplateUrl(entry.url);
    return `${String(entry.method || "GET").toUpperCase()} ${origin}${template}`;
  }
  function lensGroupEndpoints(entries) {
    const groups = new Map();
    for (const e of entries || []) {
      const key = lensEndpointKey(e);
      if (!groups.has(key)) {
        const { template, origin, params } = lensTemplateUrl(e.url);
        groups.set(key, {
          key, method: String(e.method || "GET").toUpperCase(), origin, template,
          pathParams: params, calls: [], statuses: {}, queryParams: new Map(), auth: null,
        });
      }
      const g = groups.get(key);
      g.calls.push(e);
      g.statuses[e.status] = (g.statuses[e.status] || 0) + 1;
      if (!g.auth) g.auth = lensDetectAuth(e.requestHeaders);
      for (const [k, v] of Object.entries(lensQueryParamsOf(e.url))) {
        if (!g.queryParams.has(k)) g.queryParams.set(k, { values: [], count: 0 });
        const rec = g.queryParams.get(k);
        rec.values.push(v);
        rec.count++;
      }
    }
    const result = [];
    for (const g of groups.values()) {
      const n = g.calls.length;
      const query = {};
      for (const [k, rec] of g.queryParams.entries()) {
        query[k] = {
          schema: lensInferJsonSchema(rec.values.flatMap((v) => (Array.isArray(v) ? v : [v]))) || { type: "string" },
          required: rec.count >= n,
          examples: [...new Set(rec.values.flatMap((v) => (Array.isArray(v) ? v : [v])))].slice(0, 3),
        };
      }
      result.push({
        key: g.key, method: g.method, origin: g.origin, template: g.template,
        pathParams: g.pathParams, callCount: n, statuses: g.statuses, auth: g.auth, query,
        requestSchema: lensInferJsonSchema(g.calls.map((c) => c.requestBody).filter((v) => v !== null && v !== undefined)),
        responseSchema: lensInferJsonSchema(g.calls.map((c) => c.responseBody).filter((v) => v !== null && v !== undefined && typeof v === "object")),
        examples: g.calls.slice(0, 3).map((c) => c.id),
        firstSeen: Math.min(...g.calls.map((c) => c.ts)),
        lastSeen: Math.max(...g.calls.map((c) => c.ts)),
      });
    }
    return result.sort((a, b) => b.callCount - a.callCount || a.key.localeCompare(b.key));
  }

  /** Grouped endpoints -> minimal OpenAPI 3 doc that toolsFromOpenApi eats. */
  function lensEndpointsToOpenApi(endpoints, title) {
    const paths = {};
    let origin = "";
    for (const ep of endpoints || []) {
      origin = origin || ep.origin || "";
      const parameters = [];
      for (const p of ep.pathParams || []) {
        parameters.push({ name: p.name, in: "path", required: true, schema: { type: "string" } });
      }
      for (const [name, q] of Object.entries(ep.query || {})) {
        parameters.push({ name, in: "query", required: !!q.required, schema: q.schema || { type: "string" } });
      }
      const op = {
        summary: `${ep.method} ${ep.template} — seen ${ep.callCount}× via Lens`,
        operationId: `${ep.method.toLowerCase()}_${ep.template.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`,
        parameters,
        responses: { "200": { description: "Observed response" } },
      };
      if (ep.requestSchema) {
        op.requestBody = { content: { "application/json": { schema: ep.requestSchema } } };
      }
      paths[ep.template] = paths[ep.template] || {};
      paths[ep.template][ep.method.toLowerCase()] = op;
    }
    return {
      openapi: "3.1.0",
      info: { title: title || "Lens capture", version: "1.0.0" },
      servers: origin ? [{ url: origin }] : [],
      paths,
    };
  }

  return {
    slugify,
    buildToolsFromSnapshot,
    wrapNativeTools,
    toolsFromOpenApi,
    mergeTools,
    riskSummary,
    toolsToOpenAi,
    toolsToMcpExport,
    OLLAMA_URL,
    OPENROUTER_URL,
    RECOMMENDED_LOCAL_MODEL,
    isToolCapableModel,
    parseOllamaTags,
    resolveRoute,
    buildChatRequest,
    routeBadgeText,
    MODEL_PRICES,
    PRICE_TABLE_DATE,
    modelPrice,
    extractUsage,
    callCostUsd,
    emptyUsageStore,
    recordUsage,
    usageWindow,
    usageDayKey,
    formatTokens,
    formatUsd,
    appendActivity,
    seedSkills,
    normalizeSkill,
    upsertSkill,
    removeSkill,
    skillPromptBlock,
    summarizeScan,
    emptyVault,
    originOf,
    normalizeVault,
    upsertVaultDef,
    removeVaultDef,
    upsertVaultKey,
    removeVaultKey,
    clearVaultKeys,
    vaultKeyForOrigin,
    maskKeyValue,
    attachVaultKey,
    redactTool,
    toolsFromEndpointLines,
    TAKEOVER_TOOL_NAME,
    TAKEOVER_REQUEST_TOOL,
    emptyTakeoverState,
    normalizeTakeoverState,
    startTakeoverState,
    endTakeoverState,
    takeoverForTab,
    withTakeoverForTab,
    withoutTakeoverForTab,
    toolAllowedDuringTakeover,
    detectTakeoverNeed,
    handbackSummary,
    sha256Hex,
    journalAppend,
    journalVerify,
    journalCanonical,
    planRestore,
    lensTemplateUrl,
    lensGroupEndpoints,
    lensEndpointsToOpenApi,
    lensRedactHeaders,
    lensRedactBody,
    lensDetectAuth,
    lensInferJsonSchema,
    walletNormalizePolicy,
    walletSpentOnDay,
    walletAssess,
    walletEvaluate,
    WALLET_DEFAULT_POLICY,
  };
});
