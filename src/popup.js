// Conductor action popup — status at a glance, then one click to the chat.
(async () => {
  const stats = document.getElementById("pop-stats");
  const sub = document.getElementById("pop-sub");
  const routeEl = document.getElementById("pop-route");
  const bridgeText = document.getElementById("pop-bridge-text");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab) {
    if (tab.title) sub.textContent = tab.title;
    sub.title = tab.title || "";
    try {
      const res = await chrome.runtime.sendMessage({ type: "GET_TAB_TOOLS", tabId: tab.id });
      if (res && res.ok) {
        const reads = res.tools.filter((t) => t.risk === "read").length;
        stats.innerHTML = `<b>${res.tools.length}</b> tools · <b>${reads}</b> read · <b>${res.tools.length - reads}</b> write`;
      } else {
        stats.textContent = "Couldn't read this page — reload the tab if Conductor was just installed.";
      }
    } catch {
      stats.textContent = "Couldn't read this page — reload the tab if Conductor was just installed.";
    }
  } else {
    stats.textContent = "No active tab.";
  }

  try {
    const r = await chrome.runtime.sendMessage({ type: "MODEL_ROUTE" });
    if (r && r.ok && r.route) {
      if (r.route.route === "local") { routeEl.textContent = "Private · Local (Ollama)"; routeEl.classList.add("local"); }
      else if (r.route.route === "cloud") { routeEl.textContent = "Cloud (OpenRouter)"; routeEl.classList.add("cloud"); }
      else routeEl.textContent = "No model route";
      routeEl.title = `${r.route.reason || ""}${r.route.model ? ` · model: ${r.route.model}` : ""}`;
    } else {
      routeEl.textContent = "Unknown";
    }
  } catch { routeEl.textContent = "Unknown"; }

  try {
    const b = await chrome.runtime.sendMessage({ type: "BRIDGE_STATUS" });
    const on = !!(b && b.connected);
    document.getElementById("pop-bridge").classList.toggle("on", on);
    bridgeText.textContent = on ? "Connected" : "Not connected";
  } catch { bridgeText.textContent = "Unknown"; }

  const openWorkspace = async (hash) => {
    if (tab) await chrome.storage.local.set({ conductor_target_tab_v1: tab.id });
    const url = chrome.runtime.getURL("src/full.html") + (hash || "");
    if (chrome.windows && chrome.windows.create) {
      await chrome.windows.create({ url, type: "popup", width: 1360, height: 920, focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
    window.close();
  };

  document.getElementById("open-panel").addEventListener("click", async () => {
    try { await chrome.sidePanel.open({ tabId: tab.id }); window.close(); } catch { /* needs gesture context */ }
  });
  document.getElementById("open-big").addEventListener("click", () => openWorkspace(""));
  document.getElementById("open-settings").addEventListener("click", () => openWorkspace("#settings"));
})();
