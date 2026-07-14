import { useCallback, useEffect, useState } from 'react';
import useUpdate from 'react-use/lib/useUpdate';
import { getAppDispatch } from '../../../../state/dispatch';

import { tr } from '../../../../localization/localeTools';
import {
  updateConfirmModal,
  userSettingsModal,
  type UserSettingsModalState,
} from '../../../../state/ducks/modalDialog';
import {
  PanelButtonGroup,
  PanelButtonTextWithSubText,
  PanelLabelWithDescription,
} from '../../../buttons/panel/PanelButton';
import { PanelToggleButton } from '../../../buttons/panel/PanelToggleButton';
import { ModalBasicHeader } from '../../../SessionWrapperModal';
import { ModalBackButton } from '../../shared/ModalBackButton';
import {
  useUserSettingsBackAction,
  useUserSettingsCloseAction,
  useUserSettingsTitle,
} from './userSettingsHooks';
import { SessionButtonColor } from '../../../basic/SessionButton';
import {
  useHasGiphyIntegrationEnabled,
  useHasLinkPreviewEnabled,
  useWeHaveBlindedMsgRequestsEnabled,
} from '../../../../state/selectors/settings';
import { SettingsKey } from '../../../../data/settings-key';
import { getPasswordHash, Storage } from '../../../../util/storage';
import { SettingsToggleBasic } from '../components/SettingsToggleBasic';
import { SettingsPanelButtonInlineBasic } from '../components/SettingsPanelButtonInlineBasic';
import { saveLogToDesktop } from '../../../../util/logger/renderer_process_logging';
import { UserSettingsModalContainer } from '../components/UserSettingsModalContainer';
import { UserConfigWrapperActions } from '../../../../webworker/workers/browser/libsession/libsession_worker_userconfig_interface';
import { toggleGiphyIntegration } from '../actions/toggleGiphyIntegration';
import { getFeatureFlag } from '../../../../state/ducks/types/releasedFeaturesReduxTypes';
import { CallManager } from '../../../../session/utils';
import { APOCENTRO_CALL_DEBUG_KEY } from '../../../../session/utils/calling/ApocentroCallConfig';
import { pushToastSuccess, pushToastError } from '../../../../session/utils/Toast';

// Apocentro: gates 1:1 voice/video calling (incl. LAN/offline calls). Enabling it
// grants the media permission and turns on the call engine.
const toggleCallMediaPermissions = async (triggerUIUpdate: () => void) => {
  const currentValue = window.getCallMediaPermissions();
  const onClose = () => window.inboxStore?.dispatch(updateConfirmModal(null));
  if (!currentValue) {
    window.inboxStore?.dispatch(
      updateConfirmModal({
        title: { token: 'callsVoiceAndVideoBeta' },
        i18nMessage: { token: 'callsVoiceAndVideoModalDescription' },
        okTheme: SessionButtonColor.Danger,
        okText: { token: 'theContinue' },
        onClickOk: async () => {
          await window.toggleCallMediaPermissionsTo(true);
          triggerUIUpdate();
          CallManager.onTurnedOnCallMediaPermissions();
          onClose();
        },
        onClickCancel: async () => {
          await window.toggleCallMediaPermissionsTo(false);
          triggerUIUpdate();
          onClose();
        },
        onClickClose: onClose ? void onClose() : undefined,
      })
    );
  } else {
    await window.toggleCallMediaPermissionsTo(false);
    triggerUIUpdate();
  }
};

async function toggleLinkPreviews(isToggleOn: boolean, forceUpdate: () => void) {
  if (!isToggleOn) {
    window.inboxStore?.dispatch(
      updateConfirmModal({
        title: { token: 'linkPreviewsSend' },
        i18nMessage: { token: 'linkPreviewsSendModalDescription' },
        okTheme: SessionButtonColor.Danger,
        okText: { token: 'theContinue' },
        onClickOk: async () => {
          const newValue = !isToggleOn;
          await window.setSettingValue(SettingsKey.settingsLinkPreview, newValue);
          forceUpdate();
        },
        onClickClose: () => {
          window.inboxStore?.dispatch(updateConfirmModal(null));
        },
      })
    );
  } else {
    await window.setSettingValue(SettingsKey.settingsLinkPreview, false);
    await Storage.put(SettingsKey.hasLinkPreviewPopupBeenDisplayed, false);
    forceUpdate();
  }
}

function HasPasswordSubSection() {
  const dispatch = getAppDispatch();
  return (
    <PanelButtonGroup>
      <SettingsPanelButtonInlineBasic
        baseDataTestId="change-password"
        text={{ token: 'passwordChange' }}
        subText={{ token: 'passwordChangeShortDescription' }}
        onClick={async () => {
          dispatch(userSettingsModal({ userSettingsPage: 'password', passwordAction: 'change' }));
        }}
        buttonColor={SessionButtonColor.PrimaryDark}
        buttonText={tr('change')}
      />
      <SettingsPanelButtonInlineBasic
        baseDataTestId="remove-password"
        text={{ token: 'passwordRemove' }}
        subText={{ token: 'passwordRemoveShortDescription' }}
        onClick={async () => {
          dispatch(userSettingsModal({ userSettingsPage: 'password', passwordAction: 'remove' }));
        }}
        buttonColor={SessionButtonColor.Danger}
        buttonText={tr('remove')}
      />
    </PanelButtonGroup>
  );
}
function NoPasswordSubSection() {
  const dispatch = getAppDispatch();

  return (
    <PanelButtonGroup>
      <SettingsPanelButtonInlineBasic
        baseDataTestId="set-password"
        text={{ token: 'passwordSet' }}
        subText={{ token: 'passwordSetShortDescription' }}
        onClick={async () => {
          dispatch(userSettingsModal({ userSettingsPage: 'password', passwordAction: 'set' }));
        }}
        buttonColor={SessionButtonColor.PrimaryDark}
        buttonText={tr('set')}
      />
    </PanelButtonGroup>
  );
}

function PasswordSubSection() {
  if (getPasswordHash()) {
    return <HasPasswordSubSection />;
  }
  return <NoPasswordSubSection />;
}

export function PrivacySettingsPage(modalState: UserSettingsModalState) {
  const backAction = useUserSettingsBackAction(modalState);
  const closeAction = useUserSettingsCloseAction(modalState);
  const title = useUserSettingsTitle(modalState);
  const weHaveBlindedRequestsEnabled = useWeHaveBlindedMsgRequestsEnabled();
  const isLinkPreviewsOn = useHasLinkPreviewEnabled();
  const isGiphyIntegrationOn = useHasGiphyIntegrationEnabled();

  const forceUpdate = useUpdate();

  // Windows firewall exception state, so we can show "Allowed" (disabled) once
  // the rule exists instead of prompting for elevation again.
  const [firewall, setFirewall] = useState<{ supported: boolean; exists: boolean } | null>(null);
  const refreshFirewall = useCallback(async () => {
    if (window.apocentroFirewallStatus) {
      setFirewall(await window.apocentroFirewallStatus());
    }
  }, []);
  useEffect(() => {
    void refreshFirewall();
  }, [refreshFirewall]);

  return (
    <UserSettingsModalContainer
      headerChildren={
        <ModalBasicHeader
          title={title}
          bigHeader={true}
          showExitIcon={true}
          extraLeftButton={backAction ? <ModalBackButton onClick={backAction} /> : undefined}
        />
      }
      onClose={closeAction || undefined}
    >
      <PanelLabelWithDescription title={{ token: 'callsSettings' }} />
      <PanelButtonGroup>
        <SettingsToggleBasic
          baseDataTestId="enable-calls"
          active={Boolean(window.getCallMediaPermissions())}
          onClick={async () => {
            await toggleCallMediaPermissions(forceUpdate);
            forceUpdate();
          }}
          text={{ token: 'callsVoiceAndVideoBeta' }}
          subText={{ token: 'callsVoiceAndVideoToggleDescription' }}
        />
        <SettingsToggleBasic
          baseDataTestId="enable-call-debug-info"
          active={window.getSettingValue(APOCENTRO_CALL_DEBUG_KEY) !== false}
          onClick={async () => {
            const old = window.getSettingValue(APOCENTRO_CALL_DEBUG_KEY) !== false;
            await window.setSettingValue(APOCENTRO_CALL_DEBUG_KEY, !old);
            forceUpdate();
          }}
          text={{ token: 'callsDebugInfoDev' }}
          subText={{ token: 'callsDebugInfoDescriptionDev' }}
        />
        {window.platform === 'win32' && window.apocentroAddFirewallRule && firewall?.supported ? (
          <SettingsPanelButtonInlineBasic
            baseDataTestId="add-firewall-rule"
            text={{ token: 'callsFirewallDev' }}
            subText={{
              token: firewall.exists
                ? 'callsFirewallEnabledDescriptionDev'
                : 'callsFirewallDescriptionDev',
            }}
            buttonColor={SessionButtonColor.PrimaryDark}
            buttonText={
              firewall.exists ? tr('callsFirewallAddedButtonDev') : tr('callsFirewallButtonDev')
            }
            disabled={firewall.exists}
            onClick={async () => {
              const res = await window.apocentroAddFirewallRule?.();
              if (res?.ok) {
                pushToastSuccess('apocentro-firewall', tr('callsFirewallDoneDev'));
                await refreshFirewall();
              } else {
                pushToastError('apocentro-firewall', tr('callsFirewallFailedDev'));
              }
            }}
          />
        ) : null}
      </PanelButtonGroup>
      <PanelLabelWithDescription title={{ token: 'permissionsMicrophone' }} />
      <PanelButtonGroup>
        <SettingsToggleBasic
          baseDataTestId="enable-microphone"
          active={Boolean(window.getSettingValue('media-permissions'))}
          onClick={async () => {
            await window.toggleMediaPermissions();
            forceUpdate();
          }}
          text={{ token: 'permissionsMicrophone' }}
          subText={{ token: 'permissionsMicrophoneDescriptionIos' }}
        />
      </PanelButtonGroup>
      <PanelLabelWithDescription title={{ token: 'sessionMessageRequests' }} />
      <PanelButtonGroup>
        <SettingsToggleBasic
          baseDataTestId="enable-communities-message-requests"
          active={weHaveBlindedRequestsEnabled}
          onClick={async () => {
            const toggledValue = !weHaveBlindedRequestsEnabled;
            await window.setSettingValue(SettingsKey.hasBlindedMsgRequestsEnabled, toggledValue);
            await UserConfigWrapperActions.setEnableBlindedMsgRequest(toggledValue);

            forceUpdate();
          }}
          text={{ token: 'messageRequestsCommunities' }}
          subText={{ token: 'messageRequestsCommunitiesDescription' }}
        />
      </PanelButtonGroup>
      <PanelLabelWithDescription title={{ token: 'readReceipts' }} />
      <PanelButtonGroup>
        <SettingsToggleBasic
          baseDataTestId="enable-read-receipts"
          active={window.getSettingValue(SettingsKey.settingsReadReceipt)}
          onClick={async () => {
            const old = Boolean(window.getSettingValue(SettingsKey.settingsReadReceipt));
            await window.setSettingValue(SettingsKey.settingsReadReceipt, !old);
            forceUpdate();
          }}
          text={{ token: 'readReceipts' }}
          subText={{ token: 'readReceiptsDescription' }}
        />
      </PanelButtonGroup>
      <PanelLabelWithDescription title={{ token: 'typingIndicators' }} />
      <PanelButtonGroup>
        <PanelToggleButton
          textElement={
            <PanelButtonTextWithSubText
              text={{ token: 'typingIndicators' }}
              subText={{ token: 'typingIndicatorsDescription' }}
              textDataTestId={'enable-typing-indicators-settings-text'}
              subTextDataTestId={'enable-typing-indicators-settings-sub-text'}
            />
          }
          active={Boolean(window.getSettingValue(SettingsKey.settingsTypingIndicator))}
          onClick={async () => {
            const old = Boolean(window.getSettingValue(SettingsKey.settingsTypingIndicator));
            await window.setSettingValue(SettingsKey.settingsTypingIndicator, !old);
            forceUpdate();
          }}
          toggleDataTestId={'enable-typing-indicators-settings-toggle'}
          rowDataTestId={'enable-typing-indicators-settings-row'}
        />
      </PanelButtonGroup>
      <PanelLabelWithDescription title={{ token: 'linkPreviews' }} />
      <PanelButtonGroup>
        <SettingsToggleBasic
          baseDataTestId="enable-link-previews"
          active={isLinkPreviewsOn}
          onClick={async () => {
            void toggleLinkPreviews(isLinkPreviewsOn, forceUpdate);
          }}
          text={{ token: 'linkPreviewsSend' }}
          subText={{ token: 'linkPreviewsDescription' }}
        />
      </PanelButtonGroup>
      {getFeatureFlag('canToggleGiphy') ? (
        <>
          <PanelLabelWithDescription title={{ token: 'giphyWarning' }} />
          <PanelButtonGroup>
            <SettingsToggleBasic
              baseDataTestId="enable-giphy-integration"
              active={isGiphyIntegrationOn}
              onClick={async () => {
                void toggleGiphyIntegration(isGiphyIntegrationOn, forceUpdate);
              }}
              text={{ token: 'giphyWarning' }}
              subText={{ token: 'giphyIntegrationDescription' }}
            />
          </PanelButtonGroup>
        </>
      ) : null}

      <PanelLabelWithDescription title={{ token: 'passwords' }} />
      <PasswordSubSection />

      {/* Apocentro: expose Export Logs here too (mirrors iOS Privacy), so it's easy to find when
          diagnosing calls/notifications — not only under Help. */}
      <PanelLabelWithDescription title={{ token: 'logs' }} />
      <PanelButtonGroup>
        <SettingsPanelButtonInlineBasic
          baseDataTestId="export-logs"
          text={{ token: 'helpReportABug' }}
          subText={{ token: 'helpReportABugExportLogsSaveToDesktopDescription' }}
          onClick={async () => saveLogToDesktop()}
          buttonColor={SessionButtonColor.PrimaryDark}
          buttonText={tr('helpReportABugExportLogs')}
        />
      </PanelButtonGroup>
    </UserSettingsModalContainer>
  );
}
