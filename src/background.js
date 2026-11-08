// Conductor service worker — per-tab tool registry, badge, and the MCP
// bridge client. The side panel owns the chat + approval gates; this worker
// is the pipe between the panel, the page, and the local bridge.
importScripts("lib.js");
const Lib = self.ConductorLib;

const API_TOOLS_KEY = "conductor_api_tools_v1";
const SETTINGS_KEY = "conductor_settings_v1";

const tabTools = new Map(); // tabId -> { tools, url, title, updatedAt }
const lensRecordingByTab = new Map(); // tabId -> bool (v1.5 Lens recording intent; survives page reloads)

// Takeover state, per tab (Lib takeover-state shape). The worker owns this
// map: the panel mirrors the current target tab's entry via TAKEOVER_GET /
// TAKEOVER_CHANGED, tab switches read their own entry (no leakage), and a
// closed tab's entry is dropped in tabs.onRemoved below. While a tab's
// entry is active, EXECUTE_TOOL and bridge calls on that tab are refused.
let tabTakeover = {}; // tabId -> takeover state
const getTakeover = (tabId) => Lib.takeoverForTab(tabTakeover, tabId);

const fetchingTabs = new Set(); // coalesce concurrent tool fetches per tab
async function fetchToolsFromPage(tabId) {
  if (fetchingTabs.has(tabId)) {
    const cached = tabTools.get(tabId);
    if (cached) return cached;
  }
  fetchingTabs.add(tabId);
  try {
    return await fetchToolsFromPageInner(tabId);
  } finally {
    fetchingTabs.delete(tabId);
  }
}

async function fetchToolsFromPageInner(tabId) {
  const res = await chrome.tabs.sendMessage(tabId, { type: "GET_TOOLS" });
  if (!res || !res.ok) throw new Error((res && res.error) || "Page did not answer. Reload the tab and try again.");
  let apiTools = [];
  try {
    const origin = new URL(res.url).origin;
    const stored = await chrome.storage.local.get(API_TOOLS_KEY);
    apiTools = (stored[API_TOOLS_KEY] || {})[origin] || [];
  } catch { /* non-http pages */ }
  const tools = Lib.mergeTools(res.tools, apiTools);
  const entry = { tools, url: res.url, title: res.title, updatedAt: Date.now() };
  tabTools.set(tabId, entry);
  updateBadge(tabId);
  return entry;
}

async function updateBadge(tabId) {
  const entry = tabTools.get(tabId);
  try {
    if (!entry || !entry.tools.length) {
      await chrome.action.setBadgeText({ tabId, text: "" });
      await chrome.action.setTitle({ tabId, title: "Conductor" });
      return;
    }
    await chrome.action.setBadgeText({ tabId, text: String(entry.tools.length) });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0f766e" });
    await chrome.action.setTitle({ tabId, title: `Conductor — ${entry.tools.length} tools on this page` });
  } catch { /* tab gone */ }
}

// ---------------- Local-first model routing (Ollama / OpenRouter) ----------------
// The worker executes chat rounds so the route policy lives in exactly one
// place. Kevin's hard rule: page data reaches OpenRouter ONLY when the
// resolved route is cloud (the user configured a key / chose cloud) or when
// the panel passes an explicit per-task cloud consent flag. A failed local
// route is an error the panel surfaces — never a silent cloud retry.

let ollamaCache = { at: 0, status: { detected: false, models: [] } };

async function detectOllama(force = false) {
  if (!force && Date.now() - ollamaCache.at < 10000) return ollamaCache.status;
  let status = { detected: false, models: [] };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`${Lib.OLLAMA_URL}/api/tags`, { signal: ctl.signal });
    clearTimeout(timer);
    if (res.ok) status = { detected: true, models: Lib.parseOllamaTags(await res.json()) };
  } catch { /* Ollama not running — that's a normal state */ }
  ollamaCache = { at: Date.now(), status };
  return status;
}

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return data[SETTINGS_KEY] || {};
}

const modelCalls = new Map(); // callId -> AbortController

async function fetchChat(req) {
  const ctl = new AbortController();
  return { ctl, promise: fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: ctl.signal }) };
}

async function runModelChat(msg) {
  const settings = await getSettings();
  const ollama = await detectOllama();
  let route = Lib.resolveRoute(settings, ollama);
  // Per-task cloud consent: the panel sets this only from an explicit user
  // action (failure-card button or the composer cloud toggle).
  if (msg.cloudConsent === true && route.route !== "cloud") {
    if (!settings.apiKey) return { ok: false, code: "NO_ROUTE", error: "Cloud was chosen for this task, but no OpenRouter API key is set. Add one in Settings." };
    route = { route: "cloud", model: settings.model || "openrouter/free", reason: "You chose cloud for this task." };
  }
  if (route.route === "none") return { ok: false, code: "NO_ROUTE", error: route.reason, route };

  const req = Lib.buildChatRequest(route, { settings, messages: msg.messages || [], tools: msg.tools || [] });
  const callId = msg.callId || `m${Date.now()}`;
  const transports = route.route === "local" ? ["direct", "bridge"] : ["direct"];
  const errors = [];
  for (const transport of transports) {
    if (transport === "bridge" && !bridge.connected) continue; // no bridge: keep the real (direct) error
    try {
      let data;
      if (transport === "direct") {
        const { ctl, promise } = await fetchChat(req);
        modelCalls.set(callId, ctl);
        let res;
        try { res = await promise; } finally { modelCalls.delete(callId); }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Model call failed (${res.status})${text ? ": " + text.slice(0, 300) : ""}`);
        }
        data = await res.json();
      } else {
        data = await bridgeModelChat(req); // local bridge proxy — still on this machine
      }
      return { ok: true, data, route, transport };
    } catch (err) {
      if (err && err.name === "AbortError") return { ok: false, code: "ABORTED", error: "Stopped." };
      errors.push(String(err && err.message ? err.message : err));
      // try the next local transport; cloud is never a fallback here
    }
  }
  return {
    ok: false,
    code: route.route === "local" ? "LOCAL_FAILED" : "CLOUD_FAILED",
    error: errors[0] || "Model call failed.",
    route,
  };
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? tab.id : null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "PAGE_READY":
        case "TOOLS_CHANGED": {
          const tabId = sender.tab && sender.tab.id;
          if (tabId != null) {
            await fetchToolsFromPage(tabId).catch(() => {});
            broadcast({ type: "PANEL_UPDATE", tabId });
          }
          sendResponse({ ok: true });
          break;
        }
        case "GET_TAB_TOOLS": {
          const entry = await fetchToolsFromPage(msg.tabId);
          sendResponse({ ok: true, ...entry });
          break;
        }
        case "SCAN_PAGE": {
          const res = await chrome.tabs.sendMessage(msg.tabId, { type: "SCAN_PAGE" });
          sendResponse(res || { ok: false, error: "No response from page." });
          break;
        }
        case "TAKEOVER_GET": {
          sendResponse({ ok: true, takeover: getTakeover(msg.tabId) });
          break;
        }
        case "TAKEOVER_SET": {
          const state = Lib.normalizeTakeoverState(msg.takeover);
          tabTakeover = state.active
            ? Lib.withTakeoverForTab(tabTakeover, msg.tabId, state)
            : Lib.withoutTakeoverForTab(tabTakeover, msg.tabId);
          broadcast({ type: "TAKEOVER_CHANGED", tabId: msg.tabId, takeover: state });
          sendResponse({ ok: true, takeover: state });
          break;
        }
        case "TAKEOVER_SIGNALS": {
          const res = await chrome.tabs.sendMessage(msg.tabId, { type: "TAKEOVER_SIGNALS" });
          sendResponse(res || { ok: false, error: "No response from page." });
          break;
        }
        case "EXECUTE_TOOL": {
          // Takeover gate: while the user is driving this tab, NOTHING
          // executes on it — reads and writes alike, from any caller.
          const gate = Lib.toolAllowedDuringTakeover(getTakeover(msg.tabId));
          if (!gate.allowed) {
            sendResponse({ ok: false, code: "TAKEOVER_ACTIVE", error: gate.reason });
            break;
          }
          const res = await chrome.tabs.sendMessage(msg.tabId, { type: "EXECUTE_TOOL", tool: msg.tool, args: msg.args });
          sendResponse(res || { ok: false, error: "No response from page." });
          // Actions can change the page: refresh the tool cache shortly after.
          setTimeout(() => fetchToolsFromPage(msg.tabId).catch(() => {}), 600);
          break;
        }
        case "LENS_CHANGED": {
          broadcast({ type: "LENS_CHANGED", tabId: sender.tab ? sender.tab.id : undefined });
          sendResponse({ ok: true });
          break;
        }
        case "LENS_STATE_QUERY": {
          // page.js asks on (re)load: recording intent lives HERE, per tab,
          // so it survives page reloads (page.js state does not).
          const tid = sender.tab ? sender.tab.id : undefined;
          sendResponse({ ok: true, recording: !!(tid != null && lensRecordingByTab.get(tid)) });
          break;
        }
        case "LENS_GET": {
          const res = await chrome.tabs.sendMessage(msg.tabId, { type: "LENS_GET_CALLS" });
          if (res && res.ok) res.recording = !!lensRecordingByTab.get(msg.tabId);
          sendResponse(res || { ok: false, error: "No response from page." });
          break;
        }
        case "LENS_SET": {
          lensRecordingByTab.set(msg.tabId, !!msg.on);
          const res = await chrome.tabs.sendMessage(msg.tabId, { type: "LENS_SET_RECORDING", on: !!msg.on }).catch(() => null);
          sendResponse(res ? { ...res, recording: !!msg.on } : { ok: true, recording: !!msg.on, count: 0 });
          break;
        }
        case "LENS_CLEAR": {
          const res = await chrome.tabs.sendMessage(msg.tabId, { type: "LENS_CLEAR_CALLS" });
          sendResponse(res || { ok: false, error: "No response from page." });
          break;
        }
        case "MESH_NATIVE": {
          // v2.0 Mesh Mode: one-shot Native Messaging to the local mesh
          // daemon (ca.edgeagency.meshnode). The daemon owns keys, certs
          // and the receipt chain; the extension only ever sees public
          // identity (names + fingerprints), pairing payloads and logs.
          try {
            const res = await chrome.runtime.sendNativeMessage("ca.edgeagency.meshnode", msg.payload || {});
            sendResponse(res || { ok: false, error: "Mesh daemon sent no reply." });
          } catch (e) {
            sendResponse({ ok: false, code: "MESH_HOST_MISSING", error: "Mesh daemon not reachable. Install the native host (mesh-daemon/install-native-host) and enroll this machine's node first." });
          }
          break;
        }
        case "IMPORT_API_TOOLS": {
          const stored = await chrome.storage.local.get(API_TOOLS_KEY);
          const all = stored[API_TOOLS_KEY] || {};
          all[msg.origin] = msg.tools;
          await chrome.storage.local.set({ [API_TOOLS_KEY]: all });
          const tabId = await activeTabId();
          if (tabId != null) await fetchToolsFromPage(tabId).catch(() => {});
          sendResponse({ ok: true, count: msg.tools.length });
          break;
        }
        case "BRIDGE_STATUS": {
          sendResponse({ ok: true, connected: bridge.connected });
          break;
        }
        case "OLLAMA_STATUS": {
          const status = await detectOllama(msg.force === true);
          sendResponse({ ok: true, ...status });
          break;
        }
        case "MODEL_ROUTE": {
          const settings = await getSettings();
          const ollama = await detectOllama();
          sendResponse({ ok: true, route: Lib.resolveRoute(settings, ollama), ollama });
          break;
        }
        case "MODEL_CHAT": {
          sendResponse(await runModelChat(msg));
          break;
        }
        case "MODEL_ABORT": {
          const ctl = modelCalls.get(msg.callId);
          if (ctl) { try { ctl.abort(); } catch { /* ignore */ } }
          sendResponse({ ok: true });
          break;
        }
        default:
          // JOURNAL_* messages are answered by the journal listener below.
          if (!String(msg.type || "").startsWith("JOURNAL_")) sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabTools.delete(tabId);
  lensRecordingByTab.delete(tabId);
  tabTakeover = Lib.withoutTakeoverForTab(tabTakeover, tabId); // closing the tab clears its takeover
});
chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));

// ---------------- MCP bridge client (WebSocket to the local bridge) ----------------
// The bridge (bridge/conductor-bridge.mjs, run by the user) exposes the active
// tab's tools as an MCP server over stdio to any MCP client. It relays calls
// here. Policy: read tools run; write tools are refused unless the user turned
// on "bridgeAllowWrites" in Settings. The side-panel chat remains the place
// where writes get approved.

const bridge = { ws: null, connected: false, retryMs: 2000, timer: null, pendingModel: new Map() };

/**
 * Ask the local bridge to perform a model call (it is a plain Node process,
 * so it has no browser-origin restrictions). Used only as the second LOCAL
 * transport when a direct fetch to Ollama fails — never for cloud calls.
 */
async function bridgeModelChat(req) {
  if (!bridge.connected || !bridge.ws) throw new Error("Local bridge is not connected.");
  const id = `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.pendingModel.delete(id);
      reject(new Error("Bridge model call timed out."));
    }, 120000);
    bridge.pendingModel.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      bridge.ws.send(JSON.stringify({ kind: "model-chat", id, url: req.url, headers: req.headers, body: req.body }));
    } catch (err) {
      clearTimeout(timer);
      bridge.pendingModel.delete(id);
      reject(err);
    }
  });
}

async function bridgeSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return data[SETTINGS_KEY] || {};
}

async function bridgeConnect() {
  const settings = await bridgeSettings();
  if (!settings.bridgeEnabled) return;
  if (bridge.ws && (bridge.ws.readyState === WebSocket.OPEN || bridge.ws.readyState === WebSocket.CONNECTING)) return;
  try {
    const ws = new WebSocket("ws://127.0.0.1:8787");
    bridge.ws = ws;
    ws.onopen = () => {
      bridge.connected = true;
      bridge.retryMs = 2000;
      ws.send(JSON.stringify({ kind: "hello", from: "conductor-extension", version: chrome.runtime.getManifest().version }));
      broadcast({ type: "BRIDGE_STATUS", connected: true });
    };
    ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.kind === "list") {
        const tabId = await activeTabId();
        let tools = [];
        if (tabId != null) {
          const entry = await fetchToolsFromPage(tabId).catch(() => tabTools.get(tabId));
          tools = entry ? entry.tools : [];
        }
        ws.send(JSON.stringify({ kind: "tools", tools }));
      } else if (msg.kind === "model-result") {
        const pending = bridge.pendingModel.get(msg.id);
        if (pending) {
          bridge.pendingModel.delete(msg.id);
          if (msg.ok) pending.resolve(msg.data);
          else pending.reject(new Error(msg.error || "Bridge model call failed."));
        }
      } else if (msg.kind === "call") {
        const reply = (payload) => ws.send(JSON.stringify({ kind: "result", id: msg.id, ...payload }));
        try {
          const tabId = await activeTabId();
          if (tabId == null) throw new Error("No active tab.");
          const entry = await fetchToolsFromPage(tabId).catch(() => tabTools.get(tabId));
          const tool = entry && entry.tools.find((t) => t.name === msg.tool);
          if (!tool) throw new Error(`Tool "${msg.tool}" is not available on the active page.`);
          // Takeover gate: a user driving this tab blocks bridge calls too.
          const tkGate = Lib.toolAllowedDuringTakeover(getTakeover(tabId));
          if (!tkGate.allowed) throw new Error(tkGate.reason);
          const s = await bridgeSettings();
          if (tool.risk === "write" && !s.bridgeAllowWrites) {
            throw new Error(`"${tool.name}" is a write tool. Bridge writes are off — approve it in the Conductor side panel, or enable bridge writes in Settings.`);
          }
          const res = await chrome.tabs.sendMessage(tabId, { type: "EXECUTE_TOOL", tool, args: msg.args || {} });
          if (!res || !res.ok) throw new Error((res && res.error) || "Execution failed.");
          reply({ ok: true, result: res.result });
        } catch (err) {
          reply({ ok: false, error: String(err && err.message ? err.message : err) });
        }
      }
    };
    ws.onclose = () => {
      bridge.connected = false;
      bridge.ws = null;
      broadcast({ type: "BRIDGE_STATUS", connected: false });
      scheduleBridgeRetry();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  } catch {
    scheduleBridgeRetry();
  }
}

function scheduleBridgeRetry() {
  clearTimeout(bridge.timer);
  bridge.timer = setTimeout(async () => {
    const settings = await bridgeSettings();
    if (settings.bridgeEnabled) bridgeConnect();
  }, bridge.retryMs);
  bridge.retryMs = Math.min(bridge.retryMs * 1.5, 30000);
}

// ---------------- Session Journal (v1.4) ----------------
// Hash-chained, tamper-evident journal (Lib.journal*) + watch sessions
// with one-click restore, ported from Agent Flight Recorder. While a
// session is armed, tab opens/closes/navigations are journaled; agent
// actions are mirrored in by the panel via JOURNAL_LOG.
const JOURNAL_KEY = "conductor_journal_v1";
const JOURNAL_SESSION_KEY = "conductor_journal_session_v1";
let journalChainCache = null;
let journalSessionCache = undefined; // undefined = not loaded yet
const journalTabUrls = new Map();
let journalWriteQueue = Promise.resolve();

async function journalChain() {
  if (journalChainCache) return journalChainCache;
  const data = await chrome.storage.local.get(JOURNAL_KEY);
  journalChainCache = Array.isArray(data[JOURNAL_KEY]) ? data[JOURNAL_KEY] : [];
  return journalChainCache;
}
async function journalSession() {
  if (journalSessionCache !== undefined) return journalSessionCache;
  const data = await chrome.storage.local.get(JOURNAL_SESSION_KEY);
  journalSessionCache = data[JOURNAL_SESSION_KEY] || null;
  return journalSessionCache;
}
function journalLog(type, text, meta) {
  journalWriteQueue = journalWriteQueue.then(async () => {
    const chain = await journalChain();
    Lib.journalAppend(chain, { type, text, meta });
    journalChainCache = chain;
    await chrome.storage.local.set({ [JOURNAL_KEY]: chain });
    broadcast({ type: "JOURNAL_CHANGED" });
  }).catch(() => {});
  return journalWriteQueue;
}
const journalInternalUrl = (u) => !u || /^(chrome|about|edge|brave|view-source|chrome-extension):/.test(u);

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id != null && tab.url) journalTabUrls.set(tab.id, tab.url);
  const s = await journalSession();
  if (s && s.armed && !journalInternalUrl(tab.url || "")) {
    journalLog("TAB-OPEN", tab.url || tab.title || "New tab", { tabId: tab.id });
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const url = journalTabUrls.get(tabId);
  journalTabUrls.delete(tabId);
  const s = await journalSession();
  if (s && s.armed && url && !journalInternalUrl(url)) {
    journalLog("TAB-CLOSE", url, { tabId });
  }
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const from = journalTabUrls.get(tabId);
  journalTabUrls.set(tabId, changeInfo.url);
  const s = await journalSession();
  if (s && s.armed && from && from !== changeInfo.url && !journalInternalUrl(changeInfo.url)) {
    journalLog("NAV", `${from} → ${changeInfo.url}`, { tabId });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !String(msg.type || "").startsWith("JOURNAL_")) return false;
  (async () => {
    try {
      switch (msg.type) {
        case "JOURNAL_GET": {
          const chain = await journalChain();
          sendResponse({ ok: true, chain, session: await journalSession(), verify: Lib.journalVerify(chain) });
          break;
        }
        case "JOURNAL_LOG": {
          await journalLog(String(msg.entryType || "note"), String(msg.text || ""), msg.meta || {});
          sendResponse({ ok: true });
          break;
        }
        case "JOURNAL_ARM": {
          const tabs = await chrome.tabs.query({});
          const snapshot = tabs
            .filter((t) => !journalInternalUrl(t.url || ""))
            .map((t) => ({ id: t.id, url: t.url, title: t.title || "", pinned: !!t.pinned }));
          journalSessionCache = { armed: true, startedAt: new Date().toISOString(), snapshot };
          await chrome.storage.local.set({ [JOURNAL_SESSION_KEY]: journalSessionCache });
          await journalLog("ARM", `Watch session armed — ${snapshot.length} tab(s) snapshotted`, { tabs: snapshot.length });
          sendResponse({ ok: true, session: journalSessionCache });
          break;
        }
        case "JOURNAL_DISARM": {
          journalSessionCache = null;
          await chrome.storage.local.set({ [JOURNAL_SESSION_KEY]: null });
          await journalLog("DISARM", "Watch session disarmed");
          sendResponse({ ok: true });
          break;
        }
        case "JOURNAL_PLAN": {
          const s = await journalSession();
          if (!s || !s.armed) { sendResponse({ ok: false, error: "No armed session." }); break; }
          const current = await chrome.tabs.query({});
          sendResponse({ ok: true, plan: Lib.planRestore(s.snapshot, current) });
          break;
        }
        case "JOURNAL_RESTORE": {
          const s = await journalSession();
          if (!s || !s.armed) { sendResponse({ ok: false, error: "No armed session." }); break; }
          const current = await chrome.tabs.query({});
          const plan = Lib.planRestore(s.snapshot, current);
          for (const id of plan.closeIds) { try { await chrome.tabs.remove(id); } catch { /* already gone */ } }
          for (const item of plan.open) { try { await chrome.tabs.create({ url: item.url, pinned: item.pinned, active: false }); } catch { /* skip */ } }
          await journalLog("RESTORE", `Restored session snapshot — closed ${plan.closeIds.length}, reopened ${plan.open.length}`, { closed: plan.closeIds.length, opened: plan.open.length });
          sendResponse({ ok: true, plan });
          break;
        }
        case "JOURNAL_CLEAR": {
          journalChainCache = [];
          await chrome.storage.local.set({ [JOURNAL_KEY]: [] });
          broadcast({ type: "JOURNAL_CHANGED" });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown journal message." });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) {
    const next = changes[SETTINGS_KEY].newValue || {};
    if (next.bridgeEnabled) bridgeConnect();
    else if (bridge.ws) { try { bridge.ws.close(); } catch { /* ignore */ } }
  }
});

chrome.runtime.onStartup.addListener(bridgeConnect);
bridgeConnect();
