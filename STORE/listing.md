# Conductor — Chrome Web Store listing pack (v1.2.0)

Prepared for the parent agent's Store submission. Publisher account:
kdoherty686@gmail.com (same as Agent Wallet). Package: `~/workspace/conductor-store.zip`
(manifest.json at zip root, verified).

## Listing fields

- **Title (exact, Kevin-decided):** Conductor — AI Browser Agent & MCP Tools
- **Summary / manifest description (112 chars, limit 132):**
  "Turn any website into MCP tools and drive it by chat. Reads run free, writes ask first. Local-first with Ollama."
- **Category:** Productivity (fallback: Developer Tools)
- **Language:** English

## Detailed description (paste-ready)

Turn any website into tools — then drive it by chat.

Conductor looks at the page you're on and builds a toolset from it: native WebMCP tools when a site publishes them, and synthesized tools (extract text, read tables, fill forms, click, search) from the page itself when it doesn't. Import an OpenAPI spec (it pairs with API Lens) and those endpoints become tools too. Everything is exposed to any MCP client through a local bridge, so Hermes, Claude, or your own agents can drive your real, logged-in browser session.

LOCAL-FIRST BY DESIGN
Run Ollama on your machine and chat runs 100% locally — page content never leaves your computer, and the route badge in the header always shows where your data is going: "Private · Local (Ollama)" or "Cloud (OpenRouter)". Prefer a stronger cloud model? Bring your own OpenRouter key. There is NO silent cloud fallback: if the local route fails, Conductor stops and asks. Page data reaches the cloud only when you choose it.

SAFE BY DEFAULT
• Read tools run free; every write, submit, or purchase stops for your approval first.
• A built-in Activity log shows every tool call, approval, and route change.
• A one-click Site Scanner reports what a page exposes — tools, forms, tables, and risk flags like password fields and payment forms — without executing anything.
• An API Vault keeps your imported API definitions and optional per-site API keys on this device only. Keys are never exported, never sent to a model, and are attached only when a tool runs in your own tab.
• A Skills library lets you save reusable instruction packs ("Research this page", "Extract table to JSON", and your own) that guide the chat — they never bypass the approval gate.

PRICING — HONEST AND FLAT
Free while in beta: every feature unlocked, bring your own model (local or your own key). Conductor Pro at launch is a flat $12/month — no credits, no per-action charges.

No account. No telemetry. Your keys stay in your browser.

## Screenshots (1280×800, real captures of the v1.2.0 build)

1. `~/workspace/conductor/audit/store-shot-1-workspace-chat.png` — Big Workspace chat on the local route, live tool round-trip.
2. `~/workspace/conductor/audit/store-shot-2-workspace-tools.png` — Tools view: the toolset Conductor built from the demo page.
   (Working copies also in `audit/` as after-full.png etc. Upload the two store-shot files.)

## Permission justifications (Store review form)

- **storage** — Saves the user's settings, skills, activity log, and API Vault (API definitions + optional keys) locally in chrome.storage.local. Nothing is synced or transmitted.
- **tabs** — The user picks which open tab Conductor should operate ("Working on" picker); tools are built per tab.
- **sidePanel** — The chat UI is a side panel.
- **host: http://127.0.0.1/*** — Talks to the user's own local services on their machine only: Ollama (local models, port 11434) and Conductor's local MCP bridge (port 8787). This is the local-first guarantee; no remote server is contacted except OpenRouter, and only with the user's own key when the user selects the cloud route.
- **content scripts on <all_urls>** — Conductor's purpose is to build tools from whatever page the user is on; it reads page structure (forms, tables, buttons, links) and executes actions the user requested/approved. (Expect the in-depth review warning, same as Agent Wallet; justification is this paragraph.)

## Privacy practices (form answers)

- Single purpose: turn web pages into agent tools and operate them by chat, under the user's control.
- Data collected: **None** by the developer. No analytics, no telemetry, no remote logging.
- User data handling: page content is processed locally in the browser. It is sent to a model provider ONLY when the user selects the cloud route (OpenRouter, with the user's own API key). On the local route (Ollama), nothing leaves the device.
- API keys the user saves (OpenRouter key; optional per-origin keys in the API Vault) are stored only in chrome.storage.local on the user's device, are never exported, and are never transmitted to the developer.
- No sale/transfer of user data. No use of data for purposes unrelated to the single purpose. No human review of user data by the developer (the developer receives nothing).
- Remote code: **No** — all code is in the package (MV3).
- Privacy policy URL: **needed** — host the policy text below and paste its URL (suggestion: publish `privacy-policy.html` in the public EdgeAgent repo for Conductor, same pattern as Agent Wallet's rawcdn.githack link).

## Privacy policy (host this text)

Conductor — Privacy Policy

Conductor is a browser extension that turns web pages into tools and operates them by chat under your control.

What Conductor stores: your settings, your skills, your activity log, and — if you use the API Vault — API definitions and any API keys you choose to save. All of this is stored only in your browser's local extension storage (chrome.storage.local) on your device. It is not synced, not backed up by us, and not transmitted to us. We operate no servers and receive none of your data.

What leaves your device: only what you direct. If you use the local model route (Ollama), page content never leaves your computer. If you choose the cloud route, chat content is sent to OpenRouter using your own API key, subject to OpenRouter's privacy policy. Conductor never sends your saved API Vault keys to any model provider; a vault key is attached only to requests to that key's own origin, executed in your own browser tab.

What we collect: nothing. No analytics, no telemetry, no crash reports, no advertising identifiers.

Contact: hello@agencylead.ca

---

## Release notes — v1.4.0 (BUILT 2026-11-08, package ready, submission waits for v1.3.0 review to clear)

NEW — Session Journal (the Flight Recorder module, folded into Conductor per the suite decision):
- Tamper-evident, hash-chained journal of Conductor activity: tool calls, approvals, denials, scans, takeovers — plus, while a watch session is armed, tab opens/closes/navigations.
- Arm a watch session to snapshot your tabs; one-click Restore closes tabs opened since and reopens the snapshot (URL-matched, survives restarts), with the exact plan shown for confirmation first.
- Export the chain as a JSON receipt or a printable HTML report. Chain verification status is shown in the Journal tab.
- No new permissions. No data collected — the journal lives only in chrome.storage.local on the user's device. Form values, cookies and page content are never journaled.

Package: ~/workspace/conductor-store-v1.4.0-ready.zip (manifest 1.4.0, same 25 files as v1.3.0 package). Tests: 24/24 unit (incl. SHA-256 vs node:crypto vectors, chain tamper, restore planner). Live Chromium proof: arm → tab events → chain verified, head dc16bf9918b9…, UI screenshot STORE/screenshot-v14-journal.png.

At submission time: (1) upload the v1.4.0 zip as an update to item gfbfkjbimihafobafnnnbncgjepccafe; (2) add one line to the privacy policy (kevin-doherty.com/conductor-privacy) noting the session journal is stored locally like the activity log; (3) upload the staged media (3 new screenshots + marquee tile) in the same pass; (4) if any NEW privacy/data question appears, STOP and ask Kevin (factory rule).

---

## Release notes — v1.5.0 (BUILT 2026-11-08, package ready; SUBMITS INSTEAD OF v1.4.0 when the v1.3.0 review clears — v1.5.0 contains the v1.4 Journal plus Lens, one review instead of two)

NEW — API Lens module (the standalone API Lens, folded into Conductor per the suite decision):
- Record the bound page's fetch/XHR/sendBeacon calls from the Tools tab; calls are grouped live into templated endpoints (e.g. GET /api/products/{id}) with status counts and detected auth type.
- One click turns endpoints into callable Conductor tools (through the existing OpenAPI import path, saved in the API Vault); or export the capture as an OpenAPI 3.1 spec.
- Secrets are redacted before anything is stored: sensitive headers and secret-shaped body keys are replaced with •••redacted•••. Recording intent is per-tab, owned by the service worker, and survives page reloads. Recording is off unless the user switches it on for that page.
- No new permissions (rides the existing content-script registration).

Package: ~/workspace/conductor-store-v1.5.0-ready.zip (manifest 1.5.0). Tests: 28/28 unit. Live Chromium proof: armed recording, reloaded a test shop page — 3 calls captured, grouped to 2 endpoints, bearer token + body password verified redacted, Make Tools produced get_api_products_id (READ) + post_api_orders (WRITE) alongside DOM tools (STORE/screenshot-v15-lens.png).

Submission plan when the v1.3.0 review resolves: upload v1.5.0 zip to item gfbfkjbimihafobafnnnbncgjepccafe (skip the separate v1.4.0 submission — it is inside v1.5.0), add the privacy-policy line covering BOTH the session journal and Lens recording (local storage only, redacted, off by default), upload staged media (3 screenshots + marquee; add screenshot-v14-journal.png and screenshot-v15-lens.png to the set), STOP and ask Kevin if any new privacy/data question appears.

---

## Release notes — v1.6.0 (BUILT 2026-11-08, package ready; THIS is now the submit candidate when the v1.3.0 review clears — contains v1.4 Journal + v1.5 Lens + v1.6 Wallet guard)

NEW — Wallet guard module (Agent Wallet's policy engine, folded into Conductor per the suite decision):
- Every money action (pay / buy / checkout / subscribe / order — DOM clicks, form submits, and API calls to payment-shaped endpoints) is checked BEFORE the approval prompt: per-action cap $25, daily cap $100, approval line $5 (all adjustable in Settings → Wallet guard), origin allowlist with allowlist-only mode, and a kill switch that freezes all spending.
- A guard refusal is final — the agent is told not to retry or route around it; only the user can raise a cap. Above the approval line, the approval card shows the amount plus today's spend against the daily cap. Approved spends are recorded in a local ledger and in the Journal.
- The guard never holds payment details; it checks amounts, caps and switches only. No new permissions.

Package: ~/workspace/conductor-store-v1.6.0-ready.zip (manifest 1.6.0). Tests: 32/32 unit. Live Chromium proof: $49.99 pay click denied against the $25 cap in the real extension, $2 tip passed, Settings block renders and a cap change persisted across reload (STORE/screenshot-v16-wallet.png).

Submission plan (supersedes the v1.5 plan): when the v1.3.0 review resolves — upload the v1.6.0 zip, extend the privacy line to cover journal + Lens + wallet ledger (all local-only), upload staged media incl. the Journal/Lens/Wallet screenshots, STOP and ask Kevin on any new privacy/data question.

---

## Release notes — v2.1.0 (BUILT 2026-11-08, package ready; THIS is now the submit candidate when the v1.3.0 review clears — contains v1.4 Journal + v1.5 Lens + v1.6 Wallet guard + v2.0 Mesh Mode + v2.1 Usage & Traces)

NEW — Usage & Traces: every model call is counted at the worker (the one choke point all chat calls pass). Tokens in/out + estimated cost per call from a dated reference price table (USD/1M, Settings-overridable per model; local Ollama always $0; unknown models count tokens, cost shows —). Header chip shows today's running total. Settings → "Model usage & pricing": today / last 7 days / all-time buckets, per-model rows, recent-calls list, custom price editor, reset. Each agent round also writes a 💭 trace entry (model · tokens · cost · the model's own words) into Activity AND the Journal chain — moves, thoughts and direction tracked over time.
Packages: ~/workspace/conductor-store-v2.1.0-ready.zip (manifest 2.1.0). Extension unit tests 36/36. Live proof 2026-11-08 (STORE/screenshot-v21-usage.png): a real call through a local OpenAI-compatible endpoint was recorded by the worker (12.4k in / 3.1k out, $0.00 local), the chip updated, the trace landed in Activity and in the journal chain, and seeded cloud records priced correctly (gpt-4o-mini $0.00372) with an unpriced-call flag.
Submission plan (supersedes the v2.0.0 plan below): when the v1.3.0 review resolves — upload the v2.1.0 zip, update the privacy policy to cover journal + Lens + wallet ledger + Mesh + usage stats (all local-only), upload staged media incl. Journal/Lens/Wallet/Mesh/Usage screenshots, STOP and ask Kevin on any new privacy/data question (nativeMessaging justification is the expected question).

## Release notes — v2.0.0 (BUILT 2026-11-08, package ready; superseded by v2.1.0 above — contains v1.4 Journal + v1.5 Lens + v1.6 Wallet guard + v2.0 Mesh Mode)

NEW — Mesh Mode (blueprint §11): device pairing + node management with the local mesh daemon (~/workspace/mesh-daemon, its own README):
- New 🌐 Mesh tab: daemon connection status, this node's identity (cert + root fingerprints — never keys), paired-node list with per-node Sync / Handoff actions, and the receipt chain as a handoff log.
- **Pairing by QR**: the panel renders a QR code carrying the daemon's one-time pairing payload (10-minute, single-use token in the URL fragment). The joining device generates its own identity key and submits only its public key; the daemon root-signs it into a mesh certificate. Private keys never leave their device.
- **Companion app**: the daemon serves a mobile companion page at the pairing URL — enrolls the phone, then shows live desktop-node status (chain head + verification), the peer list, and can trigger a handoff whose dual-entry receipt (HANDOFF ↔ RECEIPT hash match) is verified and displayed.
- **Node sync**: daemons pair the same way, then sync receipt chains and exchange handoffs over **mTLS** with certificate-fingerprint pinning (CA chain validated by TLS; identity = the fingerprint, not the address).
- New permission: **nativeMessaging** (the ONLY new permission since v1.2; expect it to be called out in review — justification: Mesh Mode talks to the user's own local daemon; no data leaves the machine except to nodes the user paired). The extension itself holds no keys and cannot enroll anything on its own — no daemon installed = the Mesh tab shows setup steps.

Packages: ~/workspace/conductor-store-v2.0.0-ready.zip (manifest 2.0.0). Extension unit tests 32/32 (Mesh logic lives in the daemon, proven live). Live proofs 2026-11-08 (screenshots STORE/screenshot-v20-mesh.png + screenshot-v20-companion.png): native messaging status through the real service worker; two daemons paired via the claim flow, mTLS sync (peer chain verified), handoff dual-entry matchHandoff=true verified independently from both chain files; panel QR pairing completed by a phone-sized browser context which then triggered a proven handoff from its own UI.

Submission plan (supersedes all earlier): when the v1.3.0 review resolves — upload the v2.0.0 zip, update the privacy policy to cover journal + Lens + wallet ledger + Mesh (all local / user-paired nodes only), upload staged media incl. Journal/Lens/Wallet/Mesh screenshots, STOP and ask Kevin on any new privacy/data question (nativeMessaging justification is the expected question).
