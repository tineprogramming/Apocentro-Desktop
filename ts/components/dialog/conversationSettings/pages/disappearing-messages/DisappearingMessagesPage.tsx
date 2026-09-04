import { useEffect, useState, Dispatch } from 'react';
import { useSelector } from 'react-redux';
import styled from 'styled-components';
import { getAppDispatch } from '../../../../../state/dispatch';
import { setDisappearingMessagesByConvoId } from '../../../../../interactions/conversationInteractions';
import { TimerOptions } from '../../../../../session/disappearing_messages/timerOptions';
import {
  customDurationSeconds,
  splitIntoCustomTime,
  type CustomTimeUnit,
} from '../../../../../session/disappearing_messages/customTimer';
import { DisappearingMessageConversationModeType } from '../../../../../session/disappearing_messages/types';

import {
  getSelectedConversationExpirationModes,
  useSelectedConversationDisappearingMode,
  useSelectedConversationKey,
  useSelectedExpireTimer,
  useSelectedIsGroupOrCommunity,
} from '../../../../../state/selectors/selectedConversation';
import { Flex } from '../../../../basic/Flex';
import { SpacerLG, SpacerMD } from '../../../../basic/Text';
import { StyledScrollContainer } from '../../../../conversation/right-panel/overlay/components';
import { DisappearingModes } from './DisappearingModes';
import { TimeOptions } from './TimeOptions';
import { useConversationSettingsModalIsStandalone } from '../../../../../state/selectors/modal';
import {
  updateConversationSettingsModal,
  type ConversationSettingsModalState,
} from '../../../../../state/ducks/modalDialog';
import { useShowConversationSettingsFor } from '../../../../menuAndSettingsHooks/useShowConversationSettingsFor';
import { tr } from '../../../../../localization/localeTools';
import { SessionSpinner } from '../../../../loading';
import {
  SessionButton,
  SessionButtonColor,
  SessionButtonType,
} from '../../../../basic/SessionButton';
import {
  useBackActionForPage,
  useCloseActionFromPage,
  useTitleFromPage,
} from '../conversationSettingsHooks';
import {
  ModalBasicHeader,
  ModalActionsContainer,
  SessionWrapperModal,
  WrapperModalWidth,
} from '../../../../SessionWrapperModal';
import { ModalBackButton } from '../../../shared/ModalBackButton';

const StyledNonAdminDescription = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  margin: 0 var(--margins-lg);
  color: var(--text-secondary-color);
  font-size: var(--font-size-sm);
  text-align: center;
  line-height: 15px;
`;

function loadDefaultTimeValue(
  modeSelected: DisappearingMessageConversationModeType,
  hasOnlyOneMode: boolean
) {
  // NOTE if there is only 1 disappearing message mode available the default state is that it is turned off
  if (hasOnlyOneMode) {
    return 0;
  }

  return modeSelected !== 'off'
    ? modeSelected === 'deleteAfterSend'
      ? TimerOptions.DEFAULT_OPTIONS.DELETE_AFTER_SEND
      : TimerOptions.DEFAULT_OPTIONS.DELETE_AFTER_READ
    : 0;
}

/**
 * Apocentro: a timer that is not one of the values Session knows about was set from a
 * custom entry (here, or on another platform), so reopen the page with the custom row
 * filled in rather than with nothing selected.
 */
function initialCustomTimeState(expireTimer?: number): {
  selected: boolean;
  amount: string;
  unit: CustomTimeUnit;
} {
  const knownValues: ReadonlyArray<number> = TimerOptions.VALUES;
  const isCustom = !!expireTimer && expireTimer > 0 && !knownValues.includes(expireTimer);

  if (!isCustom) {
    return { selected: false, amount: '1', unit: 'hours' };
  }
  const { amount, unit } = splitIntoCustomTime(expireTimer);
  return { selected: true, amount: String(amount), unit };
}

/** if there is only one disappearing message mode and 'off' enabled then we trigger single mode UI */
function useSingleMode(disappearingModeOptions: Record<string, boolean> | undefined) {
  const singleMode: DisappearingMessageConversationModeType | undefined =
    disappearingModeOptions &&
    disappearingModeOptions.off !== undefined &&
    Object.keys(disappearingModeOptions).length === 2
      ? (Object.keys(disappearingModeOptions)[1] as DisappearingMessageConversationModeType)
      : undefined;

  return { singleMode };
}

// NOTE: [react-compiler] this has to live here for the hook to be identified as static
function useDisappearingMessagesForConversationModalInternal(
  props: ConversationSettingsModalState
) {
  const onClose = useCloseActionFromPage(props);
  const title = useTitleFromPage(props?.settingsModalPage);
  const selectedConversationKey = useSelectedConversationKey();
  const disappearingModeOptions = useSelector(getSelectedConversationExpirationModes);
  const isGroup = useSelectedIsGroupOrCommunity();
  const expirationMode = useSelectedConversationDisappearingMode() || 'off';
  const expireTimer = useSelectedExpireTimer();
  const backAction = useBackActionForPage(props);
  const isStandalone = useConversationSettingsModalIsStandalone();

  const showConvoSettingsCb = useShowConversationSettingsFor(selectedConversationKey);

  return {
    onClose,
    title,
    selectedConversationKey,
    disappearingModeOptions,
    isGroup,
    expirationMode,
    expireTimer,
    backAction,
    isStandalone,
    showConvoSettingsCb,
  };
}

// NOTE: [react-compiler] this has to live here for the hook to be identified as static
function useDisappearingMessagesForConversationStateInternal(
  initialExpirationModeSelected: DisappearingMessageConversationModeType,
  expireTimer?: number
) {
  const [modeSelected, setModeSelected] = useState<DisappearingMessageConversationModeType>(
    initialExpirationModeSelected
  );
  const [timeSelected, setTimeSelected] = useState(expireTimer || 0);
  const [loading, setLoading] = useState(false);

  const initialCustom = initialCustomTimeState(expireTimer);
  const [customSelected, setCustomSelected] = useState(initialCustom.selected);
  const [customAmount, setCustomAmount] = useState(initialCustom.amount);
  const [customUnit, setCustomUnit] = useState<CustomTimeUnit>(initialCustom.unit);

  return {
    modeSelected,
    setModeSelected,
    timeSelected,
    setTimeSelected,
    loading,
    setLoading,
    customSelected,
    setCustomSelected,
    customAmount,
    setCustomAmount,
    customUnit,
    setCustomUnit,
  };
}

// NOTE: [react-compiler] this has to live here for the hook to be identified as static
function useHandleExpirationTimeChange(
  setTimeSelected: Dispatch<number>,
  modeSelected: DisappearingMessageConversationModeType,
  hasOnlyOneMode: boolean,
  customSelected: boolean,
  expireTimer?: number
) {
  useEffect(() => {
    // Apocentro: a custom time is driven by its own inputs, don't stomp on it
    if (customSelected) {
      return;
    }
    // NOTE loads a time value from the conversation model or the default
    setTimeSelected(
      expireTimer !== undefined && expireTimer > -1
        ? expireTimer
        : loadDefaultTimeValue(modeSelected, hasOnlyOneMode)
    );
    // NOTE customSelected is read but deliberately not a dependency: re-running this when
    // the user leaves the custom row would immediately overwrite the preset they just picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expireTimer, hasOnlyOneMode, modeSelected, setTimeSelected]);
}

/**
 * NOTE: [react-compiler] Helper function to handle the async operation with try/catch.
 * This is extracted outside the component to work around the React Compiler limitation:
 * "Support value blocks (conditional, logical, optional chaining, etc) within a try/catch statement"
 */
async function setDisappearingMessagesWithErrorHandling(
  convoKey: string,
  mode: DisappearingMessageConversationModeType,
  time: number
): Promise<{ success: true } | { success: false; error: unknown }> {
  try {
    await setDisappearingMessagesByConvoId(convoKey, mode, time);
    return { success: true };
  } catch (error) {
    return { success: false, error };
  }
}

export const DisappearingMessagesForConversationModal = (props: ConversationSettingsModalState) => {
  const dispatch = getAppDispatch();

  const {
    onClose,
    title,
    selectedConversationKey,
    disappearingModeOptions,
    isGroup,
    expirationMode,
    expireTimer,
    backAction,
    isStandalone,
    showConvoSettingsCb,
  } = useDisappearingMessagesForConversationModalInternal(props);

  const { singleMode } = useSingleMode(disappearingModeOptions);
  const hasOnlyOneMode = !!(singleMode && singleMode.length > 0);

  const {
    modeSelected,
    setModeSelected,
    timeSelected,
    setTimeSelected,
    loading,
    setLoading,
    customSelected,
    setCustomSelected,
    customAmount,
    setCustomAmount,
    customUnit,
    setCustomUnit,
  } = useDisappearingMessagesForConversationStateInternal(
    hasOnlyOneMode ? singleMode : expirationMode,
    expireTimer
  );

  const customInvalid = customSelected && customDurationSeconds(customAmount, customUnit) === null;

  // the custom inputs are the source of truth for the timer while the custom row is picked
  function applyCustom(amount: string, unit: CustomTimeUnit) {
    const seconds = customDurationSeconds(amount, unit);
    if (seconds !== null) {
      setTimeSelected(seconds);
    }
  }

  function onCustomSelected() {
    setCustomSelected(true);
    applyCustom(customAmount, customUnit);
  }

  function onCustomAmountChanged(value: string) {
    const digitsOnly = value.replace(/[^0-9]/g, '').slice(0, 6);
    setCustomAmount(digitsOnly);
    applyCustom(digitsOnly, customUnit);
  }

  function onCustomUnitChanged(unit: CustomTimeUnit) {
    setCustomUnit(unit);
    applyCustom(customAmount, unit);
  }

  function onPresetSelected(value: number) {
    setCustomSelected(false);
    setTimeSelected(value);
  }

  function closeOrBackInPage() {
    if (isStandalone) {
      dispatch(updateConversationSettingsModal(null));
    } else {
      showConvoSettingsCb?.({
        settingsModalPage: 'default',
      });
    }
  }

  const handleSetMode = async () => {
    if (!selectedConversationKey) {
      return;
    }

    if (hasOnlyOneMode) {
      if (singleMode) {
        const modeToSet = timeSelected === 0 ? 'off' : singleMode;
        setLoading(true);
        const result = await setDisappearingMessagesWithErrorHandling(
          selectedConversationKey,
          modeToSet,
          timeSelected
        );
        setLoading(false);
        if (result.success) {
          closeOrBackInPage();
        } else {
          throw result.error;
        }
      }
      return;
    }

    setLoading(true);
    const result = await setDisappearingMessagesWithErrorHandling(
      selectedConversationKey,
      modeSelected,
      timeSelected
    );
    setLoading(false);
    if (result.success) {
      closeOrBackInPage();
    } else {
      throw result.error;
    }
  };

  useHandleExpirationTimeChange(
    setTimeSelected,
    modeSelected,
    hasOnlyOneMode,
    customSelected,
    expireTimer
  );

  if (!disappearingModeOptions) {
    return null;
  }

  if (!selectedConversationKey) {
    return null;
  }

  return (
    <SessionWrapperModal
      modalId="conversationSettingsModal"
      headerChildren={
        <ModalBasicHeader
          title={title}
          bigHeader={true}
          extraLeftButton={backAction ? <ModalBackButton onClick={backAction} /> : undefined}
        />
      }
      onClose={onClose}
      shouldOverflow={true}
      allowOutsideClick={false}
      topAnchor="5vh"
      $contentMinWidth={WrapperModalWidth.narrow}
      buttonChildren={
        <ModalActionsContainer buttonType={SessionButtonType.Outline}>
          {loading ? (
            <SessionSpinner $loading={true} />
          ) : (
            <SessionButton
              buttonColor={SessionButtonColor.PrimaryDark}
              onClick={handleSetMode}
              buttonType={SessionButtonType.Outline}
              disabled={
                customInvalid ||
                (singleMode
                  ? disappearingModeOptions[singleMode]
                  : modeSelected
                    ? disappearingModeOptions[modeSelected]
                    : undefined)
              }
              dataTestId={'disappear-set-button'}
            >
              {tr('set')}
            </SessionButton>
          )}
        </ModalActionsContainer>
      }
    >
      <StyledScrollContainer style={{ position: 'relative' }}>
        <Flex $container={true} $flexDirection={'column'} $alignItems={'center'}>
          <DisappearingModes
            options={disappearingModeOptions}
            selected={modeSelected}
            setSelected={setModeSelected}
            hasOnlyOneMode={hasOnlyOneMode}
            singleMode={singleMode}
          />
          {(hasOnlyOneMode || modeSelected !== 'off') && (
            <>
              <TimeOptions
                modeSelected={modeSelected}
                selected={timeSelected}
                setSelected={onPresetSelected}
                hasOnlyOneMode={hasOnlyOneMode}
                customSelected={customSelected}
                customAmount={customAmount}
                customUnit={customUnit}
                onCustomSelected={onCustomSelected}
                onCustomAmountChanged={onCustomAmountChanged}
                onCustomUnitChanged={onCustomUnitChanged}
                disabled={
                  singleMode
                    ? disappearingModeOptions[singleMode]
                    : modeSelected
                      ? disappearingModeOptions[modeSelected]
                      : undefined
                }
              />
            </>
          )}

          {isGroup && (
            <>
              <SpacerLG />
              {/* We want those to be shown no matter our admin rights in a group. */}
              <StyledNonAdminDescription>
                {tr('disappearingMessagesDescription')}
                <br />
                {tr('disappearingMessagesOnlyAdmins')}
              </StyledNonAdminDescription>
            </>
          )}
        </Flex>
      </StyledScrollContainer>
      <SpacerMD />
    </SessionWrapperModal>
  );
};
