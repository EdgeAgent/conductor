# 🎼 Conductor — AI Browser Agent & MCP Tools

**The web has millions of useful sites and almost no MCP servers. Conductor closes that gap from inside your browser.**

Open any page and Conductor gives it a tool surface an AI can actually use — then lets you drive it from a chat panel, or expose it to *any* MCP client (Hermes, Claude, your own agents) through a tiny local bridge. New in v1.2: **local-first model routing** — run Ollama and page content never leaves your computer. **New in v2.0: the suite** — a tamper-evident session Journal, the Lens API recorder built in, a Wallet guard that caps agent spending, and Mesh Mode: QR pairing and node management with the [Conductor Mesh](mesh/README.md) daemon.

## The three ways a page gets tools

1. **Native WebMCP** — if the site exposes tools via `navigator.modelContext` (the emerging WebMCP standard), Conductor detects them live, including declarative `<form toolname>` tools, and makes them callable.
2. **Synthesis** — no WebMCP? Conductor reads the page and builds typed tools from what's actually there: forms become fill-and-submit tools with real field schemas, tables become JSON extractors, buttons become click tools, plus universal extract/navigate tools. Works on the 99.9% of the web that has no API and no MCP server.
3. **Import** — recorded a site's real API with [API Lens](https://github.com/EdgeAgent)? Import its OpenAPI export and those endpoints become tools too, executed in the page's own context with your session.

## Chat that drives the page — with a gate

The side-panel chat runs an agent loop against the current tab's tools:

- **Read tools run automatically** — extracts, lookups, structure.
- **Write tools stop and ask.** Every click that matters, every form submit, every navigation shows its exact arguments and waits for your Approve/Deny. Denied actions tell the model to stand down.
- **Page content is data, not orders.** The agent is instructed to ignore instructions embedded in pages — and you see every step as a card, live.
- **🛡 Activity tab** — every tool call, approval, denial, route change and error is logged with a timestamp, stored only in your browser. Trust, but verify.

## Takeover Mode (v1.3)

The pause/takeover pattern, in the browser. Three ways control passes to you, one way back:

- **You grab it.** Hit **✋ Take over** in the chat (side panel or Big Workspace) any time — even mid-task. Any in-flight round stops cleanly after its current tool call, a persistent banner appears (*"You're in control — Conductor is paused on this tab"*), and while you drive, **nothing executes on that tab**: tool calls attempted during takeover are refused in the open, with the reason on the step card and in the Activity log. The same gate covers chat, the worker, and MCP bridge calls.
- **The page asks for you.** A deterministic detector reads the live page (never guesses from the model's mood) and stops with a request card when it sees a **payment/checkout form**, a **CAPTCHA** (reCAPTCHA / hCaptcha / Turnstile widgets), a **one-time-code / 2FA input**, or a **sign-in form with a password field**. Detection is a safety net, not a promise — see Honest limits.
- **The model asks.** The agent has a `request_takeover` tool for steps it shouldn't do alone, with its reason shown on the same card. You can always say "not now" — the agent continues, still barred from typing passwords, codes, or card numbers itself.

**Hand back** ends it: Conductor takes a fresh snapshot, posts what visibly changed while you drove (new URL/title at minimum), tells the model the new page state, and the conversation resumes. Takeover is **per-tab** — driving one tab never pauses another — and closing the tab clears it.

## The Suite — Journal, Lens, Wallet guard, Mesh (v1.4–v2.0)

Conductor grew from a browser agent into the control surface for your agent stack. Four modules, all local, all off-by-default where they touch anything sensitive:

- **🛡 Journal (v1.4)** — an append-only, hash-chained receipt log of sessions: arm a watch and tab opens/closes/navigations are chained (SHA-256, verifiable in the panel), alongside every tool call, approval, denial and takeover from chat. One-click restore reopens a session's tabs from the chain; exports are JSON receipts or a printable HTML report.
- **🔎 Lens (v1.5)** — the API Lens recorder, built in. Arm recording on a tab and Conductor captures the page's fetch/XHR calls (secrets redacted on receipt — tokens and passwords never reach storage), groups them into endpoints with inferred schemas and detected auth, and turns them into importable tools or an OpenAPI export.
- **💳 Wallet guard (v1.6)** — spending caps for agent actions. Money actions (pay / buy / checkout / subscribe, on the page or via API) are checked against a per-action cap ($25), a daily cap ($100), and an approval line ($5) *before* the approval prompt — plus an origin allowlist and a kill switch. A guard refusal is final: the agent is told not to retry or route around it. Only you can raise a cap, in Settings.
- **🌐 Mesh Mode (v2.0)** — device pairing and node management with the [Conductor Mesh](mesh/README.md) daemon over Native Messaging. The panel shows this node's root-signed identity (fingerprints only — the extension never holds keys), renders one-time **QR pairing codes** for phones and other machines, lists paired nodes, and drives chain sync and **dual-entry-proven handoffs** (HANDOFF ↔ RECEIPT hash match) over mTLS. No daemon installed? The tab shows setup steps — it never pretends.

## Local-first model routing (v1.2)

Conductor auto-detects **Ollama** on your machine (`127.0.0.1:11434`). If it's running, it's the default route:

- The header badge always shows the live route: **Private · Local (Ollama)** or **Cloud (OpenRouter)**.
- On the local route, page content **never leaves your computer**.
- Prefer a stronger cloud model? Add your own OpenRouter key (free models cost $0). Route preference lives in Settings: Auto (local first) / Local only / Cloud.
- **No silent cloud fallback — ever.** If the local route fails, the chat stops, tells you what failed, and offers *"Use cloud for this task"* as a button. Page data reaches OpenRouter only when you configured a key as your route, or flip that per-chat switch yourself.
- If your Ollama refuses direct extension connections, run the local bridge — it proxies model calls on your machine (and only ever to `127.0.0.1`; it refuses any other URL).

## Site Scanner (v1.2)

One click (**🔍 Scan site**) produces a read-only report card for the current tab: native WebMCP tools found (count + names), synthesized tool count, API endpoints known for the origin, a page inventory (forms, fields, tables, buttons, links, headings), and informational risk flags — password fields, payment-looking forms, file inputs. Scanning never executes a tool.

## Skills library (v1.2)

Skills are **your** reusable instruction packs, stored only in this browser: *Research this page*, *Extract table to JSON*, *Price watch summary*, and *Page action plan* ship as editable starters, and you can add your own (optionally scoped to one site). Activate one and it guides the chat for that conversation, visibly badged above the composer. Skills are instructions only — they never bypass the write-approval gate.

## API Vault (v1.2)

Imported API definitions stop being throwaway: they live in the **Vault**, named and persistent across tabs and restarts (add endpoints manually too — `GET /path — description`, one per line). You can also save an optional **API key per origin**:

- Keys are stored only on this device, in your Chrome profile — shown masked (last 4), revealed/copied only on your click.
- Keys are **never** in any export (MCP/OpenAPI exports are redacted — there's a unit test that proves it), and **never** sent to a model provider. The model sees tool names and schemas only.
- A key is attached to a throwaway copy of the tool at execution time, inside your tab, only for chat executions you run or approve. MCP bridge calls deliberately run **without** vault keys.
- Delete one key, or clear them all, any time.
- Honest note: Chrome profile storage is protected by your OS account; it is not a separate encrypted vault.

## Big Workspace

The side panel is for quick jobs. Click **⛶ Big window** for the full Conductor workspace: a large window with a readable 16px+ chat, a taller composer, wider step/result cards, and a two-column tools grid. The **Working on** picker at the top selects the exact browser tab Conductor should operate, so the big window can keep focus without losing the page underneath. Turn on **Follow active tab** in the compact panel when you want it to switch as you browse; leave it off in the big workspace to stay locked to one page. (v1.2 also rebuilt the toolbar popup as a proper launcher — page tools, live model route, bridge status, one click to chat — and compacted the panel chrome so the chat gets the space.)

## The MCP bridge

```
cd bridge && npm install
node conductor-bridge.mjs
```

Add that command as an MCP server in your client, enable the bridge in Conductor Settings, and any MCP host can list and call the active tab's tools. Bridge calls run **read tools freely; write tools are refused** unless you explicitly enable bridge writes in Settings. (Verified end-to-end: initialize → tools/list → tools/call relay.) The bridge also carries local model calls as a fallback transport (it only proxies to `127.0.0.1` and refuses anything else — verified).

MCP config snippet:

```json
{
  "mcpServers": {
    "conductor": {
      "command": "node",
      "args": ["/path/to/conductor/bridge/conductor-bridge.mjs"]
    }
  }
}
```

## Pricing

- **Free (beta)** — everything in this build, unlocked. Bring your own model: Ollama locally, or your own OpenRouter key (free models make it $0 to run).
- **Conductor Pro — $12/month** at launch: hosted models (no key needed), saved tool libraries across sites, team sharing, priority support. Flat price — no credits, no per-action charges.

No account. No telemetry. On the local route, nothing leaves your computer at all.

## Install (unpacked)

1. Unzip `conductor.zip`.
2. `chrome://extensions` → Developer mode → **Load unpacked** → select the `conductor` folder.
3. Pin 🎼 Conductor. Open the side panel on any page.
4. For chat: run **Ollama** (`ollama pull llama3.1:8b`) for private local chat, **or** paste an OpenRouter API key (free at openrouter.ai) in Settings.

Requires Chrome 116+.

## Demo (2 minutes)

```sh
cd demo && python3 server.py   # → http://localhost:8079/
```

The Invoice Desk is a fake business app with no API — ask Conductor to *"total the unpaid invoices"*, then *"add an invoice for Maple Dental, $450"* and watch the write gate ask first. The demo server also serves a fake checkout at `http://localhost:8079/checkout` — ask Conductor to do anything there and Takeover Mode's payment detector will stop and hand the step to you.

## Safety model — the short version

- Tools are classified **read/write** at synthesis time (heuristics documented in `src/lib.js`); misclassification fails toward *write* (asks) for anything stateful-looking.
- Your model key lives in extension storage on your machine. Captured pages, tools, and results never leave the browser except as chat context **you** send to **your** model.
- The bridge binds to `127.0.0.1` only, and ships with writes disabled.

## Honest limits

- Tool quality tracks page quality: clean semantic HTML synthesizes beautifully; div-soup apps with canvas UIs synthesize poorly (the API-import lane is the reliable path there, via API Lens).
- Elements are tracked per page load; heavy SPAs that re-render between snapshot and call can occasionally stale a click target — the agent re-reads the page and retries.
- Native WebMCP tools registered *before* Conductor's detector loads may be listed without a callable handle; a page reload fixes it.
- **Takeover detection is heuristic.** The login/CAPTCHA/payment/OTP detectors read deterministic DOM signals (field types, `autocomplete` values, known challenge-widget markup), and they *will* miss cases: canvas-drawn challenges, challenges inside closed shadow roots or cross-origin frames that expose no known markup, custom code inputs with innocuous names. The guarantee is the manual **✋ Take over** button, which works on every page, every time — the detector is a safety net, not a promise. Dismissing a detector card snoozes that signal for that page so you're never nagged twice about the same form.
- The chat loop caps at 8 model rounds per request by design.
- The bridge needs Chrome awake; MV3 service workers sleep, and the bridge reconnects automatically when the browser is active again.
- **Ollama routing is verified against a mock** implementing Ollama's API and origin policy (detection, model listing, tool-calling round-trip, failure path) plus a bridge-proxy run. Some real Ollama builds refuse browser-extension origins (`OLLAMA_ORIGINS`); if yours does, the bridge transport covers you — both paths are fully local. End-to-end proof on a real Ollama install happens on your machine.
- Vault keys rely on Chrome profile storage (see the honest note in the Vault section).

## Tests

```sh
node --test tests/lib.test.mjs   # 20 tests: synthesis, risk classes, imports, exports,
                                 # routing (local-first, no silent cloud), skills,
                                 # scanner summary, vault model + export redaction,
                                 # takeover state machine, execution gate, detector,
                                 # hand-back summary
node tests/bridge-e2e.mjs        # 5 checks: MCP relay + model-proxy allow/refuse
                                 # (needs the mock Ollama running, see below)
```

Also in `tests/`: `mock-ollama.mjs` — a mock Ollama + OpenRouter spy used to prove the routing E2E (local round-trip; kill local → user is told, **zero** cloud requests; explicit consent → cloud called once); `browser-e2e.py` — the v1.2 regression suite in a real Chromium (23 checks); `takeover-e2e.py` — the v1.3 Takeover Mode suite (28 checks: mid-round pause, refusal + logging, per-tab isolation, hand-back/resume, detector + model-requested takeover, at panel and workspace widths). Both browser suites need the demo server (`demo/server.py`) and Playwright under `xvfb-run`.

## Changelog

**v1.3.0 (2026-11-06)** — **Takeover Mode.** ✋ Take over button in the chat (panel + Big Workspace): pauses the agent mid-task, shows a persistent "You're in control" banner, and refuses every tool execution on that tab (chat, worker, and MCP bridge share one gate) until you hand back. Agent-requested takeover: a deterministic page-signal detector (payment forms, CAPTCHA widgets, OTP/2FA inputs, password sign-in forms) plus a model-callable `request_takeover` tool, both funnelling into the same request card. Hand-back takes a fresh snapshot and reports what visibly changed. Takeover is per-tab; closing the tab clears it; every start, end, and refusal lands in the Activity log. New demo fixture: a fake checkout at `/checkout`. *Store status: v1.3.0 is built and packaged locally; it will be submitted to the Chrome Web Store after the v1.2.0 review completes (v1.2.0 is in review now).*

**v1.2.0 (2026-11-06)** — First-click fix: the toolbar popup is now a real launcher (page tools, live model route, bridge status) instead of a title-only sliver, and the side panel chrome was compacted (target bar 99px → 54px) with a proper welcome state. Local-first Ollama routing with route badge and a hard no-silent-cloud-fallback rule. Fixed a v1.1 message loop (native-tool announces re-triggering tool fetches) that could wedge tool execution on "running". Site Scanner, Skills library, Activity log, API Vault. Manifest name is now "Conductor — AI Browser Agent & MCP Tools"; one new host permission: `http://127.0.0.1/*` (your own machine only — Ollama + bridge).

## Credits

Synthesis + chat + bridge are original. Sibling project: **API Lens**, the capture-side companion (record a site's API → OpenAPI/clients → import here as tools).
