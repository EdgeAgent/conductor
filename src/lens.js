// Conductor API Lens recorder — MAIN world, document_start (v1.5).
// Wraps fetch / XMLHttpRequest / sendBeacon and reports request+response
// metadata to page.js (isolated world) via window.postMessage, ONLY while
// recording is switched on for this page. It never alters page traffic
// (responses are read from clones). page.js redacts secrets before
// anything is stored; raw bodies never leave this script's memory except
// as parsed JSON that page.js redacts on receipt.
(function () {
  if (window.__conductorLens) return;
  window.__conductorLens = true;

  var MAX_BODY = 256 * 1024;
  var recording = false;
  var stateKnown = false;
  var pendingSends = [];
  var seq = 0;

  function deliver(entry) {
    try {
      window.postMessage({ __conductor: true, kind: "lens-entry", entry: entry }, "*");
    } catch (e) { /* page closing etc. */ }
  }
  // Tri-state gate: while the recording state is unknown (page just
  // loaded, bridge hasn't answered yet), entries are held in memory for
  // a moment and then flushed (recording on) or dropped (off). Once the
  // state is known, off means off — nothing is held or sent.
  function send(entry) {
    if (!stateKnown) {
      if (pendingSends.length < 50) pendingSends.push(entry);
      return;
    }
    if (recording) deliver(entry);
  }
  function shouldWatch() {
    return !stateKnown || recording;
  }

  window.addEventListener("message", function (e) {
    if (e.source === window && e.data && e.data.__conductor === true && e.data.kind === "lens-control") {
      var wasKnown = stateKnown;
      recording = !!e.data.recording;
      stateKnown = true;
      if (!wasKnown) {
        var held = pendingSends;
        pendingSends = [];
        if (recording) held.forEach(deliver);
      }
    }
  });
  window.postMessage({ __conductor: true, kind: "lens-ready" }, "*");

  function truncate(s) {
    if (typeof s !== "string") return s;
    return s.length > MAX_BODY ? s.slice(0, MAX_BODY) : s;
  }
  function parseMaybeJson(text) {
    if (typeof text !== "string" || !text) return null;
    var t = text.trim();
    if (t.charAt(0) !== "{" && t.charAt(0) !== "[") return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }
  function headersToObject(headers) {
    var out = {};
    if (!headers) return out;
    try {
      if (typeof headers.forEach === "function") {
        headers.forEach(function (v, k) { out[k] = v; });
      } else if (Array.isArray(headers)) {
        headers.forEach(function (pair) { out[pair[0]] = pair[1]; });
      } else if (typeof headers === "object") {
        Object.keys(headers).forEach(function (k) { out[k] = String(headers[k]); });
      }
    } catch (e) { /* ignore */ }
    return out;
  }
  function bodyToRaw(body) {
    if (body == null) return null;
    if (typeof body === "string") return truncate(body);
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return truncate(body.toString());
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      var parts = [];
      body.forEach(function (v, k) { parts.push(k + "=" + (typeof v === "string" ? v : "[file]")); });
      return truncate(parts.join("&"));
    }
    return null;
  }
  function baseEntry(transport, method, url) {
    seq += 1;
    return {
      id: "e" + Date.now().toString(36) + "-" + seq,
      ts: Date.now(),
      pageUrl: window.location.href,
      transport: transport,
      method: (method || "GET").toUpperCase(),
      url: url,
      requestHeaders: {},
      requestBody: null,
      status: 0,
      responseHeaders: {},
      responseBody: null,
      durationMs: 0,
      sizeBytes: 0,
    };
  }

  // ---- fetch ----
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var started = performance.now();
      var method = "GET";
      var url = "";
      var reqHeaders = {};
      var reqBodyRaw = null;
      try {
        if (typeof input === "string") { url = input; }
        else if (input && typeof input.url === "string") {
          url = input.url;
          method = input.method || method;
          reqHeaders = headersToObject(input.headers);
        }
        if (init) {
          if (init.method) method = init.method;
          if (init.headers) reqHeaders = headersToObject(init.headers);
          reqBodyRaw = bodyToRaw(init.body);
        }
      } catch (e) { /* fall through */ }
      var resolvedUrl;
      try { resolvedUrl = new URL(url, window.location.href).href; } catch (e) { resolvedUrl = url; }

      var promise = origFetch.apply(this, arguments);
      if (!shouldWatch()) return promise;
      return promise.then(function (res) {
        try {
          var entry = baseEntry("fetch", method, resolvedUrl);
          entry.requestHeaders = reqHeaders;
          entry.requestBody = parseMaybeJson(reqBodyRaw);
          entry.status = res.status;
          entry.responseHeaders = headersToObject(res.headers);
          entry.durationMs = Math.round(performance.now() - started);
          var clone = res.clone();
          clone.text().then(function (text) {
            entry.responseBody = parseMaybeJson(text);
            entry.sizeBytes = text ? text.length : 0;
            send(entry);
          }).catch(function () { send(entry); });
        } catch (e) { /* never break the page */ }
        return res;
      }, function (err) {
        try {
          var entry = baseEntry("fetch", method, resolvedUrl);
          entry.requestHeaders = reqHeaders;
          entry.requestBody = parseMaybeJson(reqBodyRaw);
          entry.status = 0;
          entry.error = String(err && err.message ? err.message : err);
          entry.durationMs = Math.round(performance.now() - started);
          send(entry);
        } catch (e) { /* ignore */ }
        throw err;
      });
    };
  }

  // ---- XMLHttpRequest ----
  var XHR = window.XMLHttpRequest;
  if (typeof XHR === "function") {
    var proto = XHR.prototype;
    var origOpen = proto.open;
    var origSend = proto.send;
    var origSetHeader = proto.setRequestHeader;
    proto.open = function (method, url) {
      this.__cl = { method: (method || "GET").toUpperCase(), url: "" };
      try { this.__cl.url = new URL(url, window.location.href).href; } catch (e) { this.__cl.url = String(url); }
      return origOpen.apply(this, arguments);
    };
    proto.setRequestHeader = function (name, value) {
      if (this.__cl) {
        this.__cl.headers = this.__cl.headers || {};
        this.__cl.headers[name] = value;
      }
      return origSetHeader.apply(this, arguments);
    };
    proto.send = function (body) {
      var xhr = this;
      var meta = xhr.__cl || { method: "GET", url: "" };
      var started = performance.now();
      var reqBodyRaw = bodyToRaw(body);
      if (shouldWatch()) {
        xhr.addEventListener("loadend", function () {
          try {
            var entry = baseEntry("xhr", meta.method, meta.url);
            entry.requestHeaders = meta.headers || {};
            entry.requestBody = parseMaybeJson(reqBodyRaw);
            entry.status = xhr.status;
            entry.durationMs = Math.round(performance.now() - started);
            var all = "";
            try { all = xhr.getAllResponseHeaders() || ""; } catch (e) { /* ignore */ }
            all.trim().split(/[\r\n]+/).forEach(function (line) {
              var idx = line.indexOf(":");
              if (idx > 0) entry.responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
            });
            if (xhr.responseType === "" || xhr.responseType === "text") {
              var text = "";
              try { text = xhr.responseText || ""; } catch (e) { /* ignore */ }
              entry.responseBody = parseMaybeJson(text);
              entry.sizeBytes = text.length;
            } else if (xhr.responseType === "json" && xhr.response != null) {
              entry.responseBody = xhr.response;
            }
            send(entry);
          } catch (e) { /* never break the page */ }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  // ---- sendBeacon ----
  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (shouldWatch()) {
        try {
          var entry = baseEntry("beacon", "POST", new URL(url, window.location.href).href);
          entry.requestBody = parseMaybeJson(bodyToRaw(data));
          entry.status = 0;
          entry.note = "sendBeacon — no response observable";
          send(entry);
        } catch (e) { /* ignore */ }
      }
      return origBeacon(url, data);
    };
  }
})();
