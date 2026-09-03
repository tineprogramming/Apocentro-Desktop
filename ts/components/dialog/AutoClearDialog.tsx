import { useState } from 'react';

import { getAppDispatch } from '../../state/dispatch';
import { updateAutoClearModal } from '../../state/ducks/modalDialog';
import { tr } from '../../localization/localeTools';
import {
  getConversationAutoClear,
  getGlobalAutoClear,
  setConversationAutoClear,
  setGlobalAutoClear,
  type AutoClearUnit,
} from '../../interactions/conversations/autoClear';
import type { ClearScope } from '../../interactions/conversations/messageCleaner';
import { SessionButton, SessionButtonType } from '../basic/SessionButton';
import { SessionRadioGroup } from '../basic/SessionRadioGroup';
import { ModalSimpleSessionInput } from '../inputs/SessionInput';
import {
  ModalActionsContainer,
  ModalBasicHeader,
  SessionWrapperModal,
} from '../SessionWrapperModal';
import { ModalDescription } from './shared/ModalDescriptionContainer';
import { ModalFlexContainer } from './shared/ModalFlexContainer';

/**
 * "Use global setting" only exists per conversation -- the global policy has
 * nothing to defer to.
 */
type AutoClearMode = 'useGlobal' | 'off' | ClearScope;

function isScope(mode: AutoClearMode): mode is ClearScope {
  return mode === 'device_only' || mode === 'others_only' || mode === 'both';
}

/**
 * Note: deliberately a plain function rather than inline in the component. The
 * react compiler cannot yet handle value blocks inside a try/catch, and it fails
 * the build over it.
 */
async function persist(
  conversationId: string | null,
  mode: AutoClearMode,
  amount: number,
  unit: AutoClearUnit
) {
  try {
    if (conversationId === null) {
      await setGlobalAutoClear(isScope(mode) ? { scope: mode, amount, unit } : null);
      return true;
    }
    if (mode === 'useGlobal') {
      await setConversationAutoClear(conversationId, { kind: 'useGlobal' });
      return true;
    }
    if (mode === 'off') {
      await setConversationAutoClear(conversationId, { kind: 'off' });
      return true;
    }
    await setConversationAutoClear(conversationId, {
      kind: 'on',
      config: { scope: mode, amount, unit },
    });
    return true;
  } catch (error) {
    window?.log?.warn('AutoClearDialog: failed to save the auto-clear policy', error);
    return false;
  }
}

function initialStateFor(conversationId: string | null): {
  mode: AutoClearMode;
  amount: string;
  unit: AutoClearUnit;
} {
  if (conversationId === null) {
    const global = getGlobalAutoClear();
    return {
      mode: global ? global.scope : 'off',
      amount: global ? String(global.amount) : '1',
      unit: global ? global.unit : 'days',
    };
  }

  const setting = getConversationAutoClear(conversationId);
  if (setting.kind === 'on') {
    return {
      mode: setting.config.scope,
      amount: String(setting.config.amount),
      unit: setting.config.unit,
    };
  }
  return { mode: setting.kind, amount: '1', unit: 'days' };
}

export const AutoClearDialog = ({ conversationId }: { conversationId: string | null }) => {
  const dispatch = getAppDispatch();
  const initial = initialStateFor(conversationId);

  const [mode, setMode] = useState<AutoClearMode>(initial.mode);
  const [amount, setAmount] = useState<string>(initial.amount);
  const [unit, setUnit] = useState<AutoClearUnit>(initial.unit);

  const onClose = () => {
    dispatch(updateAutoClearModal(null));
  };

  const amountNumber = Number(amount);
  const amountValid = Number.isInteger(amountNumber) && amountNumber > 0;
  const needsAmount = isScope(mode);

  const modeItems = [
    ...(conversationId !== null
      ? [{ value: 'useGlobal' as const, label: tr('autoClearUseGlobalDev') }]
      : []),
    { value: 'off' as const, label: tr('autoClearOffDev') },
    { value: 'device_only' as const, label: tr('clearOnThisDevice') },
    { value: 'others_only' as const, label: tr('clearOthersOnlyDev') },
    { value: 'both' as const, label: tr('clearMessagesForEveryone') },
  ].map(item => ({
    ...item,
    inputDataTestId: `input-auto-clear-${item.value}` as const,
    labelDataTestId: `label-auto-clear-${item.value}` as const,
  }));

  const unitItems = (['hours', 'days'] as const).map(value => ({
    value,
    label: value === 'hours' ? tr('autoClearHoursDev') : tr('autoClearDaysDev'),
    inputDataTestId: `input-auto-clear-${value}` as const,
    labelDataTestId: `label-auto-clear-${value}` as const,
  }));

  const onSave = async () => {
    if (needsAmount && !amountValid) {
      return;
    }
    await persist(conversationId, mode, amountNumber, unit);
    onClose();
  };

  return (
    <SessionWrapperModal
      modalId="autoClearModal"
      modalDataTestId="auto-clear-dialog"
      headerChildren={<ModalBasicHeader title={tr('autoClearDev')} showExitIcon={true} />}
      onClose={onClose}
      buttonChildren={
        <ModalActionsContainer buttonType={SessionButtonType.Simple}>
          <SessionButton
            text={tr('save')}
            buttonType={SessionButtonType.Simple}
            disabled={needsAmount && !amountValid}
            onClick={() => void onSave()}
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
          localizerProps={{ token: 'autoClearSettingsDescriptionDev' }}
        />
        <SessionRadioGroup
          group="auto_clear_mode"
          initialItem={mode}
          onClick={value => setMode(value as AutoClearMode)}
          items={modeItems}
        />
        {needsAmount ? (
          <>
            <ModalDescription
              dataTestId="modal-description"
              localizerProps={{ token: 'autoClearOlderThanDev' }}
            />
            <ModalSimpleSessionInput
              value={amount}
              onValueChanged={setAmount}
              onEnterPressed={() => void onSave()}
              placeholder={tr('autoClearAmountPlaceholderDev')}
              ariaLabel="auto clear amount"
              inputDataTestId="auto-clear-amount-input"
              errorDataTestId="error-message"
              providedError={amountValid ? undefined : tr('autoClearAmountInvalidDev')}
              maxLength={4}
            />
            <SessionRadioGroup
              group="auto_clear_unit"
              initialItem={unit}
              onClick={value => setUnit(value as AutoClearUnit)}
              items={unitItems}
            />
          </>
        ) : null}
      </ModalFlexContainer>
    </SessionWrapperModal>
  );
};
