# Apocentro Calling — Architecture & Cost (1:1 + Group)

> Self-hosted, privacy-preserving voice/video calling for the Apocentro closed
> ecosystem (web, desktop, iOS, Android). Media is WebRTC P2P with E2EE;
> **signaling reuses the Session protocol** (snodes + onion routing) instead of a
> central signaling server. This doc covers both **1:1** (already ~done) and
> **group** (new), with a cost model for each.

---

> ## ✅ STATUS — planning/cost doc; **1:1 is now implemented on desktop**
> The recommendations below are largely **done**. Notably: TURN is served by our
> **Cloudflare TURN Worker** (not self‑hosted coturn); the calls toggle is
> **restored**; and **LAN‑offline call setup is built** (it was marked "defer"
> here). For what actually shipped and how, read
> [`APOCENTRO_DESKTOP_CALLING.md`](./APOCENTRO_DESKTOP_CALLING.md) and
> [`APOCENTRO_CHANGELOG.md`](./APOCENTRO_CHANGELOG.md). Group calling is still a
> future item. Treat this file as background/rationale.

---

## 0. TL;DR / Recommendation

| Topic | Recommendation |
|---|---|
| **1:1** | Re-enable the existing call stack. It is production-grade already. Just (a) restore the settings toggle and (b) repoint TURN from `*.getsession.org` → self-hosted coturn. |
| **Media mode** | **P2P by default + an "Always Relay" toggle** (Signal-style). P2P = fast/cheap but exposes IP to the peer; relay hides IP at the cost of server bandwidth. |
| **Signaling** | **Keep it on the Session protocol** (snodes). No separate WebSocket signaling server. More private than Signal/Telegram and nothing extra to run. |
| **Group ≤ 5** | **Mesh P2P** (extend the 1:1 engine). No media server, E2EE stays trivial, fits the self-host ethos. Recommended as Phase 2. |
| **Group 6+** | **SFU** (LiveKit/mediasoup/ion-sfu). Big project: heavy bandwidth, E2EE needs SFrame/Insertable Streams, needs a VPS. **Not recommended now.** |
| **LAN-offline call setup** | Defer. Signaling rides on snodes (needs internet); true offline setup would require a separate LAN signaling path. Edge case, low ROI. |

---

## 1. Goals

| # | Goal | Enabled by |
|---|------|-----------|
| 1 | Server only brokers setup, not media | WebRTC separates signaling from media |
| 2 | Low bandwidth | Media flows P2P directly (~80–85% of calls) |
| 3 | No central signaling server to run/trust | Signaling rides the Session message transport |
| 4 | E2EE | DTLS-SRTP (1:1), SFrame (group SFU, if ever) |
| 5 | Closed ecosystem | Same magic-bytes isolation as messaging |

---

## 2. What Apocentro already has (inherited from Session)

The 1:1 calling engine is **complete and production-used**. Only the enable-toggle
was removed during the Apocentro rebrand; the engine is intact.

| Piece | File (desktop) | Status |
|---|---|---|
| Call engine | `ts/session/utils/calling/CallManager.ts` | ✅ audio+video, device select, mute, camera switch via `replaceTrack`, data channel for video on/off, trickle ICE, reconnect |
| Signaling | `CallMessage` (PRE_OFFER/OFFER/ANSWER/ICE_CANDIDATES/END_CALL) over snodes | ✅ |
| Receive | `ts/receiver/callMessage.ts` | ✅ |
| UI | `ts/components/calling/*` (buttons, incoming dialog, in-call, fullscreen) | ✅ |
| State | `ts/state/ducks/call.tsx` | ✅ |
| **ICE servers** | hardcoded `turn:*.getsession.org` in `CallManager.ts` | ⚠️ **must replace with self-hosted coturn** |
| **Enable toggle** | Privacy → "Calls (Beta)" section | ❌ **removed in rebrand — must restore** |

> The "(Beta)" label is about **privacy**, not unfinished code. Session's own
> string: *"Your IP is visible to your call partner and a Session Foundation
> server while using beta calls."* That is the inherent P2P trade-off, not a bug.

---

## 3. 1:1 Architecture

### 3.1 Signaling — over the Session protocol (no signaling server)

```
Caller A                         snode swarm (onion)                     Callee B
   │                                    │                                    │
   │── CallMessage PRE_OFFER ──────────►│──────────────────────────────────►│  (ring)
   │── CallMessage OFFER (SDP) ────────►│──────────────────────────────────►│
   │◄───────────────────────────────────│◄──────── CallMessage ANSWER (SDP) ─│
   │── CallMessage ICE_CANDIDATES ─────►│──────────────────────────────────►│  (trickle)
   │◄───────────────────────────────────│◄──────── CallMessage ICE_CANDIDATES│
   │                                    │                                    │
   │════════════ DTLS-SRTP handshake (P2P, E2EE) ══════════════════════════│
   │════════════ media flows directly; snodes are out of the loop ═════════│
```

- SDP/ICE are carried as normal encrypted Session messages → snodes see only
  ciphertext, never "who is calling whom".
- No room/presence server; user discovery = existing Session ID / contacts.

### 3.2 Media path & ICE priority

WebRTC gathers candidates and auto-picks the best path:

| Candidate | What | Used when | Server BW |
|---|---|---|---|
| **host** | LAN IP | both peers on same LAN | none (direct via switch/AP) |
| **srflx** | public IP via STUN | different NATs, hole-punch OK | none (direct P2P) |
| **relay** | via TURN | hole-punch fails (symmetric NAT/strict FW) | **full media via server** |

Priority: host > srflx > relay. ~80–85% of calls stay P2P; ~15–20% need relay.

### 3.3 IP visibility (P2P) — who sees what

| Party | Sees your real IP? | Sees/hears call content? | Sees metadata (who↔who) |
|---|:---:|:---:|:---:|
| The other peer | ✅ (host + srflx) | ✅ (they are the endpoint) | — |
| STUN server | ✅ public IP | ❌ | ✅ that you're connecting |
| TURN (only if relayed) | ✅ both peers | ❌ ciphertext only | ✅ |
| ISP / on-path observer | sees a flow to peer IP | ❌ SRTP-encrypted | ✅ |
| snode (signaling) | ❌ onion + E2EE | ❌ | minimal |

**Content is end-to-end encrypted for everyone in the middle.** The only privacy
cost of P2P is that **the person you call learns your IP**.

### 3.4 The "Always Relay" toggle (Signal-style)

- **Off (default):** direct P2P — fast, cheap, peer sees your IP.
- **On:** force `iceTransportPolicy: 'relay'` — all media goes through *our* coturn;
  peers never see each other's IP. Costs server bandwidth + a little latency.
- Trade-off to document for the user: with Always-Relay on, **our coturn sees the
  call metadata** (who↔who, when, duration) — so keep coturn logging minimal.

---

## 4. Group Architecture

Apocentro has **no group-call code today** — this is genuinely new. The choice of
topology is dictated by group size.

### 4.1 Why P2P mesh doesn't scale

In a mesh, each of N participants holds N−1 peer connections and **uploads their
own stream N−1 times**:

| Participants | Uploads per client (720p ≈ 1.5 Mbps) | Verdict |
|---|---|---|
| 3 | 2 × 1.5 = 3 Mbps up | fine |
| 4 | 3 × 1.5 = 4.5 Mbps up | OK on good connections |
| 5 | 4 × 1.5 = 6 Mbps up | edge (mobile struggles) |
| 6+ | 7.5 Mbps+ up | breaks |

Client **upload** is the ceiling. Practical mesh cap ≈ **4–5** (fewer on mobile;
use SD/180–360p to push higher).

### 4.2 Two options

| | **Mesh P2P** | **SFU (Selective Forwarding Unit)** |
|---|---|---|
| Group size | ≤ 5 | 5 → 50+ |
| Media server | none | required (LiveKit / mediasoup / Janus / ion-sfu) |
| Server bandwidth | 0 | heavy, scales ~N² |
| E2EE | ✅ trivial (direct DTLS-SRTP) | ⚠️ hard — needs SFrame / Insertable Streams |
| Fits Apocentro self-host | ✅ | ❌ home uplink can't feed it; needs VPS |
| Code to write | extend the 1:1 engine to multi-peer | new client + server integration + key mgmt |
| Used by | (small-group apps) | Signal, Telegram, Discord, Zoom, Jitsi |

> Signal group calls = SFU **but still E2EE** via SFrame (very complex).
> Telegram group voice chats = SFU and **not** E2EE. This is the industry split.

### 4.3 SFU bandwidth reality (why it needs a VPS)

SFU egress ≈ `N × (N−1) × per-stream`:

| Participants | 720p (1.5 Mbps) SFU egress | Notes |
|---|---|---|
| 5 | 5 × 4 × 1.5 = **30 Mbps** | a home 20–40 Mbps uplink is already maxed |
| 10 | 10 × 9 × 1.5 = **135 Mbps** | requires datacenter; use simulcast + SD to cut |
| 20 | ~570 Mbps (mitigated by simulcast/active-speaker) | serious infra |

Mitigations real SFUs use: simulcast (multiple resolutions), active-speaker-only
video, audio-only thumbnails. Still: **groups belong on a VPS/datacenter, not the
home server.**

### 4.4 Recommendation

- **Phase 2 — Mesh, cap ~5.** Extends the existing engine, no media server, keeps
  P2P/E2EE/privacy. Covers the realistic "friends & family" group call.
- **Phase 3 (only if real demand for big rooms) — SFU on a VPS** with SFrame
  E2EE. Treat as a separate, funded project.

---

## 5. coturn (STUN + TURN) setup

```ini
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=<RANDOM_LONG_SECRET>     # used to mint ephemeral creds
realm=turn.apocentro.example
total-quota=100
stale-nonce=600
cert=/etc/letsencrypt/live/turn.apocentro.example/fullchain.pem
pkey=/etc/letsencrypt/live/turn.apocentro.example/privkey.pem
no-tcp-relay
denied-peer-ip=10.0.0.0-10.255.255.255      # block relay into internal LAN
denied-peer-ip=192.168.0.0-192.168.255.255
```

- **Ephemeral credentials:** the client must NOT ship a static TURN password.
  Mint a time-limited HMAC credential (username = `<expiry-ts>`, password =
  `base64(HMAC-SHA1(static-auth-secret, username))`). For Apocentro this can be
  computed **on-device** from a shared secret, or fetched from a tiny endpoint —
  no full signaling server needed.
- coturn is **both STUN and TURN**; for dev you can use `stun:stun.l.google.com:19302`.

### Client ICE config (replaces the getsession.org block)

```js
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:turn.apocentro.example:3478' },
    {
      urls: 'turn:turn.apocentro.example:3478',
      username: ephemeral.username,
      credential: ephemeral.password,
    },
  ],
  iceTransportPolicy: alwaysRelay ? 'relay' : 'all',
});
```

---

## 6. Comparison: Signal / Telegram / Apocentro (1:1)

| | Signal | Telegram | **Apocentro** |
|---|---|---|---|
| Media | WebRTC P2P | WebRTC P2P | WebRTC P2P |
| 1:1 E2EE | ✅ | ✅ | ✅ |
| Default | P2P (contacts) | P2P (configurable) | P2P |
| Hide-IP option | "Always Relay" toggle | Everybody / Contacts / **Nobody** | `iceTransportPolicy:'relay'` toggle |
| **Signaling** | central Signal server | central Telegram server | **snodes + onion (no central broker)** ⭐ |
| Group | SFU + SFrame (E2EE) | SFU (not E2EE) | (Phase 2 mesh / Phase 3 SFU) |

Apocentro's signaling is **more private** than both: no company server knows who
calls whom, and signaling itself hides your IP.

---

## 7. Cost Analysis

### 7.1 Assumptions / unit bandwidth

| Stream | Bitrate |
|---|---|
| Audio (Opus) | ~0.04 Mbps |
| Video 360p | ~0.5 Mbps |
| Video 720p | ~1.5 Mbps |
| Video 1080p | ~2.5–3 Mbps |

Only **egress** is billed on most clouds (~$0.01–0.09/GB); ingress is usually free.
Flat-rate VPS (e.g. Hetzner) include ~20 TB/month, making relay effectively free
up to large volumes.

### 7.2 1:1 cost

Signaling rides snodes → **$0 incremental** (already part of messaging).
Only relayed calls (~15–20%) touch the server. Per **relayed** call-hour, coturn
egress ≈ `2 × stream` (forwards both directions):

| Call type (relayed) | Server egress / call-hour |
|---|---|
| Audio only | ~0.08 Mbps → **~36 MB/hr** |
| Video 720p | ~3 Mbps → **~1.35 GB/hr** |

**Monthly example — 1,000 video call-hours/month, 20% relayed = 200 relayed hrs:**

| Hosting | Cost |
|---|---|
| Home coturn | $0 cash, but 200 × 1.35 GB ≈ **270 GB egress** + needs ~3 Mbps× concurrent uplink free |
| Budget VPS (Hetzner CX22, 20 TB incl.) | **~€4–5/mo flat** (270 GB ≪ 20 TB) |
| Metered cloud egress @ $0.02/GB | 270 GB → **~$5.40/mo** |

→ **1:1 is essentially free.** A single small VPS covers thousands of relayed
call-hours. Home-hosting works too; the only risk is home **uplink** saturating
when several relayed video calls overlap.

### 7.3 Group cost

**Mesh (≤5):** server media cost = **$0** (P2P). Cost is borne by client uplink
(see §4.1). Signaling still free (snodes). → recommended; no new hosting bill.

**SFU (if Phase 3):** server egress ≈ `N×(N−1)×stream`. Per call-hour:

| Group (720p, SFU) | Egress / call-hour | At $0.02/GB |
|---|---|---|
| 5-person | 30 Mbps → **~13.5 GB/hr** | ~$0.27/hr |
| 10-person | 135 Mbps → **~61 GB/hr** | ~$1.22/hr |

Plus an SFU instance (CPU/RAM): a LiveKit/mediasoup node handling a handful of
small rooms ≈ a **$20–80/mo VPS** (4–8 vCPU), scaling up with concurrency. Home
hosting is **not viable** for SFU (uplink + sustained load).

**Group cost summary:**

| Option | Hosting / month | Scales to |
|---|---|---|
| Mesh ≤5 | **$0** (P2P) | ~5 people |
| SFU small | **$20–80 VPS** + ~$0.27/call-hr egress | 5–20 people |
| SFU large | dedicated/datacenter, $100s+ | 50+ |

### 7.4 Bottom line

| Scenario | Realistic monthly cost |
|---|---|
| **1:1 only (recommended start)** | **~$5 VPS** for coturn, or $0 home-hosted |
| **1:1 + mesh group ≤5** | **same ~$5** (mesh adds no server cost) |
| **+ SFU groups** | **+$20–80+ VPS** and ongoing egress; reconsider self-host ethos |

---

## 8. Phased Roadmap

| Phase | Scope | Effort | Hosting |
|---|---|---|---|
| **1** | Desktop 1:1: restore Calls toggle, make iceServers configurable, add Always-Relay (default P2P), rebrand the IP warning | Low (re-enable + config) | none (STUN-only to test) |
| **2** | Stand up coturn (self-host + ephemeral HMAC) | Low–Med | ~$5 VPS or home |
| **3** | Roll 1:1 out to web → iOS → Android (repoint TURN + restore UI) | Med | same coturn |
| **4** | Mesh group ≤5 (extend engine, multi-peer UI) | Med–High | none |
| **5** | *(optional)* SFU groups + SFrame E2EE | High | VPS/datacenter |

---

## 9. Open Decisions

1. **Max group size?** ≤5 → mesh only (cheap). 6+ → commit to SFU (Phase 5).
2. **Always-Relay default?** Off (P2P, expose IP) vs On (hide IP, pay bandwidth).
   Recommended: **off by default, toggle available**.
3. **coturn location:** home server vs VPS (VPS better if users are remote —
   lower relay latency and protects home uplink).
4. **Ephemeral TURN creds:** computed on-device from a shared secret, or via a
   tiny mint endpoint?
5. **Client rollout order:** desktop first (recommended), then web/iOS/Android.
6. **Recording/persistence?** Any recording requires touching media = breaks E2EE.
   Recommended: **no**.

---

## 10. Security / E2EE notes

- **1:1:** DTLS-SRTP is mandatory in-spec → true end-to-end; no middle party
  (including our coturn) can decrypt. TURN relays ciphertext only.
- **Signaling must stay on the Session encrypted transport** (it already is) — this
  protects the SDP/ICE (which contain IPs and keys) and hides call metadata.
- **Group via SFU is NOT E2EE by default** — the SFU sees decrypted media unless
  SFrame/Insertable-Streams frame encryption is added. Mesh group stays E2EE for
  free. This is the single biggest reason to prefer mesh while groups are small.
