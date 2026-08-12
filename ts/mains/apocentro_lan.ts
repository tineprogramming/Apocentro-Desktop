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
import { exec } from 'child_process';
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
// How long an interface whose mDNS socket failed to bind (e.g. EADDRINUSE on
// port 5353) stays excluded before we try it again.
const MDNS_FAILED_RETRY_MS = 5 * 60_000;

type PeerAddr = { host: string; port: number };
export type DiscoveredPeer = { pubkey: string; host: string; port: number };
export type IncomingLanFrame = { payloadBase64: string; host: string; senderPort: number };
export type LanPortConflict = { port: number; apps: Array<string> };

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

/** Run a short shell command, resolving with its stdout ('' on any failure). */
function execString(command: string): Promise<string> {
  return new Promise(resolve => {
    exec(command, { timeout: 3_000, windowsHide: true }, (_error, stdout) =>
      resolve(String(stdout || ''))
    );
  });
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

  // interface key ('default' or an IPv4) -> when its mDNS socket errored (bind
  // failed etc.); excluded from rebuilds until MDNS_FAILED_RETRY_MS passes or
  // the network changes
  private failedInterfaces = new Map<string, number>();
  private mdnsRebuildPending = false;

  // Only surface the "another app owns port 5353" notice once per start(), so a
  // rebuild storm doesn't spam the renderer with toasts.
  private portConflictNotified = false;

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
    this.portConflictNotified = false;
    this.bonjours = this.createBonjourInstances(this.currentIps);
    this.advertise();
    this.startBrowsing();

    // Watch for network changes (Wi-Fi switch): when our interface set changes,
    // rebuild the mDNS instances so we bind the new interface and stop touching
    // the old (now-invalid) one. The try/catch keeps a failure inside the tick
    // from becoming an uncaughtException (which would kill the app).
    this.netWatchTimer = setInterval(() => {
      try {
        this.checkNetworkChange();
      } catch (e) {
        this.log(`network watch tick failed (ignored): ${(e as Error).message}`);
      }
    }, 5_000);

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
    this.failedInterfaces.clear();
    this.mdnsRebuildPending = false;
    this.portConflictNotified = false;
  }

  public updateContacts(contactPubKeys: Array<string>): void {
    this.contactPubKeys = contactPubKeys;
    this.rebuildTokenTables();
  }

  /**
   * Force an immediate discovery burst: re-announce ourselves and re-issue the
   * browse query right now, instead of waiting for the next periodic re-query.
   * Called when a call is about to start so an online same-LAN peer is found
   * (and the signal goes over the LAN) rather than falling back to slow onion.
   */
  public rediscover(): void {
    if (!this.running) {
      return;
    }
    this.advertise();
    this.browsers.forEach(b => {
      try {
        (b as unknown as { update?: () => void }).update?.();
      } catch {
        /* ignore */
      }
    });
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

    // Interfaces whose mDNS socket errored (e.g. port 5353 held by another app)
    // get retried after a cool-down — the other app may have quit.
    const now = Date.now();
    let cooledDown = false;
    for (const [key, failedAt] of this.failedInterfaces) {
      if (now - failedAt > MDNS_FAILED_RETRY_MS) {
        this.failedInterfaces.delete(key);
        cooledDown = true;
      }
    }

    if (!changed && !cooledDown) {
      return;
    }
    if (changed) {
      // A different network is a fresh start: try every interface again.
      this.failedInterfaces.clear();
      this.discoveredPeers.clear();
      this.log(
        `network changed: [${this.currentIps.join(',')}] → [${ips.join(',')}], rebuilding mDNS`
      );
    }
    this.currentIps = ips;
    this.rebuildMdns(changed ? 'network changed' : 'retrying previously failed interface(s)');
  }

  /**
   * Create one Bonjour instance per usable IPv4 interface (or a single default
   * instance when none can be enumerated), skipping interfaces whose mDNS
   * socket recently failed to bind.
   *
   * IMPORTANT: pass an error callback to the constructor — without one,
   * bonjour-service rethrows respond() errors, which crashes the whole app.
   * ALSO IMPORTANT: bonjour-service does NOT forward its underlying
   * multicast-dns socket 'error' events to that callback (they are a separate,
   * unlistened EventEmitter 'error' — which Node turns into an
   * uncaughtException). That is exactly what crashed macOS builds with
   * "bind EADDRINUSE <ip>:5353" when another app held the mDNS port
   * exclusively. So we attach our own 'error'/'warning' listeners to the
   * multicast-dns instance and degrade to no-LAN on that interface instead.
   */
  private createBonjourInstances(ips: Array<string>): Array<Bonjour> {
    const keys = ips.length ? ips : ['default'];
    const usable = keys.filter(key => !this.failedInterfaces.has(key));
    if (!usable.length) {
      this.log(
        'mDNS unavailable on every interface (UDP port 5353 conflict?) — LAN discovery is off; messaging/calls use the internet path. Will retry when the network changes or after cool-down.'
      );
      return [];
    }

    const instances: Array<Bonjour> = [];
    for (const key of usable) {
      // reuseAddr → share UDP 5353 with macOS's always-running mDNSResponder
      // (multicast-dns defaults it to true; keep it explicit so a future
      // dependency bump can't silently regress the macOS coexistence)
      const opts: Record<string, unknown> =
        key === 'default' ? { reuseAddr: true } : { interface: key, reuseAddr: true };
      try {
        const bonjour = new Bonjour(opts, (err: Error) =>
          this.log(`mDNS socket error (ignored): ${err.message}`)
        );
        const mdns = (
          bonjour as unknown as { server?: { mdns?: NodeJS.EventEmitter } }
        ).server?.mdns;
        mdns?.on('error', (err: Error) => {
          this.log(
            `mDNS failed on ${key} (${err.message}) — LAN discovery disabled on this interface for now; likely another app owns UDP port 5353`
          );
          this.failedInterfaces.set(key, Date.now());
          this.maybeReportPortConflict(err);
          this.scheduleMdnsRebuild();
        });
        mdns?.on('warning', (err: Error) =>
          this.log(`mDNS warning on ${key} (ignored): ${err.message}`)
        );
        instances.push(bonjour);
      } catch (e) {
        this.log(`failed to create mDNS instance on ${key} (ignored): ${(e as Error).message}`);
        this.failedInterfaces.set(key, Date.now());
      }
    }
    this.log(`created ${instances.length} mDNS instance(s) on: ${usable.join(', ')}`);
    return instances;
  }

  /** Debounced full teardown + re-create of the mDNS layer, minus failed interfaces. */
  private scheduleMdnsRebuild(): void {
    if (this.mdnsRebuildPending || !this.running) {
      return;
    }
    this.mdnsRebuildPending = true;
    setTimeout(() => {
      this.mdnsRebuildPending = false;
      if (!this.running) {
        return;
      }
      try {
        this.rebuildMdns('mDNS socket error');
      } catch (e) {
        this.log(`mDNS rebuild failed (ignored): ${(e as Error).message}`);
      }
    }, 200);
  }

  /**
   * On a 5353 bind conflict, try to find out WHICH app is holding the port and
   * tell the renderer, so the UI can suggest closing that app (or turning
   * Nearby off). Best-effort: emits with an empty list when detection fails.
   */
  private maybeReportPortConflict(err: Error): void {
    const isAddrInUse =
      (err as NodeJS.ErrnoException).code === 'EADDRINUSE' || err.message.includes('EADDRINUSE');
    if (!isAddrInUse || this.portConflictNotified) {
      return;
    }
    this.portConflictNotified = true;
    void this.findMdnsPortOwners().then(apps => {
      this.log(
        `UDP 5353 is held by: ${apps.length ? apps.join(', ') : '(unknown — run: sudo lsof -nP -iUDP:5353)'}`
      );
      const conflict: LanPortConflict = { port: 5353, apps };
      this.emit('port-conflict', conflict);
    });
  }

  /**
   * List process names (other than our own process and the OS's own mDNS
   * service, which coexists fine) that have UDP 5353 open — those are exactly
   * the apps that grab 5353 exclusively and break our bind. Best-effort; an
   * empty list means "could not tell".
   */
  private async findMdnsPortOwners(): Promise<Array<string>> {
    try {
      if (process.platform === 'darwin' || process.platform === 'linux') {
        return await this.findMdnsPortOwnersUnix();
      }
      if (process.platform === 'win32') {
        return await this.findMdnsPortOwnersWindows();
      }
    } catch {
      // fall through — detection is best-effort only
    }
    return [];
  }

  /** macOS/Linux: unprivileged lsof sees the user's own apps. */
  private async findMdnsPortOwnersUnix(): Promise<Array<string>> {
    // -F pc → machine-readable "p<pid>" / "c<command>" line pairs
    const stdout = await execString('lsof -nP -iUDP:5353 -F pc');
    const apps = new Set<string>();
    let pid = '';
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        pid = line.slice(1).trim();
      } else if (line.startsWith('c')) {
        const name = line.slice(1).trim();
        // mDNSResponder is macOS's own shared-bind daemon, not the culprit
        if (name && pid !== String(process.pid) && name !== 'mDNSResponder') {
          apps.add(name);
        }
      }
    }
    return Array.from(apps);
  }

  /** Windows: netstat lists the PIDs on the port, tasklist maps PID → exe name. */
  private async findMdnsPortOwnersWindows(): Promise<Array<string>> {
    const netstatOut = await execString('netstat -ano -p UDP');
    const pids = new Set<string>();
    for (const rawLine of netstatOut.split('\n')) {
      //   UDP    0.0.0.0:5353    *:*    1234   (local address may also be [::]:5353)
      const parts = rawLine.trim().split(/\s+/);
      if (parts.length < 3 || parts[0].toUpperCase() !== 'UDP' || !/:5353$/.test(parts[1])) {
        continue;
      }
      const pid = parts[parts.length - 1];
      // 0 = Idle, 4 = System — never the exclusive holder we're looking for
      if (/^\d+$/.test(pid) && pid !== '0' && pid !== '4' && pid !== String(process.pid)) {
        pids.add(pid);
      }
    }
    if (!pids.size) {
      return [];
    }

    const tasklistOut = await execString('tasklist /FO CSV /NH');
    const nameByPid = new Map<string, string>();
    for (const line of tasklistOut.split('\n')) {
      // "chrome.exe","1234","Console","1","123,456 K"
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m) {
        nameByPid.set(m[2], m[1]);
      }
    }

    const apps = new Set<string>();
    for (const pid of pids) {
      const name = nameByPid.get(pid);
      // svchost hosts Windows' own shared-bind mDNS (Dnscache), not the culprit
      if (name && name.toLowerCase() !== 'svchost.exe') {
        apps.add(name);
      }
    }
    return Array.from(apps);
  }

  private rebuildMdns(reason: string): void {
    this.log(`rebuilding mDNS (${reason})`);
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
    this.bonjours = this.createBonjourInstances(this.currentIps);
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
    this.publisheds = this.bonjours.flatMap(bonjour => {
      try {
        return [
          bonjour.publish({
            name: `apocentro-${token}`,
            type: SERVICE_TYPE,
            port: this.tcpPort,
            txt: { [ATTR_TOKEN]: token },
          }),
        ];
      } catch (e) {
        // e.g. the instance's socket died between rebuilds — never let this crash
        this.log(`mDNS publish failed (ignored): ${(e as Error).message}`);
        return [];
      }
    });
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
    this.browsers = this.bonjours.flatMap(bonjour => {
      try {
        const browser = bonjour.find({ type: SERVICE_TYPE });
        browser.on('up', (service: Service) => this.onServiceUp(service));
        // Intentionally do NOT drop the peer on 'down': mDNS services flap (missed
        // announcements, brief sleeps) and dropping them makes discovery unreliable
        // right when a call starts. We keep the last known address; the 30s negative
        // cache handles an address that has genuinely gone away.
        browser.on('down', (service: Service) => {
          this.log(`mDNS service down: ${service.name} (keeping last known address)`);
        });
        return [browser];
      } catch (e) {
        this.log(`mDNS browse failed (ignored): ${(e as Error).message}`);
        return [];
      }
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
