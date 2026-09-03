/**
 * Dev-only strings — English only, not yet official.
 *
 * These tokens use a "Dev" suffix so they never collide with
 * the Crowdin-generated tokens.  They are resolved by localeTools
 * before the normal lookup chain, and always return the English value
 * regardless of the active locale.
 *
 * Once a string is promoted to the official translation pipeline,
 * remove it from here and add it via the shared-scripts generator.
 */
export const devSimpleNoArgs = {
  serverUnbanUserDev: 'Unban User from Server',
  globalUserUnbanFailedDev: 'Unban failed! Are you a global admin/mod?',
  serverBanUserDev: 'Ban User from Server',
  serverBanUserAndDeleteAllDev: 'Ban from Server and Delete All',
  addUploadPermissionDev: 'Allow sending attachments',
  clearUploadPermissionDev: 'Remove attachment exception',
  userPermissionsChangedDev: 'Changed user permissions successfully',
  failedToChangeUserPermissionsDev: 'Failed to change user permissions',
  globalUserBanFailedDev: 'Ban failed! Are you a global admin/mod?',
  communityChangePermissionsDev: 'Edit Permissions',
  communityPermissionAccessDescriptionDev: 'Anyone can see the room (+a)',
  communityPermissionAccessEnableDev: 'Enable room visibility',
  communityPermissionReadDescriptionDev: 'Anyone can read messages (+r)',
  communityPermissionReadEnableDev: 'Enable reading',
  communityPermissionUploadDescriptionDev: 'Anyone can upload files (+u)',
  communityPermissionUploadEnableDev: 'Enable uploads',
  communityPermissionWriteDescriptionDev: 'Anyone can send messages (+w)',
  communityPermissionWriteEnableDev: 'Enable writing',
  communityChangePermissionsDescriptionDev:
    "For compatibility reasons, we don't know which permissions were enabled to begin with, but you can set new values below regardless.",
  conversationIdDev: 'Conversation ID:',
  messageHashDev: 'Message Hash:',
  serverIdDev: 'Server ID:',
  timestampDev: 'Timestamp:',
  serverTimestampDev: 'Server Timestamp:',
  expirationTypeDev: 'Expiration Type:',
  expirationDurationDev: 'Expiration Duration:',
  disappearsDev: 'Disappears:',
  codePointsDev: 'Code Points:',
  debugModeEnabledToastDev: 'Debug mode enabled!',
  debugModeDisabledToastDev: 'Debug mode disabled!',

  // gifs
  searchForGifs: 'Search for gifs',
  giphyIntegrationDescription: 'Enable giphy integration in Session',

  // Apocentro calling
  callsDebugInfoDev: 'Show call connection details',
  callsDebugInfoDescriptionDev:
    'Show LAN discovery, connection state and candidate details during a call. Turn off to show only the connection type, signal strength and latency.',
  callsFirewallDev: 'Offline calls firewall access',
  callsFirewallDescriptionDev:
    'Allow Apocentro through Windows Firewall so offline LAN calls can connect without turning the firewall off. Requires administrator approval once.',
  callsFirewallButtonDev: 'Allow',
  callsFirewallAddedButtonDev: 'Allowed',
  callsFirewallDoneDev: 'Firewall exception added. Offline calls should now connect.',
  callsFirewallFailedDev: 'Could not add the firewall exception.',
  callsFirewallEnabledDescriptionDev:
    'Apocentro is already allowed through Windows Firewall, so offline LAN calls can connect.',

  // Apocentro Nearby / LAN discovery
  lanNearbyDev: 'Nearby (LAN discovery)',
  lanNearbyDescriptionDev:
    'Find your contacts on the same network for direct LAN calls and offline messages (uses mDNS port 5353). Turn off if it conflicts with another app on your computer.',
  lanPortConflictAppsPrefixDev:
    'Nearby/LAN discovery is unavailable — mDNS port 5353 is being used by:',
  lanPortConflictGenericDev:
    'Nearby/LAN discovery is unavailable — another app is using mDNS port 5353.',
  lanPortConflictAdviceDev:
    'Close that app to get Nearby back, or tap here to turn Nearby off in Privacy settings.',

  // Apocentro connection diagnostics (onion path dialog)
  connectionDetailsShowDev: 'Show connection details',
  connectionDetailsHideDev: 'Hide connection details',

  // Apocentro 1:1 delete conversation (device only vs others only vs for everyone)
  deleteOnThisDeviceDev: 'Delete on this device',
  deleteOthersOnlyDev: "Delete from other people's devices only",
  deleteConversationForEveryoneDev: 'Delete for everyone',
  deleteConversationForEveryoneFailedDev: 'Could not delete this conversation for everyone.',

  // Apocentro message cleaner
  clearOthersOnlyDev: "Clear from other people's devices only",
  clearMessagesFailedDev: 'Could not clear those messages.',
  messageCleanerDev: 'Message cleaner',
  clearAllHistoryDev: 'Clear all message history',
  clearAllHistoryDescriptionDev:
    'Clear the messages in every conversation at once. Note to Self is left alone.',
  clearAllHistoryConfirmDev:
    'Are you sure you want to clear the messages in every conversation? This cannot be undone.',
  clearedAllHistoryDev: 'Cleared every conversation.',
  autoClearDev: 'Auto-clear messages',
  autoClearShortDescriptionDev: 'Automatically delete messages once they reach a chosen age.',
  autoClearSettingsDescriptionDev:
    'Delete messages automatically once they reach a chosen age. This keeps applying for as long as it is on, not just once.',
  autoClearUseGlobalDev: 'Use global setting',
  autoClearOffDev: 'Off',
  autoClearOlderThanDev: 'Delete messages older than:',
  autoClearAmountPlaceholderDev: 'Amount',
  autoClearAmountInvalidDev: 'Enter a whole number greater than 0',
  autoClearHoursDev: 'Hours',
  autoClearDaysDev: 'Days',

  // Apocentro "send my location"
  locationMyLocationDev: 'My location',
  locationOpenInMapsDev: 'Open in maps',
  locationFetchingDev: 'Getting your location...',
  locationFetchFailedDev: 'Could not get your location.',
  locationUnavailableDev: 'Location is not available on this device.',
  locationSendFailedDev: 'Could not send your location.',
  locationConfirmTitleDev: 'Send location?',
  locationConfirmDescriptionDev:
    'Your current coordinates will be sent to this conversation as a message.',

  // Apocentro left pane All/Unread/Unreplied filter chips
  filterAllDev: 'All',
  filterUnreadDev: 'Unread',
  filterUnrepliedDev: 'Unreplied',
  filterUnreadEmptyDev: 'No unread chats',
  filterUnrepliedEmptyDev: 'Nothing waiting on a reply',
} as const;

export type TokenDevNoArgs = keyof typeof devSimpleNoArgs;
