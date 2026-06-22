# Apocentro Desktop — Group Sub-Admin (promote member to admin)

A group **admin** can promote any **member who has accepted the group invite**
to admin. Once promoted, that member holds the group admin key and can invite
their own contacts — this is how delegated invites work in Apocentro. Ported
from the Apocentro **Android** reference implementation.

## Constraints (intrinsic to libsession groups-v2 — not bugs)

- **Two roles only: admin and member.** There is no reduced-power tier; holding
  the admin key *is* being an admin.
- **Admins cannot be demoted.** A shared admin key cannot be cryptographically
  revoked, and groups-v2 has no demote operation. To remove a bad admin in
  practice you create a new group. The promote confirmation states this.
- **Only accepted members can be promoted.** You cannot hand the admin key to
  someone who has not joined / received the group keys. The promote button only
  appears for members whose status is `INVITE_ACCEPTED`.

## What changed on Desktop

The promote-to-admin **backend already existed** upstream
(`promoteUsersInGroup` in `ts/interactions/conversationInteractions.ts`): it
marks the member promoted in the `GroupMembers` config, posts a signed
group-update (`promoted`) to the group swarm, and sends each promotee a
`GroupInvite` job with `inviteAsAdmin: true` (carrying the admin key seed).

Upstream only exposed the UI behind the `useClosedGroupV2QAButtons` **QA flag**.
Apocentro ships it as a real feature, so the changes are UI / discoverability:

- **`ts/session/apocentro/groupSubAdmin.ts`** (new)
  - `APOCENTRO_GROUP_SUBADMIN_ENABLED = true` — replaces the QA-flag gate.
  - `confirmAndPromoteToAdmin({ groupPk, pubkey, memberName })` — shows a
    confirmation (`adminPromoteDescription`: "…Admins cannot be removed.") then
    calls `promoteUsersInGroup`.
- **`ts/components/MemberListItem.tsx`**
  - `PromoteButton` is now gated on `APOCENTRO_GROUP_SUBADMIN_ENABLED` (+ the
    existing accepted-invite / not-already-admin / not-pending-removal checks)
    instead of the QA flag, and routes through the confirmation.
  - `ResendButton`'s `canResendPromotion` is likewise un-gated, so a failed
    promotion can be resent.

The promote/resend buttons render inside the **Manage members** dialog
(`UpdateGroupMembersDialog.tsx`) for v2 groups when the current user is an admin.

No change to the core promotion semantics or the accepted-only filter.

## Magic-bytes (§5) — already covered, no change needed

Promotion touches three snode payloads; all are already wrapped/stripped with the
Apocentro magic bytes by the existing foundation:

| Payload | Wrapped on send by |
|---|---|
| `GroupMembers` config push (promotion-sent) | `ts/session/apis/snode_api/SnodeRequestTypes.ts` (`StoreGroupConfigSubRequest.build()`) |
| 1-to-1 promote message (admin key seed) | `ts/session/sending/MessageWrapper.ts` (1o1) |
| group-update `promoted` message | `ts/session/sending/MessageWrapper.ts` (group) |
| subsequent invite by the new admin | same chat/config paths above |

Receive-side lenient strip for group config is in
`SwarmPollingGroupConfig.ts`; chat strip is in `swarmPolling.ts`.

## Verification

- Code paths and types reviewed; imports/paths verified.
- Build/typecheck not run here (Electron deps not installed in this environment).
  Run `pnpm install && pnpm build` before cutting a release.
- **Honest limit:** a true end-to-end promotion (member actually becomes admin
  and can invite) needs **two accounts** in one group with the promotee at the
  **accepted** state — one device cannot drive it. UI reachability + accepted-only
  gating + the no-demote confirmation are verifiable on a single client.
