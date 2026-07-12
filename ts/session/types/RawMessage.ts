import { SnodeNamespaces } from '../apis/snode_api/namespaces';

export type OutgoingRawMessage = {
  dbMessageIdentifier: string;
  plainTextBuffer: Uint8Array;
  device: string;
  ttl: number; // ttl is in ms
  networkTimestampCreated: number;
  namespace: SnodeNamespaces;
  // Apocentro: true for a real 1:1 chat message (VisibleMessage to a contact's Default namespace).
  // Gates the message-wake push (Option B) so it fires only for chat messages, not receipts/typing.
  // Optional + a plain boolean, so it round-trips through the pending-message cache via spread.
  isApocentroVisibleDm?: boolean;
};

export type StoredRawMessage = Pick<
  OutgoingRawMessage,
  'dbMessageIdentifier' | 'device' | 'ttl' | 'networkTimestampCreated'
> & {
  plainTextBufferHex: string;
  namespace: number; // read it as number, we need to check that it is indeed a valid namespace once loaded
};
