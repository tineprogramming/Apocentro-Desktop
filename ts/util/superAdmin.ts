/**
 * Apocentro group "super admin": exactly one admin per group who is allowed to remove
 * members (all other admins keep their usual powers). The role is stored as an invisible
 * machine-readable tag appended to the synced GroupInfo.description:
 *
 *     <visible description>\u2063apocentro-sa:<accountIdHex>
 *
 * The role is *derived from the tag*, so transferring it (rewriting the tag) automatically
 * downgrades the previous holder -- no key revocation involved. Enforcement is client-side
 * policy (all official Apocentro clients honour it); it cannot be cryptographic because
 * every admin holds the same group admin key. Groups without a tag are in "legacy mode":
 * every admin may remove members, and any admin may claim the role.
 *
 * This is the desktop half of the cross-platform contract; keep it byte-for-byte in step
 * with `com/apocentro/groups/SuperAdmin.kt` on Android.
 */

// Invisible separator: keeps the tag out of sight even on clients that don't strip it.
const SEPARATOR = '\u2063';
const PREFIX = 'apocentro-sa:';
const ACCOUNT_ID_HEX_LENGTH = 66;

/** The super admin's account ID hex, or null if the group has none (legacy mode). */
function parse(description: string | null | undefined): string | null {
  if (!description) {
    return null;
  }
  const tagStart = description.indexOf(SEPARATOR);
  if (tagStart < 0) {
    return null;
  }
  const tag = description.substring(tagStart + 1);
  if (!tag.startsWith(PREFIX)) {
    return null;
  }
  const accountId = tag.slice(PREFIX.length, PREFIX.length + ACCOUNT_ID_HEX_LENGTH);

  return accountId.length === ACCOUNT_ID_HEX_LENGTH ? accountId : null;
}

/** The human-visible part of the description, with any tag removed. */
function strip(description: string | null | undefined): string {
  if (!description) {
    return '';
  }
  const tagStart = description.indexOf(SEPARATOR);

  return tagStart < 0 ? description : description.substring(0, tagStart);
}

/** Rebuilds the full description from a visible part and an optional super admin ID. */
function embed(visibleDescription: string, superAdminIdHex: string | null): string {
  const visible = strip(visibleDescription);

  return superAdminIdHex ? visible + SEPARATOR + PREFIX + superAdminIdHex : visible;
}

export const SuperAdmin = { parse, strip, embed };
