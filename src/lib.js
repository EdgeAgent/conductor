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
  };
});
