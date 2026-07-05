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

const SETTING_KEY = 'apocentro-lan-calling';

let started = false;
const reachablePeers = new Set<string>();

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

/** Start LAN discovery + listening. Safe to call more than once. */
export async function initApocentroLanCalling(): Promise<void> {
  if (started || !window.apocentroLan || !isLanCallingEnabled()) {
    return;
  }
  started = true;

  window.apocentroLan.onLog(msg => {
    window?.log?.info(`[ApocentroLan/main] ${msg}`);
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

  const ourPubKey = UserUtils.getOurPubKeyStrFromCache();
  const contacts = await getContactPubKeys();
  window?.log?.info(
    `[ApocentroLan] starting discovery: me=${ourPubKey.slice(0, 8)}… contacts=${contacts.length}`
  );
  await window.apocentroLan.start(ourPubKey, contacts);
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
    return await window.apocentroLan.send(pubkey, payloadBase64);
  } catch (e) {
    window?.log?.warn(
      `[ApocentroLan] trySendCallSignalOverLan failed: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return false;
  }
}
