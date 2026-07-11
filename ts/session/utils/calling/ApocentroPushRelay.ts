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
 * Ask the relay to ring a (possibly closed) callee. Fallback only — send after the pre-offer when
 * the callee hasn't answered. Harmless if they're already open (the receiver dedupes by `uuid`),
 * and a no-op at the worker for callees (e.g. Android) that never registered a VoIP token.
 */
export async function apocentroPushWake(
  to: string,
  uuid: string,
  caller: string,
  contactName: string
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
    window?.log?.info(
      `[ApocentroPushRelay] POST ${PUSH_RELAY_URL}/push to=…${to6} uuid=…${uuid6} caller=…${caller.slice(
        -6
      )} ts=${timestamp}`
    );
    const res = await fetch(`${PUSH_RELAY_URL}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, uuid, caller, timestamp, contactName }),
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
