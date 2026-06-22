// Apocentro — Group "sub-admin" (promote member to admin)
//
// In Apocentro, a group admin can promote any member who has ACCEPTED the
// group invite to admin. Once promoted that member holds the group admin key
// and can invite their own contacts — this is how delegated invites work.
//
// Constraints (intrinsic to libsession groups-v2, not bugs — keep them):
//   - Two roles only: admin and member. There is no reduced-power tier;
//     holding the admin key *is* being an admin.
//   - Admins cannot be demoted. A shared admin key cannot be revoked, and
//     libsession groups-v2 has no demote operation. The confirmation below
//     states this so the admin understands the action is irreversible.
//   - Only members with status INVITE_ACCEPTED can be promoted (you cannot
//     hand the admin key to someone who has not joined). The promote button
//     is gated on accepted-invite state at its call site.
//
// Upstream Session keeps this flow behind the `useClosedGroupV2QAButtons` QA
// flag. Apocentro ships it as a real feature, so we gate on this constant
// instead. The underlying promote backend (`promoteUsersInGroup`) and the
// Apocentro magic-bytes wrapping of the resulting config / promote / group
// update payloads are unchanged.

import type { GroupPubkeyType, PubkeyType } from 'libsession_util_nodejs';
import { promoteUsersInGroup } from '../../interactions/conversationInteractions';
import { updateConfirmModal } from '../../state/ducks/modalDialog';
import { SessionButtonColor } from '../../components/basic/SessionButton';

/**
 * Whether the Apocentro group sub-admin (promote-to-admin) affordance is shown
 * to group admins. Always on for Apocentro; this replaces upstream Session's
 * `useClosedGroupV2QAButtons` QA gate on the promote/resend-promote buttons.
 */
export const APOCENTRO_GROUP_SUBADMIN_ENABLED: boolean = true;

/**
 * Show the "promote to admin" confirmation, then promote on confirm. The
 * confirmation makes the irreversibility (no demote) explicit, matching the
 * Android/iOS clients.
 */
export function confirmAndPromoteToAdmin({
  groupPk,
  pubkey,
  memberName,
}: {
  groupPk: GroupPubkeyType;
  pubkey: PubkeyType;
  memberName: string;
}) {
  window.inboxStore?.dispatch(
    updateConfirmModal({
      title: { token: 'promote' },
      i18nMessage: { token: 'adminPromoteDescription', name: memberName },
      okTheme: SessionButtonColor.Danger,
      okText: { token: 'promote' },
      onClickOk: async () => {
        await promoteUsersInGroup({ groupPk, toPromote: [pubkey] });
      },
      onClickClose: () => {
        window.inboxStore?.dispatch(updateConfirmModal(null));
      },
    })
  );
}
