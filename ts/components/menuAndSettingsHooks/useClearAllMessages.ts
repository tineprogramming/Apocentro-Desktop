import { getAppDispatch } from '../../state/dispatch';
import { deleteAllMessagesByConvoIdNoConfirmation } from '../../interactions/conversationInteractions';
import { cleanConversation } from '../../interactions/conversations/messageCleaner';
import { updateConfirmModal } from '../../state/ducks/modalDialog';
import { SessionButtonColor } from '../basic/SessionButton';
import { tr, type TrArgs } from '../../localization/localeTools';
import {
  useConversationUsernameWithFallback,
  useIsGroupV2,
  useIsKickedFromGroup,
  useIsLegacyGroup,
  useIsMe,
  useIsPrivate,
  useIsPublic,
  useWeAreAdmin,
} from '../../hooks/useParamSelector';
import { ToastUtils } from '../../session/utils';
import { PubKey } from '../../session/types';
import type { RadioOptions } from '../dialog/SessionConfirm';
import type { ClearScope } from '../../interactions/conversations/messageCleaner';

/**
 * Note: deliberately a plain function rather than inline in the hook below. The react
 * compiler cannot yet handle a try/catch containing value blocks (optional chaining and
 * friends), so keeping this out of the hook body is what lets the hook compile.
 */
async function cleanReportingFailure(conversationId: string, scope: ClearScope): Promise<boolean> {
  try {
    await cleanConversation({ conversationId, scope });
    return true;
  } catch (error) {
    window?.log?.warn('useClearAllMessagesCb: failed to clear remotely', error);
    return false;
  }
}

export function useClearAllMessagesCb({ conversationId }: { conversationId: string }) {
  const dispatch = getAppDispatch();

  const isKickedFromGroup = useIsKickedFromGroup(conversationId);
  const isMe = useIsMe(conversationId);
  const isPublic = useIsPublic(conversationId);

  const isGroupV2 = useIsGroupV2(conversationId);
  const weAreAdmin = useWeAreAdmin(conversationId);
  const isLegacyGroup = useIsLegacyGroup(conversationId);
  const conversationTitle = useConversationUsernameWithFallback(false, conversationId);
  const isPrivate = useIsPrivate(conversationId);

  if (isKickedFromGroup) {
    // we can't clear all if we are kicked from the group
    return null;
  }

  const onClickClose = () => {
    dispatch(updateConfirmModal(null));
  };

  const clearMessagesForEveryone = 'clearMessagesForEveryone';
  const clearOthersOnly = 'clearOthersOnly';

  const onClickOk = async (...args: Array<any>) => {
    if (
      (canClearForEveryone1o1 || isGroupV2AndAdmin) &&
      (args[0] === clearMessagesForEveryone || args[0] === clearOthersOnly)
    ) {
      const cleared = await cleanReportingFailure(
        conversationId,
        args[0] === clearOthersOnly ? 'others_only' : 'both'
      );
      if (cleared) {
        ToastUtils.pushDeleted(2);
      } else {
        ToastUtils.pushToastError('clearMessagesForEveryone', tr('clearMessagesFailedDev'));
      }
      onClickClose();
    } else {
      await deleteAllMessagesByConvoIdNoConfirmation(conversationId);
      ToastUtils.pushDeleted(2);
      onClickClose();
    }
  };

  const isGroupV2AndAdmin = isGroupV2 && weAreAdmin;
  // Apocentro: 1:1 chats have no "admin", but either participant can request
  // deletion of the whole shared thread -- mirrors the group admin case.
  // Blinded conversations (community DMs) are excluded: we have no way to reach
  // the other side's swarm for them, so "for everyone" could never work there.
  const canClearForEveryone1o1 = isPrivate && !isMe && PubKey.is05Pubkey(conversationId);

  const i18nMessage: TrArgs | null = isMe
    ? { token: 'clearMessagesNoteToSelfDescriptionUpdated' }
    : isPublic
      ? { token: 'clearMessagesCommunityUpdated', community_name: conversationTitle }
      : isPrivate
        ? { token: 'clearMessagesChatDescriptionUpdated', name: conversationTitle }
        : isLegacyGroup || (isGroupV2 && !weAreAdmin)
          ? {
              token: 'clearMessagesGroupDescriptionUpdated',
              group_name: conversationTitle,
            }
          : isGroupV2AndAdmin
            ? {
                token: 'clearMessagesChatDescriptionUpdated',
                name: conversationTitle,
              }
            : null;

  if (!i18nMessage) {
    throw new Error('useClearAllMessagesCb: invalid case');
  }

  const deviceOnlyItem = {
    value: 'clearOnThisDevice',
    label: tr('clearOnThisDevice'),
    inputDataTestId: 'clear-device-radio-option',
    labelDataTestId: 'clear-device-radio-option-label',
  } as const;
  const forEveryoneItem = {
    value: clearMessagesForEveryone,
    label: tr(clearMessagesForEveryone),
    inputDataTestId: 'clear-everyone-radio-option',
    labelDataTestId: 'clear-everyone-radio-option-label',
  } as const;
  // Note: in a group this cannot fully keep our copy. The deletion reaches
  // members through a GroupUpdateDeleteMemberContentMessage sent to the shared
  // group swarm, which our own client polls and applies too (there is no
  // self-exclusion in handleGroupUpdateDeleteMemberContentMessage, and the
  // protocol has no way to say "everyone but the sender"). Offered anyway so the
  // group dialog matches Android's, which has the same limitation.
  const othersOnlyItem = {
    value: clearOthersOnly,
    label: tr('clearOthersOnlyDev'),
    inputDataTestId: 'clear-others-radio-option',
    labelDataTestId: 'clear-others-radio-option-label',
  } as const;

  const radioOptions: RadioOptions | undefined = canClearForEveryone1o1
    ? {
        items: [deviceOnlyItem, othersOnlyItem, forEveryoneItem],
        defaultSelectedValue: 'clearOnThisDevice',
      }
    : isGroupV2AndAdmin
      ? {
          items: [deviceOnlyItem, othersOnlyItem, forEveryoneItem],
          defaultSelectedValue: 'clearOnThisDevice',
        }
      : undefined;

  const cb = () =>
    dispatch(
      updateConfirmModal({
        title: { token: 'clearMessages' },
        i18nMessage,
        onClickOk,
        okTheme: SessionButtonColor.Danger,
        onClickClose,
        okText: { token: 'clear' },
        radioOptions,
      })
    );

  return cb;
}
