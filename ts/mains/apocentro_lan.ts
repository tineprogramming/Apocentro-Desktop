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

/** True if `host` shares a /24 with one of our own IPv4s (cheap "is it local?" pre-check). */
function isOnALocalSubnet(host: string): boolean {
  const prefixOf = (ip: string) => ip.split('.').slice(0, 3).join('.');
  const peerPrefix = prefixOf(host);
  return ourIpv4s().some(ip => prefixOf(ip) === peerPrefix);
}

class ApocentroLan extends EventEmitter {
  private bonjour: Bonjour | null = null;
  private published: Service | null = null;
  private browser: Browser | null = null;
  private server: Server | null = null;

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

    this.bonjour = new Bonjour();
    this.advertise();
    this.startBrowsing();

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
    try {
      this.browser?.stop();
    } catch {
      /* ignore */
    }
    this.browser = null;
    try {
      this.bonjour?.unpublishAll(() => this.bonjour?.destroy());
    } catch {
      /* ignore */
    }
    this.bonjour = null;
    this.published = null;
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
  public async send(toPubKey: string, payload: Buffer): Promise<boolean> {
    const addr = this.discoveredPeers.get(toPubKey) || this.learnedPeers.get(toPubKey);
    if (!addr) {
      this.log(`send to ${toPubKey.slice(0, 8)}…: no LAN address known → onion fallback`);
      return false;
    }
    if (!this.mightReachOnLan(addr)) {
      this.log(
        `send to ${toPubKey.slice(0, 8)}…: ${addr.host}:${addr.port} not reachable (subnet/negative-cache) → onion fallback`
      );
      return false;
    }
    const ok = await this.sendFrame(addr, payload);
    this.log(
      `send to ${toPubKey.slice(0, 8)}… over LAN ${addr.host}:${addr.port}: ${ok ? 'OK' : 'FAILED → onion fallback'}`
    );
    return ok;
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

  private advertise(): void {
    if (!this.bonjour || !this.ourPubKey) {
      return;
    }
    const token = tokenFor(this.ourPubKey, currentEpoch());
    try {
      this.published?.stop?.(() => {});
    } catch {
      /* ignore */
    }
    this.published = this.bonjour.publish({
      name: `apocentro-${token}`,
      type: SERVICE_TYPE,
      port: this.tcpPort,
      txt: { [ATTR_TOKEN]: token },
    });
    this.log(`advertising _${SERVICE_TYPE}._tcp name=apocentro-${token} port=${this.tcpPort}`);
  }

  private startBrowsing(): void {
    if (!this.bonjour) {
      return;
    }
    this.browser = this.bonjour.find({ type: SERVICE_TYPE });
    this.browser.on('up', (service: Service) => this.onServiceUp(service));
    this.browser.on('down', (service: Service) => {
      // best-effort: drop any discovered peer that resolved to this instance
      const token = this.tokenOf(service);
      const pubkey = token ? this.contactTokenIndex.get(token) : undefined;
      if (pubkey) {
        this.discoveredPeers.delete(pubkey);
      }
    });
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

  private mightReachOnLan(addr: PeerAddr): boolean {
    const key = `${addr.host}:${addr.port}`;
    const until = this.unreachable.get(key);
    if (until && until > Date.now()) {
      return false;
    }
    if (until) {
      this.unreachable.delete(key);
    }
    return isOnALocalSubnet(addr.host);
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
