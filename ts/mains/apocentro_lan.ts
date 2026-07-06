/**
 * Apocentro LAN calling — main-process transport (Electron / Node).
 *
 * Runs in the MAIN process because it needs Node's `net`, `os` and mDNS
 * (which the sandboxed renderer cannot use). It is crypto-agnostic: the
 * renderer produces the already-encrypted, magic-byte-wrapped 1:1 payload and
 * hands it here for LAN transport; incoming bytes are handed back to the
 * renderer to strip + decrypt. So this file never sees plaintext or keys.
 *
 * Wire protocol — MUST stay byte-for-byte identical to Android
 * (`LanDiscoveryManager` / `LanSignalingChannel`) and the iOS plan §4:
 *   - mDNS service type `_apocentro._tcp`, TXT `t=<token>`.
 *   - token = SHA256( utf8(pkHex) ++ int64BE(hourEpoch) )[:10]  (hex, 20 chars).
 *   - TCP frame (big-endian): [int32 senderListeningPort][int32 payloadLen][payload].
 *
 * The renderer bridges to this over IPC (see main_node.ts + preload.js).
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { createServer, connect, Server, Socket } from 'net';
import { networkInterfaces } from 'os';
import { Bonjour, Browser, Service } from 'bonjour-service';

const SERVICE_TYPE = 'apocentro'; // → _apocentro._tcp
const ATTR_TOKEN = 't';
const EPOCH_MS = 3_600_000; // rotate the discovery token hourly
const TOKEN_BYTES = 10;
const CONNECT_TIMEOUT_MS = 700;
const UNREACHABLE_TTL_MS = 30_000;
const MAX_FRAME_BYTES = 256 * 1024;

type PeerAddr = { host: string; port: number };
export type DiscoveredPeer = { pubkey: string; host: string; port: number };
export type IncomingLanFrame = { payloadBase64: string; host: string; senderPort: number };

function currentEpoch(): number {
  return Math.floor(Date.now() / EPOCH_MS);
}

function int64BE(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(value));
  return buf;
}

/** token = SHA256( utf8(pkHex) ++ int64BE(epoch) )[:10] as lowercase hex. */
function tokenFor(pkHex: string, epoch: number): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(pkHex, 'utf8'), int64BE(epoch)]))
    .digest()
    .subarray(0, TOKEN_BYTES)
    .toString('hex');
}

function ourIpv4s(): Array<string> {
  const out: Array<string> = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) {
        out.push(info.address);
      }
    }
  }
  return out;
}

class ApocentroLan extends EventEmitter {
  // One (Bonjour, publish, browse) per local IPv4 interface: on multi-homed
  // Windows the default mDNS socket often binds to the wrong adapter (VPN /
  // Hyper-V / virtual), so nothing on the real Wi-Fi is ever seen. Binding one
  // instance per interface covers them all.
  private bonjours: Array<Bonjour> = [];
  private publisheds: Array<Service> = [];
  private browsers: Array<Browser> = [];
  private server: Server | null = null;
  private servicesSeen = 0;

  private ourPubKey: string | null = null;
  private tcpPort = 0;
  private running = false;

  // contact token index: token -> pubkey, for epoch in {now-1, now, now+1}
  private contactTokenIndex = new Map<string, string>();
  private contactPubKeys: Array<string> = [];

  // discovered (via mDNS) + learned (via inbound TCP, keyed after the renderer decrypts)
  private discoveredPeers = new Map<string, PeerAddr>();
  private learnedPeers = new Map<string, PeerAddr>();

  // address -> expiry time; addresses that recently failed to connect
  private unreachable = new Map<string, number>();
  private rotateTimer: NodeJS.Timeout | null = null;
  private rebrowseTimer: NodeJS.Timeout | null = null;
  private netWatchTimer: NodeJS.Timeout | null = null;
  private currentIps: Array<string> = [];

  private log(message: string): void {
    // eslint-disable-next-line no-console
    console.log(`[ApocentroLan] ${message}`);
    this.emit('log', message);
  }

  public async start(ourPubKey: string, contactPubKeys: Array<string>): Promise<void> {
    if (this.running) {
      this.updateContacts(contactPubKeys);
      return;
    }
    this.ourPubKey = ourPubKey;
    this.contactPubKeys = contactPubKeys;
    this.rebuildTokenTables();

    await this.startTcpServer();
    const ownToken = tokenFor(ourPubKey, currentEpoch());
    this.log(
      `start: me=${ourPubKey.slice(0, 8)}… token=${ownToken} tcpPort=${this.tcpPort} contacts=${contactPubKeys.length} ips=${ourIpv4s().join(',')}`
    );

    this.currentIps = ourIpv4s();
    // Create one instance bound to each interface; fall back to a default
    // instance if we can't enumerate any IPv4. IMPORTANT: pass an error callback
    // — without one, bonjour-service rethrows mDNS socket errors (e.g. a dgram
    // EADDRNOTAVAIL when the Wi-Fi changes and an interface IP disappears), which
    // crashes the whole app. With it, we just log and keep running.
    const optsList: Array<Record<string, unknown>> = this.currentIps.length
      ? this.currentIps.map(ip => ({ interface: ip }))
      : [{}];
    this.bonjours = optsList.map(
      opts =>
        new Bonjour(opts, (err: Error) => this.log(`mDNS socket error (ignored): ${err.message}`))
    );
    this.log(
      `created ${this.bonjours.length} mDNS instance(s) on: ${this.currentIps.join(', ') || 'default'}`
    );
    this.advertise();
    this.startBrowsing();

    // Watch for network changes (Wi-Fi switch): when our interface set changes,
    // rebuild the mDNS instances so we bind the new interface and stop touching
    // the old (now-invalid) one.
    this.netWatchTimer = setInterval(() => this.checkNetworkChange(), 5_000);

    // Re-advertise + rebuild the contact index each hour when the token rotates.
    this.rotateTimer = setInterval(() => {
      this.rebuildTokenTables();
      this.advertise();
    }, EPOCH_MS);

    this.running = true;
  }

  public stop(): void {
    this.running = false;
    if (this.rotateTimer) {
      clearInterval(this.rotateTimer);
      this.rotateTimer = null;
    }
    if (this.rebrowseTimer) {
      clearInterval(this.rebrowseTimer);
      this.rebrowseTimer = null;
    }
    if (this.netWatchTimer) {
      clearInterval(this.netWatchTimer);
      this.netWatchTimer = null;
    }
    this.browsers.forEach(b => {
      try {
        b.stop();
      } catch {
        /* ignore */
      }
    });
    this.browsers = [];
    this.bonjours.forEach(bonjour => {
      try {
        bonjour.unpublishAll(() => bonjour.destroy());
      } catch {
        /* ignore */
      }
    });
    this.bonjours = [];
    this.publisheds = [];
    this.servicesSeen = 0;
    try {
      this.server?.close();
    } catch {
      /* ignore */
    }
    this.server = null;
    this.discoveredPeers.clear();
    this.learnedPeers.clear();
    this.unreachable.clear();
    this.contactTokenIndex.clear();
  }

  public updateContacts(contactPubKeys: Array<string>): void {
    this.contactPubKeys = contactPubKeys;
    this.rebuildTokenTables();
  }

  /** Renderer calls this after it decrypts an inbound frame and learns the sender pubkey. */
  public learnPeer(pubkey: string, host: string, port: number): void {
    if (pubkey && host && port > 0) {
      this.learnedPeers.set(pubkey, { host, port });
    }
  }

  /** Attempt to deliver `payload` to a contact over the LAN. Resolves false on any failure. */
  public async send(
    toPubKey: string,
    payload: Buffer
  ): Promise<{ ok: boolean; detail: string }> {
    const addr = this.discoveredPeers.get(toPubKey) || this.learnedPeers.get(toPubKey);
    if (!addr) {
      this.log(`send to ${toPubKey.slice(0, 8)}…: no LAN address known → onion fallback`);
      return { ok: false, detail: 'no address' };
    }
    const key = `${addr.host}:${addr.port}`;
    // mDNS-discovered and learned peers are, by definition, on the local network,
    // so we just try to connect (no subnet pre-check — that was rejecting valid
    // peers when os.networkInterfaces() reports family as a number, or on IPv6).
    // The negative cache still avoids hammering a genuinely dead address.
    const until = this.unreachable.get(key);
    if (until && until > Date.now()) {
      this.log(`send to ${toPubKey.slice(0, 8)}…: ${key} recently failed → onion fallback`);
      return { ok: false, detail: `${key} cached-unreachable` };
    }
    this.unreachable.delete(key);

    const ok = await this.sendFrame(addr, payload);
    this.log(
      `send to ${toPubKey.slice(0, 8)}… over LAN ${key}: ${ok ? 'OK' : 'FAILED → onion fallback'}`
    );
    return { ok, detail: ok ? `${key}` : `${key} connect failed` };
  }

  // ---- internals ---------------------------------------------------------

  private rebuildTokenTables(): void {
    this.contactTokenIndex.clear();
    const epoch = currentEpoch();
    for (const pk of this.contactPubKeys) {
      for (const e of [epoch - 1, epoch, epoch + 1]) {
        this.contactTokenIndex.set(tokenFor(pk, e), pk);
      }
    }
  }

  private checkNetworkChange(): void {
    if (!this.running) {
      return;
    }
    const ips = ourIpv4s();
    const changed =
      ips.length !== this.currentIps.length || ips.some(ip => !this.currentIps.includes(ip));
    if (!changed) {
      return;
    }
    this.log(`network changed: [${this.currentIps.join(',')}] → [${ips.join(',')}], rebuilding mDNS`);
    this.browsers.forEach(b => {
      try {
        b.stop();
      } catch {
        /* ignore */
      }
    });
    this.browsers = [];
    this.bonjours.forEach(bonjour => {
      try {
        bonjour.destroy();
      } catch {
        /* ignore */
      }
    });
    this.bonjours = [];
    this.publisheds = [];
    this.discoveredPeers.clear();
    this.currentIps = ips;
    const optsList: Array<Record<string, unknown>> = ips.length
      ? ips.map(ip => ({ interface: ip }))
      : [{}];
    this.bonjours = optsList.map(
      opts =>
        new Bonjour(opts, (err: Error) => this.log(`mDNS socket error (ignored): ${err.message}`))
    );
    this.advertise();
    this.startBrowsing();
  }

  private advertise(): void {
    if (!this.bonjours.length || !this.ourPubKey) {
      return;
    }
    const token = tokenFor(this.ourPubKey, currentEpoch());
    this.publisheds.forEach(p => {
      try {
        p.stop?.(() => {});
      } catch {
        /* ignore */
      }
    });
    this.publisheds = this.bonjours.map(bonjour =>
      bonjour.publish({
        name: `apocentro-${token}`,
        type: SERVICE_TYPE,
        port: this.tcpPort,
        txt: { [ATTR_TOKEN]: token },
      })
    );
    this.log(`advertising _${SERVICE_TYPE}._tcp name=apocentro-${token} port=${this.tcpPort}`);
  }

  private startBrowsing(): void {
    if (!this.bonjours.length) {
      return;
    }
    if (this.rebrowseTimer) {
      clearInterval(this.rebrowseTimer);
      this.rebrowseTimer = null;
    }
    this.browsers = this.bonjours.map(bonjour => {
      const browser = bonjour.find({ type: SERVICE_TYPE });
      browser.on('up', (service: Service) => this.onServiceUp(service));
      // Intentionally do NOT drop the peer on 'down': mDNS services flap (missed
      // announcements, brief sleeps) and dropping them makes discovery unreliable
      // right when a call starts. We keep the last known address; the 30s negative
      // cache handles an address that has genuinely gone away.
      browser.on('down', (service: Service) => {
        this.log(`mDNS service down: ${service.name} (keeping last known address)`);
      });
      return browser;
    });

    // Re-issue the browse query so we recover quickly from missed announcements
    // (common right after startup) instead of waiting for the peer's next
    // unsolicited announcement. Fire a few early one-shots, then keep a steady 8s.
    const reQuery = () => {
      this.browsers.forEach(b => {
        try {
          (b as unknown as { update?: () => void }).update?.();
        } catch {
          /* ignore */
        }
      });
    };
    [1500, 3500, 6000, 10000].forEach(ms => setTimeout(reQuery, ms));
    this.rebrowseTimer = setInterval(reQuery, 8_000);
  }

  private tokenOf(service: Service): string | undefined {
    const txt = (service.txt || {}) as Record<string, unknown>;
    const raw = txt[ATTR_TOKEN];
    if (typeof raw === 'string') {
      return raw;
    }
    if (raw instanceof Buffer) {
      return raw.toString('utf8');
    }
    return undefined;
  }

  private onServiceUp(service: Service): void {
    const token = this.tokenOf(service);
    const host = this.pickIpv4(service);
    const pubkey = token ? this.contactTokenIndex.get(token) : undefined;
    // Count every _apocentro._tcp service we see (contact or not) so the overlay
    // can tell "we receive mDNS but the peer isn't a contact" from "we receive no
    // mDNS at all" (network blocking multicast).
    this.servicesSeen += 1;
    this.emit('status', { servicesSeen: this.servicesSeen });
    this.log(
      `discovered mDNS service name=${service.name} token=${token ?? '(none)'} host=${host ?? '?'}:${service.port ?? '?'} → ${
        !token
          ? 'IGNORED (no token)'
          : pubkey && pubkey !== this.ourPubKey
            ? `MATCH contact ${pubkey.slice(0, 8)}…`
            : pubkey === this.ourPubKey
              ? 'IGNORED (self)'
              : 'IGNORED (not a contact / token mismatch)'
      }`
    );
    if (!token) {
      return;
    }
    if (!pubkey || pubkey === this.ourPubKey) {
      return; // not a known contact (contacts-only + unlinkable), or it's us
    }
    if (!host || !service.port) {
      return;
    }
    this.discoveredPeers.set(pubkey, { host, port: service.port });
    const peer: DiscoveredPeer = { pubkey, host, port: service.port };
    this.emit('peer', peer);
  }

  private pickIpv4(service: Service): string | undefined {
    const addrs = service.addresses || [];
    const v4 = addrs.find(a => a.includes('.') && !a.includes(':'));
    if (v4) {
      return v4;
    }
    const referer = (service as unknown as { referer?: { address?: string } }).referer;
    return referer?.address;
  }

  private async startTcpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket: Socket) => this.handleConnection(socket));
      server.on('error', reject);
      // port 0 → OS picks an ephemeral port
      server.listen(0, () => {
        const address = server.address();
        this.tcpPort = typeof address === 'object' && address ? address.port : 0;
        this.server = server;
        resolve();
      });
    });
  }

  private handleConnection(socket: Socket): void {
    const chunks: Array<Buffer> = [];
    let total = 0;
    socket.on('data', (d: Buffer) => {
      chunks.push(d);
      total += d.length;
      if (total > MAX_FRAME_BYTES + 8) {
        socket.destroy();
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('end', () => {
      const buf = Buffer.concat(chunks, total);
      if (buf.length < 8) {
        return;
      }
      const senderPort = buf.readInt32BE(0);
      const len = buf.readInt32BE(4);
      if (len <= 0 || len > MAX_FRAME_BYTES || buf.length < 8 + len) {
        return;
      }
      const payload = buf.subarray(8, 8 + len);
      const host = socket.remoteAddress ? socket.remoteAddress.replace(/^::ffff:/, '') : '';
      const frame: IncomingLanFrame = {
        payloadBase64: payload.toString('base64'),
        host,
        senderPort,
      };
      this.log(`incoming LAN frame from ${host}:${senderPort} (${len} bytes)`);
      this.emit('incoming', frame);
    });
  }

  private async sendFrame(addr: PeerAddr, payload: Buffer): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (!ok) {
          this.unreachable.set(`${addr.host}:${addr.port}`, Date.now() + UNREACHABLE_TTL_MS);
        }
        resolve(ok);
      };

      const socket = connect({ host: addr.host, port: addr.port });
      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.on('timeout', () => {
        socket.destroy();
        done(false);
      });
      socket.on('error', () => {
        socket.destroy();
        done(false);
      });
      socket.on('connect', () => {
        const header = Buffer.alloc(8);
        header.writeInt32BE(this.tcpPort, 0);
        header.writeInt32BE(payload.length, 4);
        socket.write(Buffer.concat([header, payload]), () => {
          socket.end();
          done(true);
        });
      });
    });
  }
}

export const apocentroLan = new ApocentroLan();
