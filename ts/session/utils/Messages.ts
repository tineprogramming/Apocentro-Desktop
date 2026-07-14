import { OutgoingRawMessage } from '../types/RawMessage';

import { SnodeNamespaces } from '../apis/snode_api/namespaces';
import { ContentMessageNoProfile } from '../messages/outgoing';
import { VisibleMessage } from '../messages/outgoing/visibleMessage/VisibleMessage';
import { PubKey } from '../types';

export function toRawMessage(
  destinationPubKey: PubKey,
  message: ContentMessageNoProfile,
  namespace: SnodeNamespaces
): OutgoingRawMessage {
  const ttl = message.ttl();
  const plainTextBuffer = message.plainTextBuffer();

  const rawMessage: OutgoingRawMessage = {
    dbMessageIdentifier: message.dbMessageIdentifier,
    plainTextBuffer,
    device: destinationPubKey.key,
    ttl,
    namespace,
    networkTimestampCreated: message.createAtNetworkTimestamp,
    // Apocentro: a real 1:1 chat message is a VisibleMessage to the Default namespace. Flag it so
    // MessageSender fires the closed-iOS message-wake push only for these (not receipts/typing).
    isApocentroVisibleDm: message instanceof VisibleMessage && namespace === SnodeNamespaces.Default,
  };

  return rawMessage;
}
