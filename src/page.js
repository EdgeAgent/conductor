// Conductor page brain — ISOLATED world content script.
// Builds a snapshot of the page, synthesizes tools from it (via ConductorLib),
// merges native WebMCP tools announced by detect.js, and executes tool calls.
(function () {
  if (window.__conductorPage) return;
  window.__conductorPage = true;

  const Lib = window.ConductorLib;
  const MAX_TEXT = 8000;
  let cidSeq = 0;
  let nativeRaw = [];
  let currentTools = [];
  let lastUrl = location.href;

  const byCid = (cid) => document.querySelector(`[data-conductor-cid="${CSS.escape(cid)}"]`);
  const stamp = (el) => {
    if (!el.getAttribute("data-conductor-cid")) el.setAttribute("data-conductor-cid", "c" + (++cidSeq));
    return el.getAttribute("data-conductor-cid");
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  };
  const textOf = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");

  function labelFor(el) {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return textOf(lab);
    }
    const wrap = el.closest("label");
    if (wrap) return textOf(wrap).replace(textOf(el), "").trim();
    return el.getAttribute("aria-label") || el.placeholder || el.name || "";
  }

  function buildSnapshot() {
    const snapshot = {
      url: location.href,
      title: document.title,
      headings: [...document.querySelectorAll("h1,h2,h3")].slice(0, 20).map(textOf).filter(Boolean),
      forms: [],
      buttons: [],
      links: [],
      tables: [],
    };
    document.querySelectorAll("form").forEach((form) => {
      if (snapshot.forms.length >= 8) return;
      const fields = [];
      form.querySelectorAll("input, select, textarea").forEach((el) => {
        if (el.type === "hidden" || el.type === "submit" || el.type === "button") return;
        const field = {
          cid: stamp(el),
          name: el.name || "",
          label: labelFor(el),
          type: el.type || el.tagName.toLowerCase(),
          required: !!el.required,
        };
        if (el.tagName === "SELECT") field.options = [...el.options].map((o) => o.value || o.text).slice(0, 50);
        fields.push(field);
      });
      snapshot.forms.push({
        cid: stamp(form),
        name: form.getAttribute("name") || form.id || form.getAttribute("aria-label") || "",
        method: form.method || "get",
        fields,
      });
    });
    document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button']").forEach((el) => {
      if (snapshot.buttons.length >= 60 || !visible(el)) return;
      const text = el.tagName === "INPUT" ? el.value : textOf(el);
      if (text) snapshot.buttons.push({ cid: stamp(el), text });
    });
    document.querySelectorAll("a[href]").forEach((el) => {
      if (snapshot.links.length >= 100) return;
      snapshot.links.push({ cid: stamp(el), text: textOf(el), href: el.href });
    });
    document.querySelectorAll("table").forEach((table) => {
      if (snapshot.tables.length >= 6) return;
      const caption = table.caption ? textOf(table.caption) : "";
      const headers = [...table.querySelectorAll("thead th, tr th")].map(textOf);
      snapshot.tables.push({ cid: stamp(table), caption, columns: headers, rowCount: table.querySelectorAll("tr").length });
    });
    return snapshot;
  }

  function rebuildTools() {
    const snapshot = buildSnapshot();
    const domTools = Lib.buildToolsFromSnapshot(snapshot);
    const nativeTools = Lib.wrapNativeTools(nativeRaw);
    currentTools = Lib.mergeTools(nativeTools, domTools);
    return { snapshot, tools: currentTools };
  }

  // ---- native tool plumbing (detect.js lives in MAIN world) ----
  let nativeCallSeq = 0;
  const nativePending = new Map();
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__conductor !== true) return;
    if (e.data.kind === "native-tools") {
      const next = e.data.tools || [];
      // Only report a change when the native set actually changed. Without
      // this guard, our own GET_TOOLS -> get-native -> announce cycle fires
      // TOOLS_CHANGED forever, flooding the message queue until real tool
      // executions starve (the v1.1 "stuck on running" bug).
      const changed = JSON.stringify(next) !== JSON.stringify(nativeRaw);
      nativeRaw = next;
      if (changed) chrome.runtime.sendMessage({ type: "TOOLS_CHANGED" }).catch(() => {});
    } else if (e.data.kind === "native-result") {
      const p = nativePending.get(e.data.callId);
      if (p) {
        nativePending.delete(e.data.callId);
        if (e.data.ok) p.resolve(e.data.result);
        else p.reject(new Error(e.data.error || "Native tool failed"));
      }
    }
  });
  function callNative(name, args) {
    return new Promise((resolve, reject) => {
      const callId = "n" + (++nativeCallSeq);
      nativePending.set(callId, { resolve, reject });
      window.postMessage({ __conductor: true, kind: "call-native", callId, name, args }, "*");
      setTimeout(() => {
        if (nativePending.has(callId)) {
          nativePending.delete(callId);
          reject(new Error("Native tool timed out (15s)."));
        }
      }, 15000);
    });
  }

  // ---- field value setting (React/Vue-friendly) ----
  function setValue(el, value) {
    if (el.tagName === "SELECT") {
      const opt = [...el.options].find((o) => o.value === String(value) || o.text === String(value));
      el.value = opt ? opt.value : String(value);
    } else if (el.type === "checkbox" || el.type === "radio") {
      el.checked = !!value && value !== "false";
    } else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
      if (setter) setter.call(el, String(value));
      else el.value = String(value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findField(scope, labelText) {
    const wanted = String(labelText || "").toLowerCase();
    const fields = [...scope.querySelectorAll("input, select, textarea")];
    return (
      fields.find((el) => (el.name || "").toLowerCase() === wanted) ||
      fields.find((el) => labelFor(el).toLowerCase() === wanted) ||
      fields.find((el) => (el.placeholder || "").toLowerCase() === wanted) ||
      fields.find((el) => labelFor(el).toLowerCase().includes(wanted) && wanted.length >= 3) ||
      null
    );
  }

  const truncate = (s, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) + `\n… [truncated at ${n} chars]` : s);

  async function execute(tool, args = {}) {
    const a = tool.action || {};
    switch (a.kind) {
      case "structure": {
        const { snapshot } = rebuildTools();
        return {
          title: snapshot.title,
          url: snapshot.url,
          headings: snapshot.headings,
          forms: snapshot.forms.map((f) => ({ name: f.name || "(unnamed)", fields: f.fields.map((x) => x.label || x.name) })),
          tables: snapshot.tables.map((t) => ({ caption: t.caption, columns: t.columns, rows: t.rowCount })),
          buttons: snapshot.buttons.slice(0, 25).map((b) => b.text),
        };
      }
      case "extract-text": {
        const root = args.selector ? document.querySelector(args.selector) : document.querySelector("main") || document.body;
        if (!root) throw new Error(`Selector not found: ${args.selector}`);
        return truncate((root.innerText || "").trim());
      }
      case "extract-links": {
        const { snapshot } = rebuildTools();
        return snapshot.links.slice(0, 100);
      }
      case "extract-table": {
        const table = byCid(a.cid);
        if (!table) throw new Error("Table is no longer on the page — refresh the tools.");
        const headers = [...table.querySelectorAll("thead th, tr th")].map(textOf);
        const maxRows = Math.min(Number(args.maxRows) || 100, 500);
        const rows = [];
        table.querySelectorAll("tbody tr, tr").forEach((tr) => {
          if (rows.length >= maxRows) return;
          const cells = [...tr.querySelectorAll("td")].map(textOf);
          if (!cells.length) return;
          const row = {};
          cells.forEach((c, i) => { row[headers[i] || `col_${i + 1}`] = c; });
          rows.push(row);
        });
        return rows;
      }
      case "submit-form": {
        const form = byCid(a.cid);
        if (!form) throw new Error("Form is no longer on the page — refresh the tools.");
        const filled = {};
        const els = [...form.querySelectorAll("input, select, textarea")].filter((el) => !["hidden", "submit", "button"].includes(el.type));
        for (const el of els) {
          const key = Lib.slugify(el.name || labelFor(el), "");
          const altKey = Lib.slugify(labelFor(el), "");
          const value = args[key] !== undefined ? args[key] : args[altKey];
          if (value !== undefined) {
            setValue(el, value);
            filled[key || altKey] = value;
          }
        }
        await new Promise((r) => setTimeout(r, 60));
        if (form.requestSubmit) form.requestSubmit();
        else {
          const btn = form.querySelector("[type='submit'], button:not([type])");
          if (btn) btn.click();
          else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        }
        await new Promise((r) => setTimeout(r, 400));
        return { submitted: true, filled, urlNow: location.href };
      }
      case "click-element": {
        const el = byCid(a.cid);
        if (!el) throw new Error("That element is no longer on the page — refresh the tools.");
        el.scrollIntoView({ block: "center" });
        el.click();
        await new Promise((r) => setTimeout(r, 300));
        return { clicked: textOf(el) || el.value || true, urlNow: location.href };
      }
      case "click-by-text": {
        const wanted = String(args.text || "").trim().toLowerCase();
        const candidates = [...document.querySelectorAll("button, a, [role='button'], input[type='submit'], input[type='button']")].filter(visible);
        const el = candidates.find((c) => (c.tagName === "INPUT" ? c.value : textOf(c)).toLowerCase() === wanted)
          || candidates.find((c) => (c.tagName === "INPUT" ? c.value : textOf(c)).toLowerCase().includes(wanted));
        if (!el) throw new Error(`No clickable element with text "${args.text}" found.`);
        el.scrollIntoView({ block: "center" });
        el.click();
        await new Promise((r) => setTimeout(r, 300));
        return { clicked: args.text, urlNow: location.href };
      }
      case "fill-field": {
        const el = findField(document, args.label);
        if (!el) throw new Error(`No field labelled "${args.label}" found.`);
        el.focus();
        setValue(el, args.value);
        return { filled: args.label, value: args.value };
      }
      case "navigate": {
        location.href = args.url;
        return { navigating: args.url };
      }
      case "webmcp": {
        return await callNative(a.nativeName, args);
      }
      case "api": {
        let path = a.path;
        const query = new URLSearchParams();
        const pathArgs = {};
        for (const [k, v] of Object.entries(args)) {
          if (k === "body") continue;
          if (path.includes(`{${k}}`)) { path = path.replace(`{${k}}`, encodeURIComponent(String(v))); pathArgs[k] = v; }
          else query.set(k, String(v));
        }
        const qs = query.toString();
        const url = (a.origin || location.origin) + path + (qs ? `?${qs}` : "");
        const res = await fetch(url, {
          method: a.method,
          // a.headers is set transiently by the panel when a Vault key exists
          // for this origin (attached at execution time, never stored on the
          // tool, never shown to the model).
          headers: { ...(a.headers || {}), ...(args.body ? { "Content-Type": "application/json" } : {}) },
          body: args.body ? JSON.stringify(args.body) : undefined,
          credentials: "include",
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { /* leave raw */ }
        return { status: res.status, body: parsed !== null ? parsed : truncate(text, 4000) };
      }
      default:
        throw new Error(`Unknown tool action: ${a.kind}`);
    }
  }

  // ---- Site scanner (read-only inventory; never executes anything) ----
  const PAYMENT_RE = /(card|credit|cc[-_ ]?(num|number|cvc|cvv|exp)|cvc|cvv|expiry|exp[-_ ]?(month|year)|billing)/i;
  function scanPage() {
    const { tools } = rebuildTools();
    let fields = 0;
    let paymentLikely = false;
    document.querySelectorAll("form").forEach((form) => {
      form.querySelectorAll("input, select, textarea").forEach((el) => {
        fields++;
        const probe = `${el.name || ""} ${el.id || ""} ${el.getAttribute("autocomplete") || ""} ${labelFor(el)}`;
        if (PAYMENT_RE.test(probe) || /^cc-/.test(el.getAttribute("autocomplete") || "")) paymentLikely = true;
      });
    });
    return {
      url: location.href,
      title: document.title,
      nativeTools: tools.filter((t) => t.source === "webmcp").map((t) => ({ name: t.name, risk: t.risk })),
      synthesizedCount: tools.filter((t) => t.source === "dom").length,
      inventory: {
        forms: document.querySelectorAll("form").length,
        fields,
        tables: document.querySelectorAll("table").length,
        buttons: [...document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button']")].filter(visible).length,
        links: document.querySelectorAll("a[href]").length,
        headings: document.querySelectorAll("h1,h2,h3").length,
        passwordFields: document.querySelectorAll('input[type="password"]').length,
        fileInputs: document.querySelectorAll('input[type="file"]').length,
        paymentLikely,
      },
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "SCAN_PAGE") {
          window.postMessage({ __conductor: true, kind: "get-native" }, "*");
          await new Promise((r) => setTimeout(r, 120));
          sendResponse({ ok: true, scan: scanPage() });
        } else if (msg.type === "GET_TOOLS") {
          window.postMessage({ __conductor: true, kind: "get-native" }, "*");
          // give detect.js a beat to announce fresh native tools
          await new Promise((r) => setTimeout(r, 120));
          const { tools } = rebuildTools();
          sendResponse({ ok: true, tools, url: location.href, title: document.title });
        } else if (msg.type === "EXECUTE_TOOL") {
          const result = await execute(msg.tool, msg.args || {});
          sendResponse({ ok: true, result });
        } else {
          sendResponse({ ok: false, error: "Unknown message" });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  });

  // SPA navigation watcher: tools are per-page, tell the worker when the URL moves.
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      chrome.runtime.sendMessage({ type: "TOOLS_CHANGED" }).catch(() => {});
    }
  }, 1500);

  window.postMessage({ __conductor: true, kind: "get-native" }, "*");
  chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => {});
})();
