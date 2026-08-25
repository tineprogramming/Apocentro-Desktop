// TODO move into redux slice

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export enum SectionType {
  Profile,
  DebugMenu,
  ThemeSwitch,
}

export type LeftOverlayType =
  | 'choose-action'
  | 'message'
  | 'open-group'
  | 'closed-group'
  | 'message-requests'
  | 'invite-a-friend';

type LeftOverlayTypesWithInput = 'message' | 'open-group' | 'closed-group';

type LeftOverlayDefaultState = {
  type: Exclude<LeftOverlayType, LeftOverlayTypesWithInput>;
  params: null;
};
type LeftOverlayWithInputState = {
  type: Extract<LeftOverlayType, LeftOverlayTypesWithInput>;
  params: { initialInputValue: string };
};

export type LeftOverlayMode = LeftOverlayDefaultState | LeftOverlayWithInputState;

type RightPanelDefaultState = { type: 'default'; params: null };
type RightPanelMessageInfoState = {
  type: 'message_info';
  params: { messageId: string; visibleAttachmentIndex: number | undefined };
};
export type RightOverlayMode = RightPanelDefaultState | RightPanelMessageInfoState;

// Apocentro: narrows the left pane conversation list.
// 'unread' = any conversation with unread messages.
// 'unreplied' = unread AND we haven't sent the last message (still waiting on us).
export type ConversationFilterType = 'all' | 'unread' | 'unreplied';

export const initialSectionState: SectionStateType = {
  isAppFocused: false,
  leftOverlayMode: undefined,
  rightOverlayMode: { type: 'default', params: null },
  conversationFilter: 'all',
};

export type SectionStateType = {
  isAppFocused: boolean;
  leftOverlayMode: LeftOverlayMode | undefined;
  rightOverlayMode: RightOverlayMode | undefined;
  conversationFilter: ConversationFilterType;
};

const sectionSlice = createSlice({
  name: 'sectionSlice',
  initialState: initialSectionState,
  reducers: {
    setLeftOverlayMode(state, action: PayloadAction<LeftOverlayMode>) {
      return {
        ...state,
        leftOverlayMode: action.payload,
      };
    },
    resetLeftOverlayMode(state) {
      return {
        ...state,
        leftOverlayMode: undefined,
      };
    },
    setRightOverlayMode(state, action: PayloadAction<RightOverlayMode>) {
      return {
        ...state,
        rightOverlayMode: action.payload,
      };
    },
    resetRightOverlayMode(state) {
      return {
        ...state,
        rightOverlayMode: undefined,
      };
    },
    setIsAppFocused(state, action: PayloadAction<boolean>) {
      return {
        ...state,
        isAppFocused: action.payload,
      };
    },
    setConversationFilter(state, action: PayloadAction<ConversationFilterType>) {
      return {
        ...state,
        conversationFilter: action.payload,
      };
    },
  },
});

export const reducer = sectionSlice.reducer;
export const sectionActions = {
  ...sectionSlice.actions,
};
