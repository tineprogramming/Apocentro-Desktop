/**
 * Apocentro — VoIP push relay client (caller side), desktop.
 *
 * A closed / suspended iPhone can only be woken for a call by an **APNs VoIP push**, and that push
 * is caller-triggered via the Apocentro relay (it does not watch swarms). iOS and Android callers
 * trigger it as a fallback after the pre-offer when the callee hasn't answered; desktop must do the
 * same so a desktop → sleeping-iOS call rings. Desktop only ever acts as the caller here (it does
 * not register a VoIP token — it isn't woken by this relay).
 *
 * Mirror of the iOS/Android `ApocentroPushRelay`. Best-effort / fire-and-forget: never blocks or
 * fails the call. Transport is HTTPS (TLS); the payload is not E2E (the relay sees `{to, caller}`),
 * matching the iOS/Android behaviour.
 */

const PUSH_RELAY_URL = 'https://apocentro-push.none-reply.workers.dev';

/**
 * Strip the private (host/srflx/prflx) ICE candidate lines from an offer SDP, keeping relay
 * candidates, so the offer fits inside the APNs VoIP push. Mirrors the Android caller. The real
 * candidates still trickle over the swarm; the callee only needs the media/codec sections to set
 * its remote description straight from the push (skipping the flaky cold-wake swarm offer poll).
 */
function pushSafeOfferSdp(sdp: string | undefined | null): string {
  if (!sdp) {
    return '';
  }
  const stripped = sdp.replace(/^a=candidate:.*\btyp (?:host|srflx|prflx)\b.*\r?\n?/gm, '');
  // Leave headroom under the worker's ~4.8KB VoIP budget; if it still won't fit, omit it and the
  // callee falls back to fetching the offer from its swarm.
  return stripped.length <= 3500 ? stripped : '';
}

/**
 * Ask the relay to ring a (possibly closed) callee. Fallback only — send after the pre-offer when
 * the callee hasn't answered. Harmless if they're already open (the receiver dedupes by `uuid`),
 * and a no-op at the worker for callees (e.g. Android) that never registered a VoIP token.
 *
 * `offerSdp` is our raw local offer SDP; it's candidate-stripped here and forwarded in the push as
 * `offerSDP` so a cold-woken iOS callee can set its remote description straight from the push instead
 * of polling its swarm for the offer over onion (the step that made background calls flaky). May be
 * empty/omitted → callee falls back to fetching the offer from its swarm.
 */
export async function apocentroPushWake(
  to: string,
  uuid: string,
  caller: string,
  contactName: string,
  offerSdp: string = ''
): Promise<void> {
  if (!to) {
    window?.log?.warn('[ApocentroPushRelay] skipped: empty recipient');
    return;
  }
  const to6 = to.slice(-6);
  const uuid6 = uuid.slice(-6);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    // The worker requires the timestamp to be within 60s of now, so stamp it at send time.
    const timestamp = Date.now();
    const safeSdp = pushSafeOfferSdp(offerSdp);
    const body: Record<string, unknown> = { to, uuid, caller, timestamp, contactName };
    if (safeSdp) {
      body.sdp = safeSdp;
    }
    window?.log?.info(
      `[ApocentroPushRelay] POST ${PUSH_RELAY_URL}/push to=…${to6} uuid=…${uuid6} caller=…${caller.slice(
        -6
      )} ts=${timestamp} sdp=${safeSdp ? `${safeSdp.length}b` : 'none'}`
    );
    const res = await fetch(`${PUSH_RELAY_URL}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      window?.log?.info(`[ApocentroPushRelay] push OK (${res.status}) to=…${to6} uuid=…${uuid6}`);
    } else {
      // Read the worker's error body so a rejection (bad timestamp, rate limit, etc.) is visible.
      const body = await res.text().catch(() => '<no body>');
      window?.log?.warn(
        `[ApocentroPushRelay] push FAILED status=${res.status} to=…${to6} body=${body.slice(0, 300)}`
      );
    }
  } catch (e) {
    window?.log?.warn(
      `[ApocentroPushRelay] push threw for to=…${to6} uuid=…${uuid6}: ${
        e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      }`
    );
  }
}

/**
 * Nudge a (possibly closed) recipient that they have a new message (Option B — envelope-in-push).
 * Carries the **already-E2E-encrypted** swarm envelope (`enc`, the exact base64 `data` blob we
 * stored, magic bytes included) plus its swarm metadata. The recipient's iOS Notification Service
 * Extension decrypts `enc` on-device with its identity key (no swarm poll); the relay only ever
 * sees an encrypted blob, never content. Fire-and-forget after the message reaches the swarm; a
 * no-op at the worker for recipients (e.g. Android/Desktop) without a registered APNs token.
 *
 * @param to        recipient session id (hex "05…")
 * @param enc       base64 of the swarm `data` blob AS STORED (magic bytes included). The worker
 *                  drops it from the push if the payload would exceed the APNs alert budget.
 * @param namespace the swarm namespace the message was stored in (0 for a 1:1 DM)
 * @param timestamp the message's swarm/sent timestamp (ms); must be within 60s of now
 */
export async function apocentroNotify(
  to: string,
  enc: string,
  namespace: number,
  timestamp: number
): Promise<void> {
  if (!to) {
    return;
  }
  const to6 = to.slice(-6);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    window?.log?.info(
      `[ApocentroPushRelay] POST ${PUSH_RELAY_URL}/notify to=…${to6} ns=${namespace} enc=${
        enc ? `${enc.length}b` : 'none'
      } ts=${timestamp}`
    );
    const res = await fetch(`${PUSH_RELAY_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, enc, namespace, timestamp }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      window?.log?.info(`[ApocentroPushRelay] notify OK (${res.status}) to=…${to6}`);
    } else {
      const errBody = await res.text().catch(() => '<no body>');
      window?.log?.warn(
        `[ApocentroPushRelay] notify FAILED status=${res.status} to=…${to6} body=${errBody.slice(0, 200)}`
      );
    }
  } catch (e) {
    window?.log?.warn(
      `[ApocentroPushRelay] notify failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
