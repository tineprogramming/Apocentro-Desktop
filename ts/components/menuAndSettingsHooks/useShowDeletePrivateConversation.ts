import { getAppDispatch } from '../../state/dispatch';
import {
  useIsPrivate,
  useIsIncomingRequest,
  useIsMe,
  useConversationUsernameWithFallback,
} from '../../hooks/useParamSelector';
import { ConvoHub } from '../../session/conversations';
import { updateConfirmModal, updateConversationSettingsModal } from '../../state/ducks/modalDialog';
import { SessionButtonColor } from '../basic/SessionButton';
import { PubKey } from '../../session/types';
import { ToastUtils } from '../../session/utils';
import { tr } from '../../localization/localeTools';
import {
  cleanConversation,
  type ClearScope,
} from '../../interactions/conversations/messageCleaner';
import type { RadioOptions } from '../dialog/SessionConfirm';

function useShowDeletePrivateConversation({ conversationId }: { conversationId: string }) {
  const isPrivate = useIsPrivate(conversationId);
  const isRequest = useIsIncomingRequest(conversationId);
  const isMe = useIsMe(conversationId);

  return isPrivate && !isRequest && !isMe;
}

// NOTE: [react-compiler] this convinces the compiler the hook is static
const useConversationUsernameWithFallbackInternal = useConversationUsernameWithFallback;

const deleteConversationForEveryone = 'deleteConversationForEveryone';
const deleteOthersOnly = 'deleteOthersOnly';

/**
 * Note: deliberately a plain function rather than inline in the hook below. The react
 * compiler cannot yet handle a try/catch containing value blocks (optional chaining and
 * friends), so keeping this out of the hook body is what lets the hook compile.
 *
 * Returns true when the remote deletion went out.
 */
async function clearRemotelyReportingFailure(
  conversationId: string,
  scope: ClearScope
): Promise<boolean> {
  try {
    await cleanConversation({ conversationId, scope });
    return true;
  } catch (error) {
    window?.log?.warn('useShowDeletePrivateConversationCb: failed to delete remotely', error);
    return false;
  }
}

export function useShowDeletePrivateConversationCb({ conversationId }: { conversationId: string }) {
  const showDeletePrivateConversation = useShowDeletePrivateConversation({ conversationId });
  const dispatch = getAppDispatch();
  const name = useConversationUsernameWithFallbackInternal(true, conversationId);

  if (!showDeletePrivateConversation) {
    return null;
  }

  // Apocentro: a 1:1 chat can be deleted on this device only, or for both
  // participants (there's no "admin" for a 1:1, either side may ask). Blinded
  // conversations (community DMs) are excluded: unsend requests need a 05 key, so
  // "for everyone" could never work there.
  const canDeleteForEveryone = PubKey.is05Pubkey(conversationId);

  const onClickClose = () => {
    dispatch(updateConfirmModal(null));
  };

  const radioOptions: RadioOptions | undefined = canDeleteForEveryone
    ? {
        items: [
          {
            value: 'deleteOnThisDevice',
            label: tr('deleteOnThisDeviceDev'),
            inputDataTestId: 'delete-device-radio-option',
            labelDataTestId: 'delete-device-radio-option-label',
          },
          {
            value: deleteOthersOnly,
            label: tr('deleteOthersOnlyDev'),
            inputDataTestId: 'delete-others-radio-option',
            labelDataTestId: 'delete-others-radio-option-label',
          },
          {
            value: deleteConversationForEveryone,
            label: tr('deleteConversationForEveryoneDev'),
            inputDataTestId: 'delete-everyone-radio-option',
            labelDataTestId: 'delete-everyone-radio-option-label',
          },
        ] as const,
        defaultSelectedValue: 'deleteOnThisDevice',
      }
    : undefined;

  const showConfirmationModal = () => {
    dispatch(
      updateConfirmModal({
        title: { token: 'conversationsDelete' },
        i18nMessage: { token: 'deleteConversationDescription', name },
        onClickClose,
        okTheme: SessionButtonColor.Danger,
        radioOptions,
        onClickOk: async (...args: Array<any>) => {
          const othersOnly = canDeleteForEveryone && args[0] === deleteOthersOnly;
          const forEveryone = canDeleteForEveryone && args[0] === deleteConversationForEveryone;

          if (othersOnly || forEveryone) {
            // wipe the thread on the other side before removing the conversation
            // itself, while we still have the messages to unsend
            const cleared = await clearRemotelyReportingFailure(
              conversationId,
              othersOnly ? 'others_only' : 'both'
            );
            if (!cleared) {
              ToastUtils.pushToastError(
                deleteConversationForEveryone,
                tr('deleteConversationForEveryoneFailedDev')
              );
              return;
            }
          }

          if (othersOnly) {
            // "others only" keeps our side of the conversation, so the thread
            // itself stays in the list -- only their copies were removed.
            dispatch(updateConfirmModal(null));
            dispatch(updateConversationSettingsModal(null));
            return;
          }

          await ConvoHub.use().delete1o1(conversationId, {
            fromSyncMessage: false,
            justHidePrivate: true,
            keepMessages: false,
          });
          dispatch(updateConversationSettingsModal(null));
        },
        okText: { token: 'delete' },
      })
    );
  };
  return showConfirmationModal;
}
