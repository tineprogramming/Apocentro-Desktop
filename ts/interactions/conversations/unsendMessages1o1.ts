import { compact } from 'lodash';

import type { ConversationModel } from '../../models/conversation';
import type { MessageModel } from '../../models/message';
import { UnsendMessage } from '../../session/messages/outgoing/controlMessage/UnsendMessage';
import { MessageQueue } from '../../session/sending';
import { SnodeNamespaces } from '../../session/apis/snode_api/namespaces';
import { PubKey } from '../../session/types';
import { NetworkTime } from '../../util/NetworkTime';
import { uuidV4 } from '../../util/uuid';

/**
 * Builds one UnsendRequest per message, keyed by that message's *own* author --
 * not necessarily us, since either participant of a 1:1 may ask for the shared
 * thread to be deleted.
 */
export function getUnsendMessagesObjects1o1(
  conversation: ConversationModel,
  messages: Array<MessageModel>
) {
  if (!conversation.isPrivate()) {
    throw new Error(
      'getUnsendMessagesObjects1o1: cannot send messages to a non-private conversation'
    );
  }
  return compact(
    messages.map((message, index) => {
      const author = message.get('source');

      // call getPropsForMessage here so we get the received_at or sent_at timestamp in timestamp
      const referencedMessageTimestamp = message.getPropsForMessage().timestamp;
      if (!referencedMessageTimestamp) {
        window?.log?.error('cannot find timestamp - aborting unsend request');
        return undefined;
      }

      return new UnsendMessage({
        // this isn't pretty, but we need a unique timestamp for Android to not drop the message as a duplicate
        createAtNetworkTimestamp: NetworkTime.now() + index,
        referencedMessageTimestamp,
        author,
        dbMessageIdentifier: uuidV4(),
      });
    })
  );
}

/**
 * Sends already-built unsend requests for a 1:1 conversation.
 *
 * The two destinations are independent so a caller can ask the peer to delete
 * their copies while keeping ours (the "others only" clear scope): syncing to
 * our own devices would make them delete ours too.
 */
export async function sendUnsendRequests1o1(
  conversation: ConversationModel,
  unsendMsgObjects: Array<UnsendMessage>,
  { toPeer, toOurDevices }: { toPeer: boolean; toOurDevices: boolean }
) {
  if (!conversation.isPrivate()) {
    throw new Error('sendUnsendRequests1o1 only works with private conversations');
  }
  if (unsendMsgObjects.length === 0) {
    return;
  }

  if (toPeer) {
    // sending to recipient all the messages separately for now
    await Promise.all(
      unsendMsgObjects.map(unsendObject =>
        MessageQueue.use()
          .sendToPubKey(new PubKey(conversation.id), unsendObject, SnodeNamespaces.Default)
          .catch(window?.log?.error)
      )
    );
  }

  if (toOurDevices) {
    await Promise.all(
      unsendMsgObjects.map(unsendObject =>
        MessageQueue.use()
          .sendSyncMessage({ namespace: SnodeNamespaces.Default, message: unsendObject })
          .catch(window?.log?.error)
      )
    );
  }
}

/**
 * Asks both the peer and our own linked devices to delete those messages.
 */
export async function unsendMessagesForEveryone1o1(
  conversation: ConversationModel,
  unsendMsgObjects: Array<UnsendMessage>
) {
  return sendUnsendRequests1o1(conversation, unsendMsgObjects, {
    toPeer: true,
    toOurDevices: true,
  });
}
