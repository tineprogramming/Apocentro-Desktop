import type { GroupPubkeyType, PubkeyType } from 'libsession_util_nodejs';
import { compact } from 'lodash';

import type { MessageModel } from '../../models/message';
import { getSodiumRenderer } from '../../session/crypto';
import { GroupUpdateDeleteMemberContentMessage } from '../../session/messages/outgoing/controlMessage/group_v2/to_group/GroupUpdateDeleteMemberContentMessage';
import { MessageQueue } from '../../session/sending';
import { UserGroupsWrapperActions } from '../../webworker/workers/browser/libsession_worker_interface';
import { NetworkTime } from '../../util/NetworkTime';
import { uuidV4 } from '../../util/uuid';

export async function hasGroupAdminKey(groupPk: GroupPubkeyType) {
  const group = await UserGroupsWrapperActions.getGroup(groupPk);
  return !!group?.secretKey?.length;
}

/**
 * Asks the group to delete those messages, by hash.
 *
 * Note: unlike the group's `deleteBeforeSeconds` config (which can only ever mean
 * "everything before now"), this targets an explicit set of messages, so it also
 * works for a retention sweep that only removes messages older than a cutoff.
 */
export async function unsendMessagesForEveryoneGroupV2({
  allMessagesFrom,
  groupPk,
  msgsToDelete,
}: {
  groupPk: GroupPubkeyType;
  msgsToDelete: Array<MessageModel>;
  allMessagesFrom: Array<PubkeyType>;
}) {
  const messageHashesToUnsend = compact(msgsToDelete.map(m => m.getMessageHash()));
  const group = await UserGroupsWrapperActions.getGroup(groupPk);

  if (!messageHashesToUnsend.length && !allMessagesFrom.length) {
    window.log.info('unsendMessagesForEveryoneGroupV2: no hashes nor author to remove');
    return true;
  }

  const storedAt = await MessageQueue.use().sendToGroupV2NonDurably({
    message: new GroupUpdateDeleteMemberContentMessage({
      createAtNetworkTimestamp: NetworkTime.now(),
      expirationType: 'unknown', // GroupUpdateDeleteMemberContentMessage is not displayed so not expiring.
      expireTimer: 0,
      groupPk,
      memberSessionIds: allMessagesFrom,
      messageHashes: messageHashesToUnsend,
      sodium: await getSodiumRenderer(),
      secretKey: group?.secretKey || undefined,
      dbMessageIdentifier: uuidV4(),
    }),
  });
  return !!storedAt;
}
