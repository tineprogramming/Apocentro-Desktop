import type { GroupPubkeyType, PubkeyType } from 'libsession_util_nodejs';

import { ConvoHub } from '../../session/conversations';
import { UserUtils } from '../../session/utils';
import { GroupInvite } from '../../session/utils/job_runners/jobs/GroupInviteJob';
import { GroupSync } from '../../session/utils/job_runners/jobs/GroupSyncJob';
import { RunJobResult } from '../../session/utils/job_runners/PersistedJob';
import { MetaGroupWrapperActions } from '../../webworker/workers/browser/libsession_worker_interface';
import { SuperAdmin } from '../../util/superAdmin';
import { getAppDispatch } from '../../state/dispatch';
import { groupInfoActions } from '../../state/ducks/metaGroups';
import { setDisappearingMessagesByConvoId } from '../conversationInteractions';

/**
 * Apocentro: "kick" an admin out of a group.
 *
 * Admins can never be removed from an existing group -- they hold the same shared admin
 * key everybody else does -- so the only real recourse is to build the group again
 * without them. This automates exactly that, in the same five steps Android takes
 * (`SuperAdminManager.kickAdmin`):
 *
 *   1. snapshot the old group (name, visible description, avatar, timer, roster),
 *   2. create a new group with the same name/description and every member except the
 *      kicked admin (members are invited automatically; we become its super admin),
 *   3. copy the avatar and the disappearing-messages timer,
 *   4. re-send admin promotions to the surviving admins (best effort -- they complete
 *      once those members accept the invite),
 *   5. delete the old group for everyone.
 *
 * Message history is deliberately NOT carried over: the new group has new keys, so the
 * kicked admin cannot decrypt anything sent after the kick.
 *
 * @returns the pubkey of the group that replaced the old one
 */
export async function kickAdminAndRecreateGroup(
  groupPk: GroupPubkeyType,
  kicked: PubkeyType
): Promise<GroupPubkeyType> {
  const us = UserUtils.getOurPubKeyStrFromCache();
  if (kicked === us) {
    throw new Error('kickAdminAndRecreateGroup: cannot kick ourselves');
  }

  // 1. snapshot
  const infos = await MetaGroupWrapperActions.infoGet(groupPk);
  if (!infos) {
    throw new Error('kickAdminAndRecreateGroup: infoGet is empty');
  }
  const allMembers = await MetaGroupWrapperActions.memberGetAll(groupPk);
  const others = allMembers.filter(m => m.pubkeyHex !== us && m.pubkeyHex !== kicked);
  const remainingMembers = others.map(m => m.pubkeyHex);
  const survivingAdmins = others.filter(m => m.nominatedAdmin).map(m => m.pubkeyHex);

  const oldConvo = ConvoHub.use().get(groupPk);
  const oldExpirationMode = oldConvo?.getExpirationMode();
  const oldExpireTimer = oldConvo?.getExpireTimer();

  // 2. create the replacement group (this invites every member and makes us its super admin)
  const dispatch = getAppDispatch();
  const created: any = await (
    dispatch(
      groupInfoActions.initNewGroupInWrapper({
        groupName: infos.name || '',
        groupDescription: SuperAdmin.strip(infos.description),
        members: [us, ...remainingMembers],
        us,
        inviteAsAdmin: false,
      }) as any
    ) as any
  ).unwrap();

  const newGroupPk = created?.groupPk as GroupPubkeyType | undefined;
  if (!newGroupPk) {
    throw new Error('kickAdminAndRecreateGroup: the replacement group was not created');
  }

  // 3. make the new group look and behave like the old one (best effort, as on Android)
  try {
    if (infos.profilePicture?.url) {
      const newInfos = await MetaGroupWrapperActions.infoGet(newGroupPk);
      if (newInfos) {
        newInfos.profilePicture = infos.profilePicture;
        await MetaGroupWrapperActions.infoSet(newGroupPk, newInfos);
        const pushed = await GroupSync.pushChangesToGroupSwarmIfNeeded({
          groupPk: newGroupPk,
          extraStoreRequests: [],
          allow401s: false,
        });
        if (pushed !== RunJobResult.Success) {
          window?.log?.warn('kickAdminAndRecreateGroup: failed to push the copied avatar');
        }
      }
    }
    if (oldExpirationMode && oldExpirationMode !== 'off' && oldExpireTimer) {
      await setDisappearingMessagesByConvoId(newGroupPk, oldExpirationMode, oldExpireTimer);
    }
  } catch (e) {
    window?.log?.warn(
      'kickAdminAndRecreateGroup: could not copy the group appearance/timer',
      e.message
    );
  }

  // 4. re-promote the admins who stayed
  for (let index = 0; index < survivingAdmins.length; index++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await GroupInvite.addJob({
        groupPk: newGroupPk,
        member: survivingAdmins[index],
        inviteAsAdmin: true,
      });
    } catch (e) {
      window?.log?.warn('kickAdminAndRecreateGroup: could not re-promote an admin', e.message);
    }
  }

  // 5. destroy the old group for every member
  await ConvoHub.use().deleteGroup(groupPk, {
    fromSyncMessage: false,
    sendLeaveMessage: false,
    deletionType: 'doNotKeep',
    deleteAllMessagesOnSwarm: false,
    forceDestroyForAllMembers: true,
    clearFetchedHashes: true,
  });

  return newGroupPk;
}
