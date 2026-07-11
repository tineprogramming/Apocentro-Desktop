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
    return;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    // The worker requires the timestamp to be within 60s of now, so stamp it at send time.
    const res = await fetch(`${PUSH_RELAY_URL}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, uuid, caller, timestamp: Date.now(), contactName }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      window?.log?.info('[ApocentroPushRelay] push succeeded');
    } else {
      window?.log?.warn(`[ApocentroPushRelay] push returned ${res.status}`);
    }
  } catch (e) {
    window?.log?.warn(
      `[ApocentroPushRelay] push failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
