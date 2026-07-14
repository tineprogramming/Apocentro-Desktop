/**
 * Apocentro calling configuration.
 *
 * TURN/ICE for the Apocentro closed ecosystem. We do NOT ship a TURN secret in
 * the app: short-lived ICE credentials are minted by our own Cloudflare Worker
 * (the same endpoint the Android/web clients use). Direct P2P is preferred; TURN
 * is only a relay fallback. If the fetch fails (offline / error) we fall back to
 * public STUN so calls still connect on open/cone NATs.
 *
 * Mirrors Android `com.apocentro.calls.ApocentroCallConfig`.
 */

// Settings key: when false, the in-call overlay is compact (connection type +
// signal bars + latency only); when unset/true it shows the full LAN/ICE debug
// details. Read by the settings toggle and the call overlay.
export const APOCENTRO_CALL_DEBUG_KEY = 'apocentro-call-debug';

// Public endpoint — mints only temporary creds, safe to hard-code (as on Android).
const TURN_CREDENTIALS_URL = 'https://apocentro-turn-creds.none-reply.workers.dev';
const TURN_TTL_SECONDS = 86400;

// STUN-only fallback used when the credential fetch fails.
const STUN_FALLBACK: Array<RTCIceServer> = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

let cachedIceServers: Array<RTCIceServer> | null = null;
let cachedAtMs = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // refetch at most hourly

type CloudflareIceResponse = {
  iceServers?: Array<RTCIceServer> | RTCIceServer;
};

/**
 * Fetch Apocentro ICE servers (Cloudflare TURN) with a STUN fallback.
 * Cached for an hour; never throws — always returns a usable list.
 */
export async function getApocentroIceServers(): Promise<Array<RTCIceServer>> {
  const now = Date.now();
  if (cachedIceServers && now - cachedAtMs < CACHE_TTL_MS) {
    return cachedIceServers;
  }

  try {
    // Prefer the main-process IPC bridge: a direct renderer fetch to the worker dies instantly
    // ("Failed to fetch") under the renderer's network policy, even though the URL works in a
    // system browser. Falls back to a plain fetch when the bridge isn't there (dev/tests).
    const requestBody = JSON.stringify({ ttl: TURN_TTL_SECONDS });
    let status: number;
    let text: string;
    if (window?.apocentroRelayFetch) {
      const ipcRes = await window.apocentroRelayFetch(TURN_CREDENTIALS_URL, requestBody);
      status = ipcRes.status;
      text = ipcRes.text;
      if (!ipcRes.ok) {
        throw new Error(`TURN worker returned ${status} (${text.slice(0, 120)})`);
      }
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(TURN_CREDENTIALS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      status = res.status;
      text = await res.text();
      if (!res.ok) {
        throw new Error(`TURN worker returned ${status}`);
      }
    }
    const json = JSON.parse(text) as CloudflareIceResponse;
    const raw = json.iceServers;
    const servers: Array<RTCIceServer> = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (!servers.length) {
      throw new Error('TURN worker returned no iceServers');
    }
    // Always keep STUN in the pool as a cheap direct-path helper.
    cachedIceServers = [...servers, ...STUN_FALLBACK];
    cachedAtMs = now;
    return cachedIceServers;
  } catch (e) {
    window?.log?.warn(
      `[ApocentroCallConfig] TURN cred fetch failed, using STUN fallback: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    // Cache the fallback briefly so we don't hammer the endpoint while offline.
    cachedIceServers = STUN_FALLBACK;
    cachedAtMs = now;
    return cachedIceServers;
  }
}
