/**
 * Apocentro: offline IP → country lookup for the call-info overlay, reusing the
 * same bundled MaxMind GeoLite2-Country database the onion-path UI uses (loaded
 * from the main process over IPC). Fully offline — no network calls — matching
 * the Android call overlay's country flag.
 */

import { ipcRenderer } from 'electron';
import { CityResponse, Reader } from 'maxmind';
import { isEmpty, isTypedArray } from 'lodash';

let reader: Reader<CityResponse> | null = null;
let loading = false;

/** Kick off loading the offline geo DB (idempotent). */
export function ensureGeoReader(): void {
  if (reader || loading) {
    return;
  }
  loading = true;
  ipcRenderer.once('load-maxmind-data-complete', (_event, content) => {
    loading = false;
    const buf = content as Uint8Array;
    if (buf && isTypedArray(buf) && !isEmpty(buf)) {
      try {
        reader = new Reader<CityResponse>(Buffer.from(buf.buffer));
      } catch {
        reader = null;
      }
    }
  });
  ipcRenderer.send('load-maxmind-data');
}

/** ISO-3166 alpha-2 → regional-indicator flag emoji (e.g. "TH" → 🇹🇭). */
function flagForIso(iso: string): string {
  return String.fromCodePoint(...[...iso.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** Look up an IP's country (offline). Returns null for private/LAN IPs or misses. */
export function countryForIp(ip: string | null): { iso: string; flag: string } | null {
  if (!ip || !reader) {
    return null;
  }
  try {
    const iso = reader.get(ip)?.country?.iso_code;
    if (!iso || iso.length !== 2) {
      return null;
    }
    return { iso, flag: flagForIso(iso) };
  } catch {
    return null;
  }
}
