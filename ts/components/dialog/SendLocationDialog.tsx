import styled from 'styled-components';

import { getAppDispatch } from '../../state/dispatch';
import {
  updateSendLocationModal,
  type SendLocationModalState,
} from '../../state/ducks/modalDialog';
import { tr } from '../../localization/localeTools';
import { ConvoHub } from '../../session/conversations';
import { buildLocationMessage, coordinatesLabel } from '../../util/locationMessage';
import { SessionButton, SessionButtonColor, SessionButtonType } from '../basic/SessionButton';
import {
  ModalActionsContainer,
  ModalBasicHeader,
  SessionWrapperModal,
} from '../SessionWrapperModal';
import { ModalDescription } from './shared/ModalDescriptionContainer';
import { ModalFlexContainer } from './shared/ModalFlexContainer';
import { ToastUtils } from '../../session/utils';

const StyledCoordinates = styled.div`
  text-align: center;
  font-weight: bold;
  word-break: break-word;
`;

/**
 * Note: deliberately a plain function rather than inline in the component. The
 * react compiler cannot yet handle value blocks inside a try/catch, and it fails
 * the build over it.
 */
async function sendLocation(
  conversationId: string,
  latitude: number,
  longitude: number,
  accuracyMeters: number | null
) {
  try {
    const conversation = ConvoHub.use().get(conversationId);
    if (!conversation) {
      return false;
    }
    await conversation.sendMessage({
      conversationId,
      body: buildLocationMessage(latitude, longitude, accuracyMeters),
      attachments: undefined,
      preview: undefined,
      quote: undefined,
      communityInvitation: undefined,
    });

    return true;
  } catch (error) {
    window?.log?.warn('SendLocationDialog: failed to send the location', error);
    return false;
  }
}

export const SendLocationDialog = (props: NonNullable<SendLocationModalState>) => {
  const { conversationId, latitude, longitude, accuracyMeters } = props;
  const dispatch = getAppDispatch();

  const onClose = () => {
    dispatch(updateSendLocationModal(null));
  };

  const label = coordinatesLabel({ latitude, longitude, accuracyMeters });
  const coordinates = accuracyMeters !== null ? `${label} · ±${accuracyMeters} m` : label;

  const onSend = async () => {
    const sent = await sendLocation(conversationId, latitude, longitude, accuracyMeters);
    if (!sent) {
      ToastUtils.pushToastError('send-location', tr('locationSendFailedDev'));
    }
    onClose();
  };

  return (
    <SessionWrapperModal
      modalId="sendLocationModal"
      modalDataTestId="send-location-dialog"
      headerChildren={
        <ModalBasicHeader title={tr('locationConfirmTitleDev')} showExitIcon={true} />
      }
      onClose={onClose}
      buttonChildren={
        <ModalActionsContainer buttonType={SessionButtonType.Simple}>
          <SessionButton
            text={tr('send')}
            buttonType={SessionButtonType.Simple}
            buttonColor={SessionButtonColor.Primary}
            onClick={() => void onSend()}
            dataTestId="session-confirm-ok-button"
          />
          <SessionButton
            text={tr('cancel')}
            buttonType={SessionButtonType.Simple}
            onClick={onClose}
            dataTestId="session-confirm-cancel-button"
          />
        </ModalActionsContainer>
      }
    >
      <ModalFlexContainer>
        <ModalDescription
          dataTestId="modal-description"
          localizerProps={{ token: 'locationConfirmDescriptionDev' }}
        />
        {/* the coordinates themselves, which no localizer token can carry */}
        <StyledCoordinates data-testid="send-location-coordinates">{coordinates}</StyledCoordinates>
      </ModalFlexContainer>
    </SessionWrapperModal>
  );
};
