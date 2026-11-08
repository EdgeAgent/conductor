// Conductor API Lens bridge — isolated world, document_start (v1.5).
// Owns the Lens plumbing so recording state is known before page scripts
// fire their first calls: recording intent lives in the worker per tab;
// this bridge adopts it immediately, holds entries briefly while the
// state answer is in flight, and drops them if recording is off.
// Entries are REDACTED on receipt (Lib.lens*) — raw secrets never reach
// storage or the panel. page.js does not handle Lens messages.
(function () {
  if (window.__conductorLensBridge) return;
  window.__conductorLensBridge = true;
  const Lib = window.ConductorLib;

  let lensRecording = false;
  let lensStateKnown = false;
  const lensCalls = [];
  const lensPending = []; // entries held until the state answer arrives
  const LENS_MAX_CALLS = 300;

  function announce() {
    window.postMessage({ __conductor: true, kind: "lens-control", recording: lensRecording }, "*");
  }
  function store(raw) {
    if (!raw || typeof raw.url !== "string") return;
    const entry = {
      id: raw.id, ts: raw.ts, pageUrl: raw.pageUrl, transport: raw.transport,
      method: raw.method, url: raw.url, status: raw.status,
      durationMs: raw.durationMs, sizeBytes: raw.sizeBytes,
      requestHeaders: Lib.lensRedactHeaders(raw.requestHeaders || {}),
      requestBody: Lib.lensRedactBody(raw.requestBody ?? null),
      responseHeaders: Lib.lensRedactHeaders(raw.responseHeaders || {}),
      responseBody: Lib.lensRedactBody(raw.responseBody ?? null),
    };
    lensCalls.push(entry);
    if (lensCalls.length > LENS_MAX_CALLS) lensCalls.splice(0, lensCalls.length - LENS_MAX_CALLS);
    chrome.runtime.sendMessage({ type: "LENS_CHANGED" }).catch(() => {});
  }

  chrome.runtime.sendMessage({ type: "LENS_STATE_QUERY" }).then((res) => {
    lensRecording = !!(res && res.ok && res.recording);
    lensStateKnown = true;
    if (lensRecording) for (const raw of lensPending) store(raw);
    lensPending.length = 0;
    announce();
  }).catch(() => {
    lensStateKnown = true;
    lensPending.length = 0;
  });

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__conductor !== true) return;
    if (e.data.kind === "lens-ready") {
      if (lensStateKnown) announce();
    } else if (e.data.kind === "lens-entry") {
      if (!lensStateKnown) {
        if (lensPending.length < 100) lensPending.push(e.data.entry);
      } else if (lensRecording) {
        store(e.data.entry);
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !String(msg.type || "").startsWith("LENS_")) return false;
    if (msg.type === "LENS_SET_RECORDING") {
      lensRecording = !!msg.on;
      lensStateKnown = true;
      announce();
      sendResponse({ ok: true, recording: lensRecording, count: lensCalls.length });
    } else if (msg.type === "LENS_GET_CALLS") {
      sendResponse({ ok: true, recording: lensRecording, calls: lensCalls });
    } else if (msg.type === "LENS_CLEAR_CALLS") {
      lensCalls.length = 0;
      sendResponse({ ok: true });
    } else {
      return false;
    }
    return true;
  });
})();
