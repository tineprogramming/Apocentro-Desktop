# Apocentro Desktop

**Apocentro Desktop** is a white‑label, closed‑ecosystem fork of
[Session Desktop](https://github.com/session-foundation/session-desktop) (the
Electron messenger). It speaks the real Session protocol — snodes, swarms, onion
routing, storage RPC — but wraps every payload in **4 "magic bytes"** so only
other **Apocentro** clients (desktop, web, Android) can read it. Session ↔
Apocentro cannot interoperate, by design.

> Built on Session Desktop. Not affiliated with or endorsed by the Session
> Technology Foundation.

## Get it

Builds are produced by CI (`.github/workflows/apocentro-build.yml`) as unsigned
installers — **Windows** (NSIS `.exe`), **Linux** (`.AppImage` / `.deb`) and
**macOS** (`.dmg`). Download them from the **Actions → latest run → Artifacts**
section. (The builds are currently unsigned; the upstream Session
signature‑verification flow does not apply.)

## What's different from Session

- **Closed ecosystem** — the 4‑byte magic prefix (`APC` + v1) isolates Apocentro
  traffic. See [`APOCENTRO_NOTES.md`](./APOCENTRO_NOTES.md).
- **1:1 voice/video calling** — self‑hosted Cloudflare TURN, plus same‑Wi‑Fi
  **LAN / offline** call signalling (ring + connect with no internet), an
  Android‑style in‑call info overlay, and Windows‑firewall handling. See
  [`APOCENTRO_DESKTOP_CALLING.md`](./APOCENTRO_DESKTOP_CALLING.md).
- Full Apocentro rebrand (name, icons, strings) and group sub‑admin tweaks.

### Apocentro docs

| Doc | What it covers |
| --- | --- |
| [`APOCENTRO_NOTES.md`](./APOCENTRO_NOTES.md) | **Read this first** — project handoff / orientation (all three clients, magic bytes, status). |
| [`APOCENTRO_DESKTOP_CALLING.md`](./APOCENTRO_DESKTOP_CALLING.md) | Calling implementation — architecture, wire protocol, files, overlay, firewall. |
| [`APOCENTRO_CHANGELOG.md`](./APOCENTRO_CHANGELOG.md) | Dated log of Apocentro‑specific changes. |
| [`APOCENTRO_CALLING_ARCHITECTURE.md`](./APOCENTRO_CALLING_ARCHITECTURE.md) | Calling design & cost notes (background/rationale). |

## About Session (upstream)

Session integrates directly with [Oxen Service Nodes](https://docs.oxen.io/about-the-oxen-blockchain/oxen-service-nodes),
a set of distributed, decentralized and Sybil‑resistant nodes that store messages
offline and provide onion routing to obfuscate users' IP addresses. For a full
understanding of how the underlying protocol works, read the
[Session Whitepaper](https://getsession.org/whitepaper).

## Build instructions

Build instructions can be found in [Contributing.md](CONTRIBUTING.md).

## License

This project is a fork of Session Desktop and remains under the **GPLv3**.

Copyright 2011 Whisper Systems

Copyright 2013-2017 Open Whisper Systems

Copyright 2019-2024 The Oxen Project

Copyright 2024-2025 Session Technology Foundation

Copyright 2025 Apocentro (fork modifications)

Licensed under the GPLv3: https://www.gnu.org/licenses/gpl-3.0.html

## Attributions

The IP-to-country mapping data used in this project is provided by [MaxMind GeoLite2](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data).

This project uses the [Lucide Icon Font](https://lucide.dev/), which is licensed under the [ISC License](./third_party_licenses/LucideLicense.txt).
