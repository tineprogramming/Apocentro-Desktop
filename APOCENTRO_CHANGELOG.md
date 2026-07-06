# Apocentro Desktop — Changelog

Notable Apocentro‑specific changes to the desktop client (the Electron fork of
Session). Newest first. For architecture/how‑to see
[`APOCENTRO_DESKTOP_CALLING.md`](./APOCENTRO_DESKTOP_CALLING.md) and
[`APOCENTRO_NOTES.md`](./APOCENTRO_NOTES.md).

---

## 2026‑07‑06 — 1:1 Calling: TURN + LAN/offline + in‑call overlay

Brought desktop calling to parity with the Apocentro Android/iOS apps. Merged to
the `apocentro-desktop` branch (PR #2). Scope is **1:1 call signalling only** —
DM/group traffic is untouched.

### Calling — transport & routing
- **Self‑hosted TURN.** Replaced the hard‑coded `turn:*.getsession.org` ICE
  servers with short‑lived credentials minted by our Cloudflare TURN Worker,
  fetched per call (5s timeout, hourly cache) with a public‑STUN fallback.
  `createOrGetPeerConnection` is now async. (`ApocentroCallConfig.ts`)
- **LAN / offline call signalling.** Two devices on the same Wi‑Fi can ring and
  connect with no internet: mDNS discovery (`_apocentro._tcp`, contacts‑only,
  hourly‑rotating token) + a TCP signalling channel in the Electron **main**
  process, bridged to the renderer over IPC. Byte‑compatible with the Android
  `LanDiscoveryManager`/`LanSignalingChannel`. (`ts/mains/apocentro_lan.ts`,
  `ApocentroLanCalling.ts`, `main_node.ts`, `preload.js`)
- **LAN‑first, onion fallback** for every call signal (offer/answer/ICE/pre‑offer)
  — never both (a duplicate breaks WebRTC negotiation). The LAN path ships the
  *same* magic‑byte‑wrapped libSession 1:1 envelope the snode path would; the
  transport only carries opaque bytes. (`CallManager.apocentroSendCallTo1o1`)
- **Learned peers** — a callee learns the caller's address from the inbound TCP
  frame, so answer/ICE reach the caller over the LAN before mDNS resolves them.
- **Faster online LAN calls.** Before the first signal, `ensurePeerDiscoveredOnLan`
  fires an active mDNS re‑query and briefly waits for the peer, so a same‑Wi‑Fi
  call takes the fast LAN path instead of racing discovery and falling to onion.
- **Multi‑interface mDNS** — one instance bound per IPv4 interface, so multi‑homed
  Windows (VPN/Hyper‑V/virtual adapters) still discovers the real Wi‑Fi.
- **Receive path** — `handleApocentroLanCallBytes` strips magic bytes, decrypts
  via `MultiEncryptWrapperActions.decryptFor1o1`, and dispatches through the same
  path as a polled 1:1 message. (`swarmPolling.ts`)

### Calling — in‑call info overlay
- A **real bar above the call window** (a flex sibling, not an absolute overlay)
  so it can never cover the call controls, at any window height.
- **Badge colour = latency (call quality):** green `<150ms` / amber `150–300ms`
  / red `>300ms` / grey while connecting. The connection **type** ("Direct" /
  "Relay" / "Local network") is the badge *text*, not its colour.
- **Peer IP + country flag** always shown (compact and full), like the Android
  overlay — offline `GeoLite2` lookup; the flag uses the bundled `NotoColorEmoji`
  font so it renders on Windows. (`ApocentroGeo.ts`)
- **"Handling connection candidates N"** ICE setup progress while connecting.
- **"Show call connection details"** setting (default on): off = just badge +
  bars + latency + IP/flag (phone‑style); on = also LAN/mDNS/send/ICE
  diagnostics.

### Calling — Windows firewall
- The **NSIS installer** adds an inbound allow‑rule for the app on install (and
  removes it on uninstall) so offline LAN calls work without disabling the
  firewall. (`build/installer.nsh`)
- A **status‑aware Settings button** (Privacy, Windows only): shows "Allowed"
  (disabled) when the rule exists, else a one‑UAC‑prompt "Allow". (`main_node.ts`
  `apocentro-firewall:{add,status}`)

### Calling — settings & UI wording
- Restored the **"Voice and Video Calls"** enable toggle (removed in the rebrand)
  and matched the Android wording (dropped the "(Beta)" label).

### Stability
- **Fixed an app crash on Wi‑Fi change** — mDNS sockets bound to a
  disappearing interface IP threw an unhandled `EADDRNOTAVAIL`. Now every Bonjour
  instance has an error callback, and a 5s network watcher rebuilds mDNS when the
  interface set changes.

### Build / docs
- Added `bonjour-service`; the CI setup uses `pnpm install --no-frozen-lockfile`.
- New dev‑only UI strings live in `ts/localization/devStrings.ts` (not
  `generated/english.ts`, which rejects unknown tokens).
- Added `APOCENTRO_DESKTOP_CALLING.md` (implementation reference).

### Repo housekeeping
- Consolidated the desktop mainline onto a clearly‑named **`apocentro-desktop`**
  branch (was the auto‑generated `claude/apocentro-web-recovery-q13fec`) and set
  it as the repository default.
