# Apocentro — Project Handoff Notes

> **For a fresh Claude Code session.** This file is the single place to get
> oriented on the Apocentro project. A new session has **no memory of past
> chats** — but everything that was done lives in git (commits + PRs) and is
> summarized here. Read this first.
>
> _(ภาษาไทยสำหรับเจ้าของโปรเจกต์อยู่ท้ายไฟล์)_

---

## 1. What Apocentro is

**Apocentro** is a white‑label, closed‑ecosystem fork of the **Session** messenger.
It speaks the real Session protocol (snodes, swarms, onion routing, storage RPC)
but wraps every snode‑bound payload in **4 "magic bytes"** so that only other
Apocentro clients can read it — Session ↔ Apocentro cannot interoperate, by design.

There are **three clients**, each its own repo, all on branch
**`claude/apocentro-web-recovery-q13fec`**:

| Repo | Role | Tech |
| --- | --- | --- |
| `tineprogramming/session-web` | **Apocentro Web** (the original, most complete) | React + Vite + TS, libsodium‑wasm, Bun proxy |
| `quanturtle-founder/apocentro-android` | **Apocentro Android** (reference implementation for the protocol) | Kotlin, fork of session‑android |
| `tineprogramming/session-desktop` | **Apocentro Desktop** (most recent work) | Electron, fork of session‑desktop |

The three are interoperable because **all three wrap the same layer** — the output
of libsession's `encodeFor1o1` / `encodeForGroup` — with the same magic bytes.

---

## 2. THE MAGIC BYTES (most important invariant)

```
MAGIC_BYTES = [0x41, 0x50, 0x43, 0x01]   // "APC" + version 1
```

- **On send:** prepend the 4 bytes to the already‑encrypted, snode‑bound payload
  (the whole WebSocketMessage/envelope blob), *after* Session encryption and
  *before* base64 for the network.
- **On receive:** check the prefix; **strip it** before decrypting; **silently
  drop** anything without it (that's a non‑Apocentro / Session message).
- **Config‑namespace traffic is intentionally left UNWRAPPED** (matches Android).

**This must stay byte‑for‑byte identical across web, android, and desktop.**
Reference implementations:
- Web: `src/shared/api/magic-bytes.ts`
- Android: `com.apocentro.protocol.MagicBytes`
- Desktop: `ts/session/crypto/MagicBytes.ts` (`wrapWithMagicBytes` / `hasMagicBytes` / `stripMagicBytes`)

---

## 3. session-desktop — status (the repo with the active PR)

**Open PR:** `tineprogramming/session-desktop#1` (draft, base `dev`).
**CI:** `.github/workflows/apocentro-build.yml` builds unsigned installers
(Linux AppImage + deb, Windows NSIS, mac dmg) and uploads them as run artifacts.
**It is GREEN.** Download installers from the latest run's "Artifacts" section.

### What was done (commits, newest first)
- Remove "Session Network" item from settings
- Remove upstream Session `build-binaries.yml` workflow (replaced by apocentro-build)
- Fix `MessageSender` unit test for the magic-bytes prefix
- Keep microphone-permission toggle (voice messages need it)
- Remove remaining Session-branded UI (donate, "Voice and Video call beta" calls
  section, Session Token footer logo, onboarding SESSION logo/wordmark + FAQ link,
  installer sidebar art, "Start Session" NSIS string)
- Add apocentro-build CI; vendor the localization submodule
- Rebrand UI strings (Session → Apocentro) at one i18n chokepoint
- Replace app icons / brand art with the Apocentro logo
- Rebrand package identity (name, productName, appId `com.apocentro.desktop`, etc.)
- Add the magic-bytes closed-ecosystem layer

### Key files (desktop)
- `ts/session/crypto/MagicBytes.ts` — the protocol layer
- `ts/session/sending/MessageWrapper.ts` — wraps on send (1o1 + group)
- `ts/session/apis/snode_api/swarmPolling.ts` — `apocentroStripMagicBytes()` on receive
- `ts/localization/localeTools.ts` — `applyApocentroBrand()` inside
  `LocalizedStringBuilder.toString()` replaces the brand name for ALL strings/locales
- `package.json` build config (appId, mac/win, repository → this fork)
- `build/installer.nsh`, `build/installer-sidebar.bmp`, `build/icon*`, `images/`

### Gotchas (desktop)
- **`ts/localization` is VENDORED** (no longer a git submodule) so the rebrand is
  self-contained. `dynamic_assets` is still a submodule.
- **`noUnusedLocals` is on** — when you delete a component/usage you must also
  delete the now-unused imports/helpers or `pnpm build` (tsc) fails.
- The i18n brand swap uses `/\bSession\b/g → Apocentro` (capital-S only, so the
  common noun "session" is untouched).
- Magic bytes wrap the **whole snode payload** (`params.data`), NOT the inner
  envelope. The unit test strips at that layer; mirror that if you touch it.

### Known limitations / TODO (desktop)
- **Video preview shows audio-only / no picture** for some phone videos. This is
  an **Electron/Chromium codec limitation** (no HEVC/H.265 decode), NOT a bug —
  download works, the file is intact. Optional future work: enable HEVC or bundle
  ffmpeg (heavy; probably not worth it).
- **Code signing**: builds are unsigned. For real distribution add Apple/Windows
  certs; `win.publisherName` is set to "Apocentro" and must match the real cert if
  `verifyUpdateCodeSignature` is ever enabled.
- **Auto-update**: `repository` points at this fork so electron-builder infers the
  feed from our releases (not Session's). Confirm releases publish here.
- Branding assets are done, but `build/installer-sidebar.bmp` and icons were
  generated from the Android logo — swap if a higher-res master appears.

---

## 4. session-web — status

The original and most feature-complete client. See its **`CLAUDE.md`** for full
architecture (it is the best doc in the whole project).

- ✅ DM (text, images, files, voice), magic bytes, client-side onion routing
- ✅ Attachments (AES-CBC+HMAC), interop with Android for DMs
- ✅ Fan-out "groups v1" (web-only), notifications, failed-send retry, mobile UI
- 🚧 **Groups v2** (real Session closed groups, interop with the app): Phase 1
  (libsession-wasm integrated) and Phase 2 (decode the app's invite message) done.
  **Remaining: read the group swarm, send to it, and create groups from web.**
- Deploy: push a commit whose message contains `[deploy-server]` → GitHub Action
  SSH-deploys to the server. Live at `https://tinebritania.tinestuff.com/apocentro/`.

---

## 5. apocentro-android — status

The friend's Android app — treat it as the **protocol reference** (magic bytes,
group handling). It also holds the **brand assets**:
- `Logo/apocentro_lime_green_transparent.png` (1024, the green mark)
- `Apocentro_Logo_Design/Not_Yet_Resized/apocentrol_logo_darkgray_background_phone_APP_logo.png` (1024, the app-icon look)
- `Apocentro_Logo_Design/Resized_and_Wired/apocentro_wordmark.png` (the "Apocentro" wordmark)

These were the source for the desktop icons/brand art.

---

## 6. How to continue

1. **Pick the repo** for the task; everything is on `claude/apocentro-web-recovery-q13fec`.
2. For desktop: the PR is #1; CI builds installers automatically on push.
3. **Never break the magic-bytes invariant** — it is what makes the three clients
   a closed ecosystem. If you change wrapping on one client, change all three.
4. The biggest open feature is **Groups v2 on web** (section 4).

---

## 7. สรุปภาษาไทย (สำหรับเจ้าของโปรเจกต์)

- **Apocentro** = fork ของแอป Session แบบ "ระบบปิด" — ห่อข้อความด้วย magic bytes 4 ไบต์
  (`APC` + v1) ให้คุยกันได้เฉพาะ Apocentro ด้วยกัน (web / android / desktop)
- มี **3 repo** ทุกตัวอยู่ branch `claude/apocentro-web-recovery-q13fec`
- **Desktop (ล่าสุด):** rebrand เป็น Apocentro ครบ (ชื่อ/ไอคอน/string/ลบ Session ออกหมด:
  donate, voice-video beta, token logo, Session Network), magic-bytes interop ใช้ได้,
  มี **GitHub Action build installer ให้อัตโนมัติ (เขียวแล้ว)** — โหลด .AppImage/.exe/.dmg
  จากหน้า Actions → run ล่าสุด → Artifacts. PR คือ **#1**
- **ของที่ยังไม่เสร็จ:** วิดีโอ HEVC เปิดในแอปไม่เห็นภาพ (ข้อจำกัด Electron ไม่ใช่บั๊ก,
  download ได้), code signing, และฝั่ง **web ยังเหลือ Groups v2 (Phase 3)**
- **ห้ามแก้ magic bytes ให้ผิดเพี้ยน** — ถ้าแก้ที่ client นึงต้องแก้ให้ตรงกันทั้ง 3
