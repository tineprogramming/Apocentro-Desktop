import { compact, isArray } from 'lodash';
import { useDispatch } from 'react-redux';
import { updateConfirmModal } from '../../state/ducks/modalDialog';
import {
  useIsLegacyGroup,
  useIsMe,
  useIsPrivate,
  useIsPublic,
  useWeAreAdmin,
} from '../../hooks/useParamSelector';
import { SessionButtonColor } from '../basic/SessionButton';
import { closeRightPanel, resetSelectedMessageIds } from '../../state/ducks/conversations';
import { tr, type TrArgs } from '../../localization/localeTools';
import { useWeAreCommunityAdminOrModerator } from '../../state/selectors/conversations';
import type { ConversationModel } from '../../models/conversation';
import type { MessageModel } from '../../models/message';
import { PubKey } from '../../session/types';
import { ToastUtils } from '../../session/utils';
import { Data } from '../../data/data';
import { MessageQueue } from '../../session/sending';

import { deleteSogsMessageByServerIds } from '../../session/apis/open_group_api/sogsv3/sogsV3DeleteMessages';
import { SnodeNamespaces } from '../../session/apis/snode_api/namespaces';
import { deleteOrMarkAsDeletedMessages } from '../../interactions/conversations/deleteOrMarkAsDeletedMessages';
import { sectionActions } from '../../state/ducks/section';
import { ConvoHub } from '../../session/conversations';
import { isUsAnySogsFromCache } from '../../session/apis/open_group_api/sogsv3/knownBlindedkeys';
import type { RadioOptions } from '../dialog/SessionConfirm';
import { deleteMessagesFromSwarmOnly } from '../../interactions/conversations/deleteMessagesFromSwarmOnly';
import {
  getUnsendMessagesObjects1o1,
  unsendMessagesForEveryone1o1,
} from '../../interactions/conversations/unsendMessages1o1';
import {
  hasGroupAdminKey,
  unsendMessagesForEveryoneGroupV2,
} from '../../interactions/conversations/unsendMessagesGroupV2';

const deleteMessageDeviceOnly = 'deleteMessageDeviceOnly';
const deleteMessageAllMyDevices = 'deleteMessageDevicesAll';
const deleteMessageEveryone = 'deleteMessageEveryone';

type MessageDeletionType =
  | typeof deleteMessageDeviceOnly
  | typeof deleteMessageAllMyDevices
  | typeof deleteMessageEveryone;

/**
 * Offer to delete for everyone or not, based on what is currently selected
 * and our role in the corresponding conversation.
 */
export function useDeleteMessagesCb(conversationId: string | undefined) {
  const dispatch = useDispatch();

  const isNts = useIsMe(conversationId);
  const isPublic = useIsPublic(conversationId);
  const weAreAdminOrModCommunity = useWeAreCommunityAdminOrModerator(conversationId);
  const weAreAdminGroup = useWeAreAdmin(conversationId);
  const isLegacyGroup = useIsLegacyGroup(conversationId);
  const isPrivateChat = useIsPrivate(conversationId);

  const closeDialog = () => dispatch(updateConfirmModal(null));

  if (!conversationId) {
    return null;
  }

  return async (
    messageIds: string | Array<string> | undefined,
    dataAttachmentIndex: number | null
  ) => {
    const count = isArray(messageIds) ? messageIds.length : messageIds ? 1 : 0;
    const convo = ConvoHub.use().get(conversationId);
    if (!convo || !messageIds || (!isArray(messageIds) && !messageIds.length)) {
      return;
    }
    const messageIdsArr = isArray(messageIds) ? messageIds : [messageIds];

    // legacy groups are read only, we can only delete locally.
    const canDeleteAllForEveryoneAsAdmin =
      !isLegacyGroup && ((isPublic && weAreAdminOrModCommunity) || (!isPublic && weAreAdminGroup));

    const msgModels = await Data.getMessagesById(messageIdsArr);
    const senders = compact(msgModels.map(m => m.getSource()));

    const anyAreMarkAsDeleted = msgModels.some(m => m.isMarkedAsDeleted());
    const anyAreControlMessages = msgModels.some(m => m.isControlMessage());
    // If it's a single message that has attachment and one of those have been clicked, the title and description is slightly different
    const singleDeleteFromAttachment =
      msgModels.length === 1 && msgModels[0].hasAttachments() && dataAttachmentIndex !== null;
    const singleMessageAttachmentCount = singleDeleteFromAttachment
      ? msgModels[0].getAttachments().length
      : 0;
    const singleDeleteFromAttachmentWithMultiple =
      singleDeleteFromAttachment && singleMessageAttachmentCount > 1;

    // We can technically never delete for everyone if one of the message is
    // - a control message
    // - a message marked as deleted
    // - a message that is sending or failed to be sent (as we need a hash to delete globally)
    // In this case, the only option is to delete locally.
    // BUT, because we love inconsistencies we still allow to delete globally a sending or failed to be sent message.
    // This does nothing on the backend, but makes a nice UX, apparently.
    const sharedCannotDeleteForEveryone = anyAreControlMessages || anyAreMarkAsDeleted;

    const canDeleteAllForEveryoneAsMe = senders.every(isUsAnySogsFromCache);
    // Apocentro: in a 1:1 chat there's no "admin", but either participant can
    // request deletion of any message in their shared thread -- mirrors the
    // group admin case, and matches the "clear whole chat for everyone" flow.
    // Blinded conversations (community DMs) are excluded: unsend requests need a
    // 05 key, so offering "for everyone" there would always fail.
    const canDeleteAllForEveryoneAsPrivateChatPartner =
      isPrivateChat && !isNts && PubKey.is05Pubkey(conversationId);
    const canDeleteAllForEveryone =
      (canDeleteAllForEveryoneAsMe ||
        canDeleteAllForEveryoneAsAdmin ||
        canDeleteAllForEveryoneAsPrivateChatPartner) &&
      !sharedCannotDeleteForEveryone;

    const canDeleteFromAllDevices = isNts && !sharedCannotDeleteForEveryone;

    // Note: the isMe case has no radio buttons, so we just show the description below
    const i18nMessage: TrArgs | undefined = {
      token: singleDeleteFromAttachment ? 'deleteAttachmentsDescription' : 'deleteMessageConfirm',
      count: singleDeleteFromAttachmentWithMultiple ? singleMessageAttachmentCount : count,
    };
    const title: TrArgs = {
      token: singleDeleteFromAttachment ? 'deleteAttachments' : 'deleteMessage',
      count: singleDeleteFromAttachmentWithMultiple ? singleMessageAttachmentCount : count,
    };

    const warningMessage: TrArgs | undefined =
      isNts && !canDeleteFromAllDevices
        ? { token: 'deleteMessageNoteToSelfWarning', count }
        : !isNts && !canDeleteAllForEveryone
          ? {
              token: 'deleteMessageWarning',
              count,
            }
          : undefined;

    const radioOptions: RadioOptions | undefined = {
      items: [
        {
          label: tr(deleteMessageDeviceOnly),
          value: deleteMessageDeviceOnly,
          inputDataTestId: `input-${deleteMessageDeviceOnly}` as const,
          labelDataTestId: `label-${deleteMessageDeviceOnly}` as const,
          disabled: false, // we can always delete messages locally
        },
        isNts
          ? {
              label: tr(deleteMessageAllMyDevices),
              value: deleteMessageAllMyDevices,
              inputDataTestId: `input-${deleteMessageAllMyDevices}` as const,
              labelDataTestId: `label-${deleteMessageAllMyDevices}` as const,
              disabled: !canDeleteFromAllDevices,
            }
          : {
              label: tr(deleteMessageEveryone),
              value: deleteMessageEveryone,
              inputDataTestId: `input-${deleteMessageEveryone}` as const,
              labelDataTestId: `label-${deleteMessageEveryone}` as const,
              disabled: !canDeleteAllForEveryone,
            },
      ],
      defaultSelectedValue: !isNts && canDeleteAllForEveryone ? deleteMessageEveryone : undefined,
    };

    dispatch(
      updateConfirmModal({
        title,
        i18nMessage,
        radioOptions,

        okText: { token: 'delete' },
        warningMessage,

        okTheme: SessionButtonColor.Danger,
        onClickOk: async args => {
          if (
            args !== deleteMessageEveryone &&
            args !== deleteMessageAllMyDevices &&
            args !== deleteMessageDeviceOnly
          ) {
            throw new Error('doDeleteSelectedMessages: invalid args onClickOk');
          }

          const noErrors = await doDeleteSelectedMessages({
            selectedMessages: msgModels,
            conversation: convo,
            deletionType: args,
          });
          if (noErrors) {
            dispatch(updateConfirmModal(null));
            dispatch(closeRightPanel());
            dispatch(sectionActions.resetRightOverlayMode());
          }
        },
        onClickClose: closeDialog,
      })
    );
  };
}

/**
 * Delete the messages from the conversation.
 * Also deletes messages from the swarm/sogs if needed, sends unsend requests for syncing etc...
 *
 * Note: this function does not check if the user is allowed to delete the messages.
 * The call will just fail if the user is not allowed to delete the messages.
 * So make sure to check the user permissions before calling this function and to display only valid actions for the user's permissions.
 *
 * Returns true if the modal should be closed (i.e. messages were deleted as expected)
 */
async function doDeleteSelectedMessages({
  conversation,
  selectedMessages,
  deletionType,
}: {
  conversation: ConversationModel;
  selectedMessages: Array<MessageModel>;
  deletionType: MessageDeletionType;
}) {
  if (selectedMessages.length === 0) {
    window.log.info('doDeleteSelectedMessages: no messages selected');
    return true;
  }

  // legacy groups are read only
  if (conversation.isClosedGroup() && PubKey.is05Pubkey(conversation.id)) {
    window.log.info(
      'doDeleteSelectedMessages: legacy groups are read only. Only removing those messages locally'
    );
    await deleteOrMarkAsDeletedMessages({
      conversation,
      messages: selectedMessages,
      deletionType: 'complete',
      actionContextIsUI: true,
    });
    return true;
  }

  if (deletionType === deleteMessageDeviceOnly) {
    // Delete on device only is an easy case.
    // `deleteOrMarkAsDeletedMessages` will forcefully remove
    // - control messages or
    // - already marked as deleted messages
    await deleteOrMarkAsDeletedMessages({
      conversation,
      messages: selectedMessages,
      deletionType: 'markDeletedThisDevice',
      actionContextIsUI: true,
    });
    // this can never fail
    ToastUtils.pushDeleted(selectedMessages.length);
    window.inboxStore?.dispatch(resetSelectedMessageIds());

    return true;
  }

  if (deletionType === deleteMessageAllMyDevices) {
    if (!conversation.isMe()) {
      throw new Error(
        ' doDeleteSelectedMessages: invalid deletionType: "deleteMessageAllMyDevices" for a different conversation than ours'
      );
    }
    // Delete those messages locally, from our swarm and from our other devices, but not for anyone else in the conversation
    const deletedFromOurSwarm = await unsendMessageJustForThisUserAllDevices(
      conversation,
      selectedMessages
    );
    return deletedFromOurSwarm;
  }

  // device only was handled above, so this isOpenGroupV2 can only mean delete for everyone in a community
  if (conversation.isOpenGroupV2()) {
    // this shows a toast on success or failure
    const deletedFromSogs = await doDeleteSelectedMessagesInSOGS(selectedMessages, conversation);
    return deletedFromSogs;
  }

  // sanity check that this is the last available option
  if (deletionType !== deleteMessageEveryone) {
    throw new Error(`doDeleteSelectedMessages: invalid deletionType: "${deletionType}"`);
  }

  if (conversation.isPrivate()) {
    if (conversation.isMe()) {
      throw new Error(
        'the NTS case should have been deleteMessageDeviceOnly or deleteMessageAllMyDevices'
      );
    }
    // Note: we cannot delete for everyone a message in a non 05-private chat
    if (!PubKey.is05Pubkey(conversation.id)) {
      throw new Error('unsendMessagesForEveryone1o1 requires a 05 key');
    }

    // build the unsendMsgObjects before we delete the hash from those messages
    const unsendMsgObjects = getUnsendMessagesObjects1o1(conversation, selectedMessages);

    // Note: not calling deleteMessagesFromSwarmAndMarkAsDeletedLocally here as
    // we've got some custom logic going on
    const deletedFromSwarm = await deleteMessagesFromSwarmOnly(conversation, selectedMessages);
    if (!deletedFromSwarm) {
      window.log.warn(
        'unsendMessagesForEveryone1o1: failed to delete from swarm. Not sending unsend requests'
      );
      ToastUtils.pushFailedToDelete(selectedMessages.length);
      return false;
    }
    // Apocentro: remove the messages outright rather than leaving a "This message was
    // deleted" placeholder. The other side now does the same on receipt, so a 1:1
    // delete for everyone leaves nothing behind on either device.
    await deleteOrMarkAsDeletedMessages({
      conversation,
      messages: selectedMessages,
      deletionType: 'complete',
      actionContextIsUI: true,
    });

    await unsendMessagesForEveryone1o1(conversation, unsendMsgObjects);

    ToastUtils.pushDeleted(selectedMessages.length);
    window.inboxStore?.dispatch(resetSelectedMessageIds());

    return true;
  }

  if (!conversation.isClosedGroupV2() || !PubKey.is03Pubkey(conversation.id)) {
    // considering the above, the only valid case here is 03 groupv2
    throw new Error('doDeleteSelectedMessages: invalid conversation type');
  }

  const weAreAdmin = await hasGroupAdminKey(conversation.id);
  // 03 groups: mark as deleted
  if (weAreAdmin) {
    // when we are an admin, we first delete the messages from the swarm
    // Note: not calling deleteMessagesFromSwarmAndMarkAsDeletedLocally here as
    // we've got some custom logic going on
    const deletedFromGroupSwarm = await deleteMessagesFromSwarmOnly(conversation, selectedMessages);
    if (!deletedFromGroupSwarm) {
      window.log.warn(
        'unsendMessagesForEveryone1o1: failed to delete from group swarm. Not sending unsend requests'
      );
      ToastUtils.pushFailedToDelete(selectedMessages.length);

      return false;
    }

    if (!deletedFromGroupSwarm) {
      window.log.warn(
        'unsendMessagesForEveryoneGroupV2: failed to delete messages on group swarm:'
      );
      return false;
    }
  }

  // Here, either we've removed those messages from the swarm as an admin,
  // or we want to request the admin to delete them for us.
  // Those messages have to be ours in this case.

  const groupV2UnsendSent = await unsendMessagesForEveryoneGroupV2({
    groupPk: conversation.id,
    msgsToDelete: selectedMessages,
    allMessagesFrom: [], // currently we cannot remove all the messages from a specific pubkey but we do already handle them on the receiving side
  });

  if (!groupV2UnsendSent) {
    window.log.warn(
      'unsendMessagesForEveryoneGroupV2: failed to send our groupv2 unsend for everyone'
    );
    ToastUtils.pushFailedToDelete(selectedMessages.length);
    return false;
  }
  await deleteOrMarkAsDeletedMessages({
    conversation,
    messages: selectedMessages,
    deletionType: 'markDeletedGlobally',
    actionContextIsUI: true,
  });
  window.inboxStore?.dispatch(resetSelectedMessageIds());
  ToastUtils.pushDeleted(selectedMessages.length);

  return true;
}

/**
 * Delete those message hashes from our swarm.
 * On success, send an UnsendMessage synced message so our devices removes those already fetched messages.
 * Then, deletes completely the messages locally.
 *
 * Shows a toast on error/success and reset the selection
 */
async function unsendMessageJustForThisUserAllDevices(
  conversation: ConversationModel,
  msgsToDelete: Array<MessageModel>
) {
  // we can only delete the messages on the swarm when they've been sent
  const msgsToDeleteFromSwarm = msgsToDelete.filter(m => m.getMessageHash());
  window?.log?.info('Deleting messages just for this user');

  // get the unsendMsgObjects before we delete the hash from those messages
  const unsendMsgObjects = getUnsendMessagesObjects1o1(conversation, msgsToDeleteFromSwarm);

  // Note: not calling deleteMessagesFromSwarmAndCompletelyLocally here as
  // we've got some custom logic going on
  const deletedFromSwarm = await deleteMessagesFromSwarmOnly(conversation, msgsToDelete);

  // we want to locally only when we've manage to delete them from the swarm first
  if (!deletedFromSwarm) {
    window.log.warn(
      'unsendMessageJustForThisUserAllDevices: failed to delete from swarm. Not sending unsend requests'
    );
    ToastUtils.pushFailedToDelete(msgsToDelete.length);
    return false;
  }
  await deleteOrMarkAsDeletedMessages({
    conversation,
    messages: msgsToDelete,
    deletionType: 'complete',
    actionContextIsUI: true,
  });

  // deleting from the swarm worked, sending to our other devices all the messages separately for now
  await Promise.all(
    unsendMsgObjects.map(unsendObject =>
      MessageQueue.use()
        .sendSyncMessage({ namespace: SnodeNamespaces.Default, message: unsendObject })
        .catch(window?.log?.error)
    )
  );
  // Update view and trigger update
  window.inboxStore?.dispatch(resetSelectedMessageIds());
  ToastUtils.pushDeleted(unsendMsgObjects.length);
  return true;
}

/**
 * Attempt to delete the messages from the SOGS.
 * Note: this function does not check if the user is allowed to delete the messages.
 * The call will just fail if the user is not allowed to delete the messages.
 * So make sure to check the user permissions before calling this function and to display only valid actions for the user's permissions.
 *
 * Returns true if those messages could be removed from the SOGS and were removed locally.
 */
async function doDeleteSelectedMessagesInSOGS(
  selectedMessages: Array<MessageModel>,
  conversation: ConversationModel
) {
  const allSentRemovedFromSogs = await deleteOpenGroupMessages(selectedMessages, conversation);
  if (!allSentRemovedFromSogs) {
    // Failed to delete some/those messages from the sogs.
    ToastUtils.pushGenericError();
    return false;
  }

  await deleteOrMarkAsDeletedMessages({
    conversation,
    messages: selectedMessages,
    deletionType: 'complete',
    actionContextIsUI: true,
  });

  // successful deletion
  ToastUtils.pushDeleted(selectedMessages.length);
  window.inboxStore?.dispatch(resetSelectedMessageIds());
  return true;
}

/**
 *
 * @param messages the list of MessageModel to delete
 * @param convo the conversation to delete from (only v2 opengroups are supported)
 * Returns true if all the messages that had a serverId were removed from the sogs, false otherwise
 */
async function deleteOpenGroupMessages(messages: Array<MessageModel>, convo: ConversationModel) {
  if (!convo.isOpenGroupV2()) {
    throw new Error('cannot delete public message on a non public groups');
  }

  const roomInfos = convo.toOpenGroupV2();
  const msgsWithServerIdIdsToRemove = messages.filter(msg => msg.get('serverId'));

  let allMessagesAreDeleted: boolean = false;
  if (msgsWithServerIdIdsToRemove.length) {
    const serverIdsToRemove = compact(msgsWithServerIdIdsToRemove.map(m => m.get('serverId')));

    allMessagesAreDeleted = await deleteSogsMessageByServerIds(serverIdsToRemove, roomInfos);
    window?.log?.info(
      `Removed all serverIds messages from the sogs. count: ${serverIdsToRemove.length}`
    );

    if (!allMessagesAreDeleted) {
      window?.log?.info(
        'failed to remove all those serverIds from the sogs. not removing them locally neither'
      );
      return false;
    }
  }
  // remove the messages we managed to remove on the server and the ones that had no serverId (i.e. failed to send)

  return true;
}
