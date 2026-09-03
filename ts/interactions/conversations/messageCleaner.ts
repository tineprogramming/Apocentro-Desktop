import { compact } from 'lodash';

import { Data } from '../../data/data';
import type { ConversationModel } from '../../models/conversation';
import type { MessageModel } from '../../models/message';
import { ConvoHub } from '../../session/conversations';
import { PubKey } from '../../session/types';
import { messagesExpired } from '../../state/ducks/conversations';
import { deleteAllMessagesByConvoIdNoConfirmation } from '../conversationInteractions';
import { deleteMessagesFromSwarmOnly } from './deleteMessagesFromSwarmOnly';
import { getUnsendMessagesObjects1o1, sendUnsendRequests1o1 } from './unsendMessages1o1';
import { hasGroupAdminKey, unsendMessagesForEveryoneGroupV2 } from './unsendMessagesGroupV2';

/**
 * How far a clear reaches.
 *
 * Mirrors the Android V5.0 message cleaner so the two clients behave identically:
 * - `device_only`  wipe our local copies only
 * - `others_only`  ask the other side(s) to delete theirs, keep ours
 * - `both`         both of the above
 */
export type ClearScope = 'device_only' | 'others_only' | 'both';

export const ALL_CLEAR_SCOPES: Array<ClearScope> = ['device_only', 'others_only', 'both'];

/**
 * Whether this conversation can ask anyone else to delete: a 1:1 with an
 * unblinded contact, or a group we hold the admin key for. Communities,
 * blinded DMs, Note-to-Self and groups we don't administer can only ever
 * clear locally, so the remote scopes must not be offered for them.
 */
export async function canClearRemotely(conversationId: string): Promise<boolean> {
  const conversation = ConvoHub.use().get(conversationId);
  if (!conversation || conversation.isMe()) {
    return false;
  }
  if (conversation.isPrivate()) {
    return !conversation.isPrivateAndBlinded() && PubKey.is05Pubkey(conversation.id);
  }
  if (conversation.isClosedGroupV2() && PubKey.is03Pubkey(conversation.id)) {
    return hasGroupAdminKey(conversation.id);
  }
  return false;
}

/**
 * The messages a clear should act on: everything in the thread, or only what is
 * older than the cutoff when a retention policy asked for it. Control messages
 * are excluded because there is nothing meaningful to unsend for them -- they
 * are still removed locally by the local step below.
 */
async function targetsFor(
  conversationId: string,
  beforeTimestampMs: number | undefined
): Promise<Array<MessageModel>> {
  const messages = await Data.getLastMessagesByConversation({
    conversationId,
    limit: 100000,
    skipTimerInit: true,
    skipMarkedAsDeleted: true,
  });

  return messages.filter(message => {
    if (message.isControlMessage()) {
      return false;
    }
    if (beforeTimestampMs === undefined) {
      return true;
    }
    const sentAt = message.get('sent_at') || message.get('received_at') || 0;
    return sentAt <= beforeTimestampMs;
  });
}

async function clearRemotely(
  conversation: ConversationModel,
  targets: Array<MessageModel>,
  scope: ClearScope
) {
  if (!targets.length) {
    return;
  }

  if (conversation.isPrivate()) {
    // Build the unsend requests before anything strips the hashes off those messages.
    const unsendMsgObjects = getUnsendMessagesObjects1o1(conversation, targets);

    if (scope === 'both') {
      // Only 'both' purges our own swarm copies and tells our linked devices:
      // doing either under 'others_only' would delete our side too.
      await deleteMessagesFromSwarmOnly(conversation, targets);
    }

    await sendUnsendRequests1o1(conversation, unsendMsgObjects, {
      toPeer: true,
      toOurDevices: scope === 'both',
    });
    return;
  }

  if (conversation.isClosedGroupV2() && PubKey.is03Pubkey(conversation.id)) {
    // Deleting by hash rather than via the group's deleteBeforeSeconds config,
    // because that config can only ever mean "everything before now" and would
    // therefore ignore a retention cutoff.
    await deleteMessagesFromSwarmOnly(conversation, targets);
    await unsendMessagesForEveryoneGroupV2({
      groupPk: conversation.id,
      msgsToDelete: targets,
      allMessagesFrom: [],
    });
  }
}

async function clearLocally(
  conversation: ConversationModel,
  beforeTimestampMs: number | undefined
) {
  if (beforeTimestampMs === undefined) {
    await deleteAllMessagesByConvoIdNoConfirmation(conversation.id);
    return;
  }

  const deletedIds = await Data.removeAllMessagesInConversationSentBefore({
    deleteBeforeSeconds: Math.floor(beforeTimestampMs / 1000),
    conversationId: conversation.id,
  });

  if (deletedIds.length) {
    window.inboxStore?.dispatch(
      messagesExpired(deletedIds.map(messageId => ({ conversationId: conversation.id, messageId })))
    );
    // not awaited on purpose: updateLastMessage is throttled and returns unknown
    conversation.updateLastMessage();
  }
}

/**
 * Clears a conversation with the given scope, optionally only the part of it
 * older than `beforeTimestampMs` (that is what the auto-clear retention timer
 * passes; a manual clear passes nothing and takes the whole thread).
 *
 * A scope the conversation cannot honour degrades rather than failing: `both`
 * becomes a local wipe, `others_only` becomes a no-op. Returns how many
 * messages were targeted.
 */
export async function cleanConversation({
  conversationId,
  scope,
  beforeTimestampMs,
}: {
  conversationId: string;
  scope: ClearScope;
  beforeTimestampMs?: number;
}): Promise<number> {
  const conversation = ConvoHub.use().get(conversationId);
  if (!conversation) {
    return 0;
  }

  const remotePossible = scope === 'device_only' ? false : await canClearRemotely(conversationId);
  if (scope !== 'device_only' && !remotePossible) {
    window.log.info(
      `cleanConversation: remote clear not supported for ${conversation.id}, ${
        scope === 'both' ? 'falling back to a local clear' : 'nothing to do'
      }`
    );
    if (scope === 'others_only') {
      return 0;
    }
  }

  const targets = await targetsFor(conversationId, beforeTimestampMs);

  if (remotePossible) {
    await clearRemotely(conversation, targets, scope);
  }

  if (scope !== 'others_only') {
    await clearLocally(conversation, beforeTimestampMs);
  }

  return targets.length;
}

/**
 * Applies one scope to every conversation.
 *
 * Note-to-Self is skipped entirely, and a conversation that throws is logged and
 * stepped over -- one bad thread must never abort the whole sweep.
 */
export async function cleanAllConversations({
  scope,
  beforeTimestampMs,
}: {
  scope: ClearScope;
  beforeTimestampMs?: number;
}): Promise<number> {
  const conversations = ConvoHub.use()
    .getConversations()
    .filter(convo => !convo.isMe());

  const cleared = await Promise.all(
    conversations.map(async convo => {
      try {
        const count = await cleanConversation({
          conversationId: convo.id,
          scope,
          beforeTimestampMs,
        });
        return count > 0 ? 1 : 0;
      } catch (error) {
        window.log.warn(`cleanAllConversations: skipping ${convo.id}`, error);
        return 0;
      }
    })
  );

  return compact(cleared).length;
}
