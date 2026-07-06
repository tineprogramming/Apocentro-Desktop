# Apocentro Desktop Calling — Implementation

> What actually shipped for 1:1 voice/video calling on **Apocentro Desktop**
> (the Electron fork of Session): self‑hosted Cloudflare TURN, same‑Wi‑Fi
> **LAN / offline** call signalling, an Android‑style in‑call info overlay, and
> Windows‑firewall handling. This is the "what/where/how" companion to the
> planning notes in [`APOCENTRO_CALLING_ARCHITECTURE.md`](./APOCENTRO_CALLING_ARCHITECTURE.md).
>
> **Scope: 1:1 CALL signalling only.** DM and group traffic are never routed
> through any of this — they keep using the normal Session snode/onion path.

---

## 1. What it does

- **Calls work online** over WebRTC (DTLS‑SRTP media), using **our own
  Cloudflare TURN** for relay and STUN for direct‑path discovery.
- **Calls work offline / on a LAN with no internet.** Call setup signals
  (pre‑offer / offer / answer / ICE) are delivered directly over the local
  network via mDNS discovery + a small TCP channel, so two devices on the same
  Wi‑Fi can ring and connect with no snodes and no internet.
- **Wire‑compatible with the Apocentro Android app** — same mDNS service type,
  same rotating discovery token, same TCP frame, same magic‑bytes envelope — so
  a Windows desktop and an Android phone discover and call each other.
- **The signalling is never sent in the clear.** The LAN path ships the *exact
  same* encrypted, magic‑byte‑wrapped libSession 1:1 envelope the snode path
  would; the transport just carries opaque bytes.
- **An in‑call info overlay** shows connection quality, type, latency, the
  peer's IP + country flag, and (in debug mode) live LAN/ICE diagnostics.

### LAN‑first, onion fallback

Every call signal tries the **LAN first** and falls back to the **onion/snode**
path when the peer isn't local — never both (a duplicate offer/answer/ICE breaks
WebRTC negotiation). Offline, only the LAN path is available; online with the
peer elsewhere, only onion is used; online on the same Wi‑Fi, LAN wins (fast).

---

## 2. Architecture

```
┌── Renderer (React / WebRTC / CallManager) ──────────────┐
│  CallManager.ts        call engine + signal routing      │
│  ApocentroLanCalling   LAN bridge (encrypt → send/recv)  │
│  ApocentroCallConfig   TURN/STUN ICE servers             │
│  ApocentroGeo          offline IP → country + flag       │
│  InConversationCall…   in‑call info overlay              │
└───────────────▲───────────────────────┬─────────────────┘
                │ window.apocentroLan    │ IPC (preload.js)
                │ (send/recv/rediscover) │
┌───────────────┴───────────────────────▼─────────────────┐
│  Main process (Node: net, dgram, os, child_process)      │
│  apocentro_lan.ts   mDNS (_apocentro._tcp) + TCP channel │
│  main_node.ts       IPC handlers + firewall helper       │
└──────────────────────────────────────────────────────────┘
```

The **main process** owns the network (Node `net`/mDNS — the sandboxed renderer
can't). It is **crypto‑agnostic**: the renderer hands it already‑encrypted bytes
and it hands received bytes back for the renderer to decrypt. It never sees
plaintext or keys.

---

## 3. Wire protocol (must match Android / iOS)

| Piece | Value |
|---|---|
| mDNS service | `_apocentro._tcp`, TXT record `t=<token>` |
| Service name | `apocentro-<token>` |
| Discovery token | `SHA256( utf8(pkHex) ++ int64BE(hourEpoch) )[:10]` as lowercase hex (20 chars) |
| Token epoch | `floor(now_ms / 3_600_000)` — rotates hourly; contacts matched for `{epoch‑1, epoch, epoch+1}` |
| TCP frame | `[int32 senderListeningPort][int32 payloadLen][payload]`, big‑endian |
| Payload | `wrapWithMagicBytes( libSession 1:1 ciphertext )` — magic bytes `[0x41,0x50,0x43,0x01]` |

**Contacts‑only, unlinkable discovery.** We only advertise a rotating hash of our
own pubkey, and only match tokens for pubkeys already in our contact list. A
stranger sniffing mDNS sees an opaque 10‑byte token that changes every hour and
can't be tied to an account.

**Learned peers.** When an inbound TCP frame arrives, the callee learns the
caller's address from the frame's `senderListeningPort`, so replies (answer /
ICE) reach the caller over the LAN even before mDNS resolves them in that
direction.

---

## 4. Files

### Renderer
| File | Role |
|---|---|
| `ts/session/utils/calling/CallManager.ts` | Call engine. `getApocentroIceServers()` per call; `apocentroSendCallTo1o1()` routes LAN‑first→onion; `ensurePeerDiscoveredOnLan()` before the first signal; `getApocentroCallStats()` reads WebRTC stats (type, latency, ICE state, candidate counts, local/remote addresses). |
| `ts/session/utils/calling/ApocentroLanCalling.ts` | Renderer side of the LAN bridge: starts discovery, tracks reachable peers, `trySendCallSignalOverLan()` (encrypts via `MessageWrapper` then ships bytes), `ensurePeerDiscoveredOnLan()` (active mDNS re‑query + short wait), inbound decrypt + learn‑peer. |
| `ts/session/utils/calling/ApocentroCallConfig.ts` | ICE servers from the Cloudflare TURN Worker with STUN fallback (cached hourly). `APOCENTRO_CALL_DEBUG_KEY` setting id. |
| `ts/session/utils/calling/ApocentroGeo.ts` | Offline IP → country using the bundled MaxMind `GeoLite2‑Country.mmdb`; returns the ISO code + flag emoji. |
| `ts/components/calling/InConversationCallContainer.tsx` | In‑call info overlay (see §5). |
| `ts/session/apis/snode_api/swarmPolling.ts` | `handleApocentroLanCallBytes()` — strip magic bytes, decrypt via `MultiEncryptWrapperActions.decryptFor1o1`, dispatch through the same path as a polled 1:1 message. |
| `ts/components/dialog/user-settings/pages/PrivacySettingsPage.tsx` | Settings: enable‑calls toggle, "Show call connection details" toggle, Windows firewall button. |

### Main process / bridge
| File | Role |
|---|---|
| `ts/mains/apocentro_lan.ts` | mDNS (via `bonjour-service`, one instance **per IPv4 interface** so multi‑homed Windows still discovers), TCP listener, rotating token, `rediscover()`, `learnPeer()`, `send()`, and a 5s network watcher (`checkNetworkChange()`) that rebuilds mDNS on a Wi‑Fi switch. |
| `ts/mains/main_node.ts` | IPC handlers: `apocentro-lan:{start,stop,update-contacts,learn-peer,rediscover,send}` and `apocentro-firewall:{add,status}`. |
| `preload.js` | Exposes `window.apocentroLan`, `window.apocentroAddFirewallRule`, `window.apocentroFirewallStatus`. |
| `ts/window.d.ts` | Types for the above. |
| `build/installer.nsh` | NSIS installer: adds/removes the Windows Firewall rule (see §6). |

---

## 5. In‑call info overlay

A real bar **above** the call window (a flex sibling, not an absolute overlay),
so it can never cover the call controls at the bottom, at any window height.

- **Badge colour = call quality (latency), not connection type.** Green `<150ms`,
  amber `150–300ms`, red `>300ms`, grey while connecting. A relay call with good
  latency is green — the colour answers "will this call be smooth?". The
  connection **type** ("Direct" / "Relay" / "Local network") is the badge *text*.
- **Signal bars** (0–4) also track latency (thresholds aligned with the badge).
- **Peer IP + country flag**, always shown (compact and full), like the Android
  overlay: the relay's public IP for a TURN call, otherwise the remote peer.
  The flag uses the bundled `NotoColorEmoji` font so it renders on Windows
  (whose default emoji font has no flag glyphs).
- **"Handling connection candidates N"** progress while the call is still being
  set up (the desktop equivalent of the Android setup status).
- **"Show call connection details"** setting (Privacy → Voice and Video Calls,
  default on). When off, the overlay collapses to just the badge + bars + latency
  + IP/flag (the phone‑style view); when on it also shows LAN discovery / mDNS
  count / LAN send result / connection + ICE state / candidate details — the
  offline‑call diagnostic surface.

---

## 6. Windows Firewall

Offline LAN calls need inbound access for the app (the TCP signalling listener,
WebRTC UDP media, and mDNS). Windows Firewall blocks these by default, so:

- **The NSIS installer adds the rule automatically** on install (it already runs
  elevated) and removes it on uninstall:
  `netsh advfirewall firewall add rule name="Apocentro Calls" dir=in action=allow program="<app>.exe" enable=yes profile=any`.
- **Settings has a status‑aware button** (Privacy, Windows only). It checks
  whether the rule exists (read‑only, no elevation) and shows **"Allowed"**
  (disabled) when present; only when the rule is missing does the **"Allow"**
  button trigger a single UAC‑elevated `netsh` to add it.

So most users never do anything — a fresh install is call‑ready. The button is
the manual fallback if the rule is ever missing.

---

## 7. Build / test

- **No local typecheck in the authoring sandbox** (deps can't be installed
  there). **CI (`.github/workflows/apocentro-build.yml`) is the compile/build
  gate** — it builds the Windows NSIS installer, Linux AppImage/deb, and macOS
  dmg on every push to this branch.
- New dev‑only UI strings live in `ts/localization/devStrings.ts`
  (`TokenDevNoArgs`), **not** in `generated/english.ts` (which is validated
  against the generated token union and rejects unknown keys).
- Real two‑machine LAN/offline testing (Windows ↔ Android) is done by the
  maintainer. The info overlay's LAN/mDNS/send/state lines are the field
  diagnostic for where an offline call breaks (discovery vs. send vs. media).

---

## 8. Platform notes / limitations

- **Flag emoji on Windows** require a bundled emoji font; we use `NotoColorEmoji`
  (already shipped). The regional‑indicator flag emoji would otherwise render as
  the 2‑letter country code.
- **mDNS multicast** must be allowed on the local network. If a router or
  hotspot blocks/​isolates multicast, discovery yields `mDNS 0` in the overlay —
  that's a network limitation, not a client bug.
- **The web fork** and the Android app implement the *same* wire protocol but are
  separate codebases; changes to the token/frame/magic‑bytes must stay in sync
  across all three.
