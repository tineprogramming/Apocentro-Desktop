/**
 * Apocentro LAN calling — renderer side.
 *
 * Bridges the main-process LAN transport (see ts/mains/apocentro_lan.ts, exposed
 * on window.apocentroLan by preload.js) to the call engine:
 *  - starts mDNS discovery + the TCP listener with our pubkey and contact list,
 *  - tracks which contacts are currently reachable on the LAN,
 *  - on an outgoing call signal, encrypts it with the *same* magic-bytes +
 *    libSession 1:1 envelope used for the snode path and ships the bytes over the
 *    LAN (falling back to onion when the peer isn't local),
 *  - on an incoming LAN frame, strips + decrypts + dispatches it through the same
 *    path as a polled 1o1 message, and learns the sender's address for replies.
 *
 * Scope: 1:1 CALL signalling only. DM/group traffic is never routed here.
 */

import ByteBuffer from 'bytebuffer';

import { MessageWrapper } from '../../sending/MessageWrapper';
import { OutgoingRawMessage } from '../../types/RawMessage';
import { UserUtils } from '..';
import { ContactsWrapperActions } from '../../../webworker/workers/browser/libsession_worker_interface';
import { handleApocentroLanCallBytes } from '../../apis/snode_api/swarmPolling';
import { fromBase64ToArray } from '../String';
import { tr } from '../../../localization/localeTools';
import { pushToastWarning } from '../Toast';
import { userSettingsModal } from '../../../state/ducks/modalDialog';

const SETTING_KEY = 'apocentro-lan-calling';

let started = false;
// IPC listeners survive a stop/start cycle, so register them exactly once.
let listenersRegistered = false;
let refreshLoopStarted = false;
const reachablePeers = new Set<string>();

// Total _apocentro._tcp mDNS services seen (contact or not) — surfaced in the
// overlay to distinguish "no mDNS at all" (0 = network blocks multicast) from
// "we see services but the peer isn't matched".
let lanServicesSeen = 0;

export function getLanServicesSeen(): number {
  return lanServicesSeen;
}

// Last LAN call-signal send outcome, surfaced in the call overlay for debugging.
let lastLanSend: { ok: boolean; detail: string } | null = null;

export function getLastLanSendStatus(): { ok: boolean; detail: string } | null {
  return lastLanSend;
}

/** LAN/offline calling is on by default; only an explicit `false` disables it. */
export function isLanCallingEnabled(): boolean {
  try {
    return window.getSettingValue?.(SETTING_KEY) !== false;
  } catch {
    return true;
  }
}

async function getContactPubKeys(): Promise<Array<string>> {
  try {
    const all = await ContactsWrapperActions.getAll();
    return all.map(c => c.id).filter(Boolean);
  } catch {
    return [];
  }
}

function registerLanListeners(): void {
  if (listenersRegistered || !window.apocentroLan) {
    return;
  }
  listenersRegistered = true;

  window.apocentroLan.onLog(msg => {
    window?.log?.info(`[ApocentroLan/main] ${msg}`);
  });

  window.apocentroLan.onStatus(status => {
    if (typeof status?.servicesSeen === 'number') {
      lanServicesSeen = status.servicesSeen;
    }
  });

  // Another app owns mDNS port 5353 → Nearby/LAN can't run. Tell the user which
  // app it is (best-effort) and let them choose: close that app, or turn Nearby
  // off in Privacy settings (clicking the toast opens them).
  window.apocentroLan.onPortConflict(conflict => {
    const apps = conflict?.apps?.filter(Boolean) ?? [];
    const message = apps.length
      ? `${tr('lanPortConflictAppsPrefixDev')} ${apps.join(', ')}. ${tr('lanPortConflictAdviceDev')}`
      : `${tr('lanPortConflictGenericDev')} ${tr('lanPortConflictAdviceDev')}`;
    window?.log?.warn(`[ApocentroLan] ${message}`);
    pushToastWarning('apocentro-lan-port-conflict', message, () => {
      window.inboxStore?.dispatch(userSettingsModal({ userSettingsPage: 'privacy' }));
    });
  });

  window.apocentroLan.onPeer(peer => {
    if (peer?.pubkey) {
      reachablePeers.add(peer.pubkey);
      window?.log?.info(
        `[ApocentroLan] peer reachable on LAN: ${peer.pubkey.slice(0, 8)}… at ${peer.host}:${peer.port}`
      );
    }
  });

  window.apocentroLan.onIncoming(async frame => {
    try {
      const bytes = fromBase64ToArray(frame.payloadBase64);
      const senderPubkey = await handleApocentroLanCallBytes(bytes);
      if (senderPubkey) {
        reachablePeers.add(senderPubkey);
        // Learn the sender's address so our reply (answer / ICE) can reach them
        // over the LAN even before mDNS resolves them in our direction.
        window.apocentroLan?.learnPeer(senderPubkey, frame.host, frame.senderPort);
      }
    } catch (e) {
      window?.log?.warn(
        `[ApocentroLan] onIncoming failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  });
}

/** Start LAN discovery + listening. Safe to call more than once. */
export async function initApocentroLanCalling(): Promise<void> {
  if (started || !window.apocentroLan || !isLanCallingEnabled()) {
    return;
  }
  started = true;

  registerLanListeners();

  const ourPubKey = UserUtils.getOurPubKeyStrFromCache();
  const contacts = await getContactPubKeys();
  window?.log?.info(
    `[ApocentroLan] starting discovery: me=${ourPubKey.slice(0, 8)}… contacts=${contacts.length}`
  );
  await window.apocentroLan.start(ourPubKey, contacts);

  // Keep the contacts-only discovery index fresh. Contacts are often not loaded
  // yet in the first seconds after startup (so the index would be empty and the
  // peer unmatchable), so refresh aggressively for the first minute, then settle.
  // The loop is registered once and no-ops while LAN calling is stopped.
  if (!refreshLoopStarted) {
    refreshLoopStarted = true;
    let refreshCount = 0;
    const scheduleRefresh = () => {
      setTimeout(
        () => {
          void refreshApocentroLanContacts();
          refreshCount += 1;
          scheduleRefresh();
        },
        refreshCount < 12 ? 5_000 : 30_000
      );
    };
    scheduleRefresh();
  }
}

/**
 * User-facing Nearby (LAN discovery) switch — persisted under the existing
 * 'apocentro-lan-calling' setting. Turning it off stops mDNS advertising and
 * the LAN listener immediately; turning it on restarts discovery.
 */
export async function setLanCallingEnabled(enabled: boolean): Promise<void> {
  await window.setSettingValue(SETTING_KEY, enabled);
  if (!enabled) {
    window.apocentroLan?.stop();
    started = false;
    reachablePeers.clear();
    lanServicesSeen = 0;
    window?.log?.info('[ApocentroLan] Nearby/LAN disabled by user');
  } else {
    window?.log?.info('[ApocentroLan] Nearby/LAN enabled by user');
    await initApocentroLanCalling();
  }
}

/** Refresh the contacts-only discovery index (e.g. after a contact change). */
export async function refreshApocentroLanContacts(): Promise<void> {
  if (!started || !window.apocentroLan) {
    return;
  }
  window.apocentroLan.updateContacts(await getContactPubKeys());
}

export function isPeerReachableOnLan(pubkey: string): boolean {
  return reachablePeers.has(pubkey);
}

/**
 * Give LAN discovery a brief head-start right before a call so an online,
 * same-Wi-Fi peer is found (and signalling goes over the fast LAN path) instead
 * of racing the call and falling back to slow onion. Resolves immediately if the
 * peer is already known; otherwise it fires an active mDNS re-query and polls for
 * up to `timeoutMs`. Skipped entirely when we've seen no mDNS at all (a genuinely
 * remote call), so those aren't delayed.
 */
export async function ensurePeerDiscoveredOnLan(
  pubkey: string,
  timeoutMs = 1200
): Promise<boolean> {
  if (!window.apocentroLan || !isLanCallingEnabled()) {
    return false;
  }
  if (isPeerReachableOnLan(pubkey)) {
    return true;
  }
  // No mDNS services seen at all → multicast is blocked or nobody's around;
  // don't delay a call that's almost certainly remote.
  if (lanServicesSeen === 0) {
    return false;
  }
  window.apocentroLan.rediscover();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 100));
    if (isPeerReachableOnLan(pubkey)) {
      window?.log?.info(
        `[ApocentroLan] peer ${pubkey.slice(0, 8)}… discovered just-in-time for call`
      );
      return true;
    }
  }
  return false;
}

/**
 * Try to deliver a call signal to `rawMessage.device` over the LAN. Produces the
 * exact same encrypted + magic-byte-wrapped bytes the snode path would, then
 * ships them via the main-process TCP channel. Returns false (→ caller falls back
 * to onion) when LAN is disabled, the peer isn't local, or the send fails.
 */
export async function trySendCallSignalOverLan(rawMessage: OutgoingRawMessage): Promise<boolean> {
  if (!window.apocentroLan || !isLanCallingEnabled()) {
    return false;
  }
  const pubkey = rawMessage.device;
  if (!isPeerReachableOnLan(pubkey)) {
    window?.log?.info(
      `[ApocentroLan] call signal to ${pubkey.slice(0, 8)}…: peer not discovered on LAN → onion`
    );
    return false;
  }
  window?.log?.info(`[ApocentroLan] call signal to ${pubkey.slice(0, 8)}…: trying LAN`);
  try {
    const [wrapped] = await MessageWrapper.encryptMessagesAndWrap([
      {
        destination: rawMessage.device,
        plainTextBuffer: rawMessage.plainTextBuffer,
        namespace: rawMessage.namespace,
        ttl: rawMessage.ttl,
        dbMessageIdentifier: rawMessage.dbMessageIdentifier,
        networkTimestamp: rawMessage.networkTimestampCreated,
        isSyncMessage: false,
      },
    ]);
    const payloadBase64 = ByteBuffer.wrap(wrapped.encryptedAndWrappedData).toString('base64');
    const res = await window.apocentroLan.send(pubkey, payloadBase64);
    lastLanSend = { ok: res.ok, detail: res.detail };
    window?.log?.info(
      `[ApocentroLan] call signal to ${pubkey.slice(0, 8)}… over LAN: ${
        res.ok ? 'OK' : 'FAILED → onion'
      } (${res.detail})`
    );
    return res.ok;
  } catch (e) {
    lastLanSend = { ok: false, detail: 'error' };
    window?.log?.warn(
      `[ApocentroLan] trySendCallSignalOverLan failed: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return false;
  }
}
