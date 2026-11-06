// Conductor native-tool detector — MAIN world, document_start.
// Watches for WebMCP tool registrations (navigator.modelContext / document.modelContext)
// and declarative <form toolname> tools. Metadata is announced to the isolated
// world via postMessage; execution stays here, where the page registered the fns.
(function () {
  if (window.__conductorDetect) return;
  window.__conductorDetect = true;

  const registry = new Map(); // name -> { meta, execute }

  function announce() {
    const tools = [...registry.values()].map((r) => r.meta);
    window.postMessage({ __conductor: true, kind: "native-tools", tools }, "*");
  }

  function register(meta, execute) {
    if (!meta || !meta.name) return;
    registry.set(meta.name, {
      meta: {
        name: meta.name,
        description: meta.description || "",
        inputSchema: meta.inputSchema || null,
        annotations: meta.annotations || null,
      },
      execute: typeof execute === "function" ? execute : null,
    });
    announce();
  }

  function unregister(name) {
    if (registry.delete(name)) announce();
  }

  function patchContext(ctx, label) {
    if (!ctx || ctx.__conductorPatched) return;
    try {
      const origRegister = ctx.registerTool;
      if (typeof origRegister === "function") {
        ctx.registerTool = function (tool, options) {
          try {
            register(
              { name: tool && tool.name, description: tool && tool.description, inputSchema: tool && (tool.inputSchema || tool.input_schema), annotations: tool && tool.annotations },
              tool && typeof tool.execute === "function" ? tool.execute : null
            );
          } catch (e) { /* never break the page */ }
          return origRegister.apply(this, arguments);
        };
      }
      const origUnregister = ctx.unregisterTool;
      if (typeof origUnregister === "function") {
        ctx.unregisterTool = function (name) {
          unregister(name);
          return origUnregister.apply(this, arguments);
        };
      }
      ctx.__conductorPatched = true;
    } catch (e) { /* some contexts are frozen; polling below still catches declarative tools */ }
  }

  function scanContexts() {
    try { patchContext(navigator.modelContext, "navigator"); } catch (e) {}
    try { patchContext(document.modelContext, "document"); } catch (e) {}
  }

  // Declarative WebMCP: <form toolname="..." tooldescription="...">
  function scanDeclarative() {
    document.querySelectorAll("form[toolname]").forEach((form) => {
      const name = form.getAttribute("toolname");
      if (!name || registry.has(name)) return;
      const properties = {};
      form.querySelectorAll("input[name], select[name], textarea[name]").forEach((el) => {
        properties[el.name] = { type: el.type === "number" ? "number" : el.type === "checkbox" ? "boolean" : "string", description: el.name };
      });
      register(
        { name, description: form.getAttribute("tooldescription") || `Form tool "${name}"`, inputSchema: { type: "object", properties }, annotations: { readOnlyHint: false } },
        async (args) => {
          for (const [k, v] of Object.entries(args || {})) {
            const el = form.querySelector(`[name="${CSS.escape(k)}"]`);
            if (el) {
              if (el.type === "checkbox") el.checked = !!v;
              else el.value = v;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
          if (form.requestSubmit) form.requestSubmit();
          else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          return { submitted: name };
        }
      );
    });
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || !e.data || e.data.__conductor !== true) return;
    if (e.data.kind === "get-native") {
      scanContexts();
      scanDeclarative();
      announce();
    } else if (e.data.kind === "call-native") {
      const { callId, name, args } = e.data;
      const entry = registry.get(name);
      const reply = (payload) => window.postMessage({ __conductor: true, kind: "native-result", callId, ...payload }, "*");
      if (!entry) return reply({ ok: false, error: `Native tool "${name}" is no longer registered.` });
      if (!entry.execute) return reply({ ok: false, error: `Native tool "${name}" has no callable execute captured (registered before Conductor loaded, or via an unsupported shape).` });
      try {
        const result = await entry.execute(args || {});
        reply({ ok: true, result: result === undefined ? { ok: true } : result });
      } catch (err) {
        reply({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    }
  });

  scanContexts();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { scanContexts(); scanDeclarative(); announce(); });
  } else {
    scanDeclarative();
    announce();
  }
  // Pages may create modelContext lazily; keep patching briefly.
  let tries = 0;
  const iv = setInterval(() => {
    scanContexts();
    if (++tries > 20) clearInterval(iv);
  }, 500);
})();
