import { useState } from 'react';
import type { GroupPubkeyType, PubkeyType } from 'libsession_util_nodejs';
import styled from 'styled-components';

import { getAppDispatch } from '../../state/dispatch';
import { updateManageGroupAdminsModal } from '../../state/ducks/modalDialog';
import { groupInfoActions } from '../../state/ducks/metaGroups';
import {
  useLibGroupSuperAdmin,
  useStateOf03GroupMembers,
  useMemberGroupChangePending,
} from '../../state/selectors/groups';
import {
  useConversationUsernameWithFallback,
  useWeAreAdmin,
} from '../../hooks/useParamSelector';
import { PubKey } from '../../session/types';
import { UserUtils } from '../../session/utils';
import { tr } from '../../localization/localeTools';
import { MemberListItem } from '../MemberListItem';
import { SessionButton, SessionButtonColor, SessionButtonType } from '../basic/SessionButton';
import { SpacerLG, SpacerSM } from '../basic/Text';
import { SessionSpinner } from '../loading';
import { StyledContactListInModal } from '../list/StyledContactList';
import {
  ModalActionsContainer,
  ModalBasicHeader,
  SessionWrapperModal,
  WrapperModalWidth,
} from '../SessionWrapperModal';
import { kickAdminAndRecreateGroup } from '../../interactions/conversations/kickAdmin';

type Props = {
  conversationId: string;
};

/** claim/transfer are the same write; kick and promote are their own flows */
type PendingAction = 'promote' | 'claim' | 'transfer' | 'kick';

const StyledSectionLabel = styled.div`
  padding: var(--margins-xs) var(--margins-sm);
  color: var(--text-secondary-color);
  font-size: var(--font-size-sm);
  text-transform: uppercase;
`;

const StyledSuperAdminLabel = styled.div`
  padding: 0 var(--margins-sm);
  color: var(--text-secondary-color);
  font-size: var(--font-size-sm);
  text-align: center;
`;

const StyledConfirmText = styled.div`
  padding: 0 var(--margins-lg);
  color: var(--text-primary-color);
  font-size: var(--font-size-sm);
  text-align: center;
  line-height: 18px;
`;

/**
 * NOTE: [react-compiler] kept out of the component: the compiler cannot yet handle
 * value blocks (optional chaining and friends) inside a try/catch.
 */
async function runAdminAction(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (e) {
    window?.log?.warn('ManageGroupAdminsDialog: action failed with', e.message);
    return false;
  }
}

function confirmTokenFor(pending: PendingAction) {
  switch (pending) {
    case 'promote':
      return 'promoteToAdminConfirmDev' as const;
    case 'claim':
      return 'claimSuperAdminConfirmDev' as const;
    case 'transfer':
      return 'transferSuperAdminConfirmDev' as const;
    case 'kick':
    default:
      return 'kickAdminConfirmDev' as const;
  }
}

function confirmButtonTokenFor(pending: PendingAction) {
  switch (pending) {
    case 'promote':
      return 'promoteToAdminDev' as const;
    case 'claim':
      return 'claimSuperAdminDev' as const;
    case 'transfer':
      return 'transferSuperAdminDev' as const;
    case 'kick':
    default:
      return 'kickAdminDev' as const;
  }
}

/**
 * Apocentro "Manage admins": the desktop half of the group super admin feature.
 *
 * A group has at most one super admin -- the only admin allowed to remove members.
 * The role lives in an invisible tag on the group description (see util/superAdmin.ts),
 * so it syncs to every client through the normal group config.
 */
export const ManageGroupAdminsDialog = (props: Props) => {
  const { conversationId } = props;
  const dispatch = getAppDispatch();

  const us = UserUtils.getOurPubKeyStrFromCache();
  const members = useStateOf03GroupMembers(conversationId);
  const superAdminId = useLibGroupSuperAdmin(conversationId);
  const weAreAdmin = useWeAreAdmin(conversationId);
  const isProcessingUIChange = useMemberGroupChangePending();

  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const superAdminName = useConversationUsernameWithFallback(true, superAdminId || us);

  const admins = members.filter(m => m.nominatedAdmin);
  const plainMembers = members.filter(m => !m.nominatedAdmin);

  const weAreSuperAdmin = !!superAdminId && superAdminId === us;
  const selectedIsAdmin = !!selected && admins.some(m => m.pubkeyHex === selected);
  const selectedIsUs = selected === us;

  const canClaim = weAreAdmin && !superAdminId;
  const canPromote = weAreAdmin && !!selected && !selectedIsAdmin;
  const canTransfer = weAreSuperAdmin && selectedIsAdmin && !selectedIsUs;
  const canKick = weAreSuperAdmin && selectedIsAdmin && !selectedIsUs;

  const closeDialog = () => {
    dispatch(updateManageGroupAdminsModal(null));
  };

  const onConfirm = async () => {
    if (!pending || !PubKey.is03Pubkey(conversationId)) {
      return;
    }
    const groupPk: GroupPubkeyType = conversationId;
    setBusy(true);
    setFailed(false);

    const ok = await runAdminAction(async () => {
      if (pending === 'promote') {
        await (
          dispatch(
            groupInfoActions.currentDeviceGroupPromoteMembers({
              groupPk,
              members: [selected as PubkeyType],
            }) as any
          ) as any
        ).unwrap();
        return;
      }
      if (pending === 'claim' || pending === 'transfer') {
        await (
          dispatch(
            groupInfoActions.currentDeviceGroupSuperAdminChange({
              groupPk,
              superAdminId: (pending === 'claim' ? us : selected) as PubkeyType,
            }) as any
          ) as any
        ).unwrap();
        return;
      }
      await kickAdminAndRecreateGroup(groupPk, selected as PubkeyType);
    });

    setBusy(false);
    if (!ok) {
      setFailed(true);
      setPending(null);
      return;
    }
    closeDialog();
  };

  if (pending) {
    return (
      <SessionWrapperModal
        modalId="manageGroupAdminsModal"
        modalDataTestId="manage-group-admins-dialog"
        headerChildren={
          <ModalBasicHeader title={tr(confirmButtonTokenFor(pending))} showExitIcon={true} />
        }
        onClose={closeDialog}
        $contentMinWidth={WrapperModalWidth.narrow}
        buttonChildren={
          <ModalActionsContainer buttonType={SessionButtonType.Simple}>
            <SessionButton
              text={tr(confirmButtonTokenFor(pending))}
              buttonType={SessionButtonType.Simple}
              buttonColor={SessionButtonColor.Danger}
              disabled={busy}
              onClick={() => void onConfirm()}
              dataTestId="session-confirm-ok-button"
            />
            <SessionButton
              text={tr('cancel')}
              buttonType={SessionButtonType.Simple}
              disabled={busy}
              onClick={() => setPending(null)}
              dataTestId="session-confirm-cancel-button"
            />
          </ModalActionsContainer>
        }
      >
        <SpacerSM />
        <StyledConfirmText>{tr(confirmTokenFor(pending))}</StyledConfirmText>
        <SpacerSM />
        <SessionSpinner $loading={busy} />
        <SpacerSM />
      </SessionWrapperModal>
    );
  }

  return (
    <SessionWrapperModal
      modalId="manageGroupAdminsModal"
      modalDataTestId="manage-group-admins-dialog"
      headerChildren={<ModalBasicHeader title={tr('manageAdminsDev')} showExitIcon={true} />}
      onClose={closeDialog}
      $contentMinWidth={WrapperModalWidth.wide}
      $contentMaxWidth={WrapperModalWidth.wide}
      buttonChildren={
        <ModalActionsContainer buttonType={SessionButtonType.Simple}>
          {canClaim ? (
            <SessionButton
              text={tr('claimSuperAdminDev')}
              buttonType={SessionButtonType.Simple}
              disabled={isProcessingUIChange}
              onClick={() => setPending('claim')}
              dataTestId="claim-super-admin-button"
            />
          ) : null}
          {canPromote ? (
            <SessionButton
              text={tr('promoteToAdminDev')}
              buttonType={SessionButtonType.Simple}
              disabled={isProcessingUIChange}
              onClick={() => setPending('promote')}
              dataTestId="promote-to-admin-button"
            />
          ) : null}
          {canTransfer ? (
            <SessionButton
              text={tr('transferSuperAdminDev')}
              buttonType={SessionButtonType.Simple}
              disabled={isProcessingUIChange}
              onClick={() => setPending('transfer')}
              dataTestId="transfer-super-admin-button"
            />
          ) : null}
          {canKick ? (
            <SessionButton
              text={tr('kickAdminDev')}
              buttonType={SessionButtonType.Simple}
              buttonColor={SessionButtonColor.Danger}
              disabled={isProcessingUIChange}
              onClick={() => setPending('kick')}
              dataTestId="kick-admin-button"
            />
          ) : null}
          <SessionButton
            text={tr('cancel')}
            buttonType={SessionButtonType.Simple}
            onClick={closeDialog}
            dataTestId="session-confirm-cancel-button"
          />
        </ModalActionsContainer>
      }
    >
      <StyledSuperAdminLabel data-testid="super-admin-label">
        {!superAdminId
          ? tr('superAdminNoneDev')
          : weAreSuperAdmin
            ? tr('superAdminYouDev')
            : `${tr('superAdminIsDev')} ${superAdminName}`}
      </StyledSuperAdminLabel>
      <SpacerSM />
      <StyledConfirmText>{tr('manageAdminsDescriptionDev')}</StyledConfirmText>
      {failed ? (
        <>
          <SpacerSM />
          <StyledConfirmText>{tr('superAdminActionFailedDev')}</StyledConfirmText>
        </>
      ) : null}
      <SpacerSM />
      <StyledContactListInModal>
        <StyledSectionLabel>{tr('groupAdminsSectionDev')}</StyledSectionLabel>
        {admins.map(member => (
          <MemberListItem
            key={`admin-${member.pubkeyHex}`}
            pubkey={member.pubkeyHex}
            isSelected={selected === member.pubkeyHex}
            onSelect={() => setSelected(member.pubkeyHex)}
            onUnselect={() => setSelected(null)}
            isAdmin={true}
            hideRadioButton={!weAreSuperAdmin || member.pubkeyHex === us}
            disableBg={true}
            displayGroupStatus={true}
            groupPk={conversationId}
            conversationId={conversationId}
          />
        ))}
        {plainMembers.length ? (
          <StyledSectionLabel>{tr('groupMembersSectionDev')}</StyledSectionLabel>
        ) : null}
        {plainMembers.map(member => (
          <MemberListItem
            key={`member-${member.pubkeyHex}`}
            pubkey={member.pubkeyHex}
            isSelected={selected === member.pubkeyHex}
            onSelect={() => setSelected(member.pubkeyHex)}
            onUnselect={() => setSelected(null)}
            hideRadioButton={!weAreAdmin}
            disableBg={true}
            displayGroupStatus={true}
            groupPk={conversationId}
            conversationId={conversationId}
          />
        ))}
      </StyledContactListInModal>
      <SpacerLG />
      <SessionSpinner $loading={isProcessingUIChange || busy} />
      <SpacerLG />
    </SessionWrapperModal>
  );
};
