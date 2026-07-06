import { useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import useInterval from 'react-use/lib/useInterval';
import useMount from 'react-use/lib/useMount';
import styled from 'styled-components';
import { CallManager, UserUtils } from '../../session/utils';
import {
  getCallIsInFullScreen,
  getCallWithFocusedConvoIsOffering,
  getCallWithFocusedConvosIsConnected,
  getCallWithFocusedConvosIsConnecting,
  getHasOngoingCallWithFocusedConvo,
  getHasOngoingCallWithPubkey,
} from '../../state/selectors/call';
import { Avatar, AvatarSize } from '../avatar/Avatar';
import { StyledVideoElement } from './DraggableCallContainer';

import { useModuloWithTripleDots } from '../../hooks/useModuloWithTripleDots';
import { useVideoCallEventsListener } from '../../hooks/useVideoEventListener';
import {
  DEVICE_DISABLED_DEVICE_ID,
  type ApocentroCallStats,
} from '../../session/utils/calling/CallManager';
import { CallWindowControls } from './CallButtons';
import { ensureGeoReader, countryForIp } from '../../session/utils/calling/ApocentroGeo';
import {
  isPeerReachableOnLan,
  getLastLanSendStatus,
  getLanServicesSeen,
} from '../../session/utils/calling/ApocentroLanCalling';
import { APOCENTRO_CALL_DEBUG_KEY } from '../../session/utils/calling/ApocentroCallConfig';

import { useFormattedDuration } from '../../hooks/useFormattedDuration';
import { SessionSpinner } from '../loading';
import { tr } from '../../localization/localeTools';

const VideoContainer = styled.div`
  height: 100%;
  width: 50%;
  z-index: 0;
  padding-top: 30px; // leave some space at the top for the connecting/duration of the current call
`;

const InConvoCallWindow = styled.div`
  padding: 1rem;
  display: flex;

  background-color: var(--background-primary-color);

  flex-shrink: 1;
  min-height: 80px;
  align-items: center;
  flex-grow: 1;
`;

// Flex column: the Apocentro info bar is a REAL sibling above the call window
// (not an absolute overlay), so the call controls live in the window *below* it
// and can never be covered, whatever the pane height.
const StyledCallColumn = styled.div`
  display: flex;
  flex-direction: column;
  flex-grow: 1;
  flex-shrink: 1;
  min-height: 80px;
`;

const RelativeCallWindow = styled.div`
  position: relative;
  height: 100%;
  display: flex;
  flex-grow: 1;
`;

const CenteredAvatarInConversation = styled.div`
  top: -50%;
  transform: translateY(-50%);
  position: relative;
  bottom: 0;
  left: 0;
  right: 50%;

  display: flex;
  justify-content: center;
  align-items: center;
`;

const StyledCenteredLabel = styled.div`
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  height: min-content;
  white-space: nowrap;
  color: var(--text-primary-color);
  z-index: 5;
`;

const RingingLabel = () => {
  const ongoingCallWithFocusedIsRinging = useSelector(getCallWithFocusedConvoIsOffering);

  const modulatedStr = useModuloWithTripleDots(tr('callsRinging'), 3, 1000);
  if (!ongoingCallWithFocusedIsRinging) {
    return null;
  }
  return <StyledCenteredLabel>{modulatedStr}</StyledCenteredLabel>;
};

const ConnectingLabel = () => {
  const ongoingCallWithFocusedIsConnecting = useSelector(getCallWithFocusedConvosIsConnecting);

  const modulatedStr = useModuloWithTripleDots(tr('callsConnecting'), 3, 1000);

  if (!ongoingCallWithFocusedIsConnecting) {
    return null;
  }

  return <StyledCenteredLabel>{modulatedStr}</StyledCenteredLabel>;
};

const DurationLabel = () => {
  const [callDurationSeconds, setCallDuration] = useState<number>(0);
  const ongoingCallWithFocusedIsConnected = useSelector(getCallWithFocusedConvosIsConnected);

  useInterval(() => {
    const duration = CallManager.getCurrentCallDuration();
    if (duration) {
      setCallDuration(duration);
    }
  }, 100);
  const dateString = useFormattedDuration(callDurationSeconds, { forceHours: true });

  if (!ongoingCallWithFocusedIsConnected || !callDurationSeconds || callDurationSeconds < 0) {
    return null;
  }

  return <StyledCenteredLabel>{dateString}</StyledCenteredLabel>;
};

// Apocentro: on-screen call diagnostics (connection type, latency, selected
// local/remote candidate + state), like the Android call debug overlay.
//
// This is a REAL bar that sits above the call window as a flex sibling (see
// StyledCallColumn) — NOT an absolute overlay. It therefore takes its own
// vertical space and pushes the video + call controls down below it, so it can
// never cover the buttons. It is kept compact (a single wrapping row) so it
// doesn't eat the call window.
const StyledCallInfoOverlay = styled.div`
  width: 100%;
  box-sizing: border-box;
  flex-shrink: 0;
  padding: 5px 10px;
  background: var(--background-secondary-color);
  color: var(--text-primary-color);
  border-bottom: 1px solid var(--border-color);
  font-size: 11px;
  line-height: 1.4;
  font-family: var(--font-mono, monospace);
  display: flex;
  flex-flow: row wrap;
  align-items: center;
  justify-content: center;
  gap: 3px 10px;
`;

const StyledInfoItem = styled.span`
  white-space: nowrap;
`;

// Badge colour reflects the connection type, like the Android overlay:
//  - direct / local network → green
//  - relayed via TURN        → orange
//  - not yet connected       → neutral grey
type BadgeVariant = 'direct' | 'relay' | 'idle';

const badgeBg = (v: BadgeVariant) =>
  v === 'direct'
    ? 'rgba(0, 190, 100, 0.92)'
    : v === 'relay'
      ? 'rgba(240, 150, 20, 0.95)'
      : 'var(--background-primary-color)';

const badgeFg = (v: BadgeVariant) => (v === 'idle' ? 'var(--text-primary-color)' : '#0a0a0a');

const StyledConnBadge = styled.div<{ $variant: BadgeVariant }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 11px;
  font-weight: 600;
  background: ${props => badgeBg(props.$variant)};
  color: ${props => badgeFg(props.$variant)};
`;

const StyledBars = styled.div`
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 13px;
`;

const StyledBar = styled.div<{ $on: boolean; $h: number; $variant: BadgeVariant }>`
  width: 3px;
  height: ${props => props.$h}px;
  border-radius: 1px;
  background: ${props =>
    props.$on
      ? props.$variant === 'idle'
        ? 'var(--text-primary-color)'
        : 'rgba(10, 10, 10, 0.85)'
      : props.$variant === 'idle'
        ? 'var(--text-secondary-color)'
        : 'rgba(10, 10, 10, 0.3)'};
`;

const SignalBars = ({ filled, variant }: { filled: number; variant: BadgeVariant }) => {
  const heights = [5, 8, 11, 14];
  return (
    <StyledBars>
      {heights.map((h, i) => (
        <StyledBar key={h} $h={h} $on={i < filled} $variant={variant} />
      ))}
    </StyledBars>
  );
};

// Signal-strength bars (0–4) from round-trip latency, like the Android overlay.
function barsForConnection(stats: ApocentroCallStats | null): number {
  if (!stats || stats.connectionState !== 'connected') {
    return 0;
  }
  const rtt = stats.rttMs;
  if (rtt == null) {
    return 2;
  }
  if (rtt < 60) {
    return 4;
  }
  if (rtt < 150) {
    return 3;
  }
  if (rtt < 300) {
    return 2;
  }
  return 1;
}

const ApocentroCallInfoOverlay = () => {
  // Show for the whole ongoing call (ringing / connecting / connected) so it's
  // useful precisely while a call is still trying to connect.
  const hasOngoingCall = useSelector(getHasOngoingCallWithFocusedConvo);
  const ongoingCallPubkey = useSelector(getHasOngoingCallWithPubkey);
  const [stats, setStats] = useState<ApocentroCallStats | null>(null);

  useMount(() => {
    ensureGeoReader();
  });

  useInterval(() => {
    if (!hasOngoingCall) {
      return;
    }
    void CallManager.getApocentroCallStats().then(setStats);
  }, 1000);

  if (!hasOngoingCall) {
    return null;
  }

  const lanReachable = ongoingCallPubkey ? isPeerReachableOnLan(ongoingCallPubkey) : false;
  const lanSend = getLastLanSendStatus();
  const isConnected = stats?.connectionState === 'connected';
  const isRelay = stats?.type === 'Relay';
  const badge = stats?.isLocalNetwork ? 'Local network' : (stats?.type ?? '…');
  const badgeVariant: BadgeVariant = !isConnected ? 'idle' : isRelay ? 'relay' : 'direct';
  const remoteCountry = countryForIp(stats?.remoteAddress ?? null);

  // The address that best represents where we're connected: for a TURN call the
  // relay's public IP (our local 'relay' candidate), otherwise the remote peer.
  // Shown always, like the Android "Cloudflare relay · 🇺🇸 <ip>" / "<flag> <ip>"
  // line, with an offline country flag from the local GeoLite2 db.
  const whereIp = isRelay ? (stats?.localAddress ?? stats?.remoteAddress) : stats?.remoteAddress;
  const whereCountry = countryForIp(whereIp ?? null);

  // Verbose LAN/ICE diagnostics are gated behind the "Show call connection
  // details" setting (default on). When off, only the connection-type badge +
  // signal bars + latency + the peer IP/country show — like the Android/phone view.
  const showDebug = window.getSettingValue?.(APOCENTRO_CALL_DEBUG_KEY) !== false;

  // While the call is still being set up, surface ICE progress the way the
  // Android app does ("Handling Connection Candidates …") instead of nothing.
  const settingUp = !isConnected && stats?.iceState !== 'completed';
  const progress =
    settingUp && stats
      ? `Handling connection candidates ${stats.remoteCandidateCount}`
      : null;

  return (
    <StyledCallInfoOverlay>
      <StyledConnBadge $variant={badgeVariant}>
        {badge}
        <SignalBars filled={barsForConnection(stats)} variant={badgeVariant} />
        {stats?.rttMs != null ? `${stats.rttMs} ms` : ''}
      </StyledConnBadge>
      {whereIp && (
        <StyledInfoItem>
          {isRelay ? 'Relay · ' : ''}
          {whereCountry ? `${whereCountry.flag} ` : ''}
          {whereIp}
        </StyledInfoItem>
      )}
      {progress && <StyledInfoItem>{progress}</StyledInfoItem>}
      {showDebug && (
        <>
          <StyledInfoItem>
            LAN {lanReachable ? '✓' : '✗'} · mDNS {getLanServicesSeen()}
          </StyledInfoItem>
          <StyledInfoItem>
            send {lanSend ? `${lanSend.ok ? '✓' : '✗'} ${lanSend.detail}` : '—'}
          </StyledInfoItem>
          <StyledInfoItem>
            state {stats?.connectionState ?? '…'} · ice {stats?.iceState ?? '…'}
          </StyledInfoItem>
          {stats?.remoteAddress && (
            <StyledInfoItem>
              peer {remoteCountry ? `${remoteCountry.flag} ` : ''}
              {stats.remoteAddress} ({stats.remoteCandidateType})
            </StyledInfoItem>
          )}
          {stats?.localAddress && (
            <StyledInfoItem>
              you {stats.localAddress} ({stats.localCandidateType})
            </StyledInfoItem>
          )}
        </>
      )}
    </StyledCallInfoOverlay>
  );
};

const StyledSpinner = styled.div<{ $fullWidth: boolean }>`
  height: 100%;
  width: ${props => (props.$fullWidth ? '100%' : '50%')};
  display: flex;
  justify-content: center;
  align-items: center;
  position: absolute;
  z-index: -1;
`;

export const VideoLoadingSpinner = (props: { fullWidth: boolean }) => {
  return (
    <StyledSpinner $fullWidth={props.fullWidth}>
      <SessionSpinner $loading={true} />
    </StyledSpinner>
  );
};

export const InConversationCallContainer = () => {
  const isInFullScreen = useSelector(getCallIsInFullScreen);

  const ongoingCallPubkey = useSelector(getHasOngoingCallWithPubkey);
  const ongoingCallWithFocused = useSelector(getHasOngoingCallWithFocusedConvo);
  const videoRefRemote = useRef<HTMLVideoElement>(null);
  const videoRefLocal = useRef<HTMLVideoElement>(null);

  const ourPubkey = UserUtils.getOurPubKeyStrFromCache();

  const {
    currentConnectedAudioInputs,
    currentConnectedCameras,
    currentConnectedAudioOutputs,
    currentSelectedAudioOutput,
    localStream,
    localStreamVideoIsMuted,
    remoteStream,
    remoteStreamVideoIsMuted,
    isAudioMuted,
    isAudioOutputMuted,
  } = useVideoCallEventsListener('InConversationCallContainer', true);

  if (videoRefRemote?.current && videoRefLocal?.current) {
    if (videoRefRemote.current.srcObject !== remoteStream) {
      videoRefRemote.current.srcObject = remoteStream;
    }

    if (videoRefLocal.current.srcObject !== localStream) {
      videoRefLocal.current.srcObject = localStream;
    }

    if (videoRefRemote.current) {
      if (currentSelectedAudioOutput === DEVICE_DISABLED_DEVICE_ID) {
        videoRefRemote.current.muted = true;
      } else {
        void (videoRefRemote.current as any)?.setSinkId(currentSelectedAudioOutput);
        videoRefRemote.current.muted = false;
      }
    }
  }

  if (isInFullScreen && videoRefRemote.current) {
    // disable this video element so the one in fullscreen is the only one playing audio
    videoRefRemote.current.muted = true;
  }

  if (!ongoingCallWithFocused || !ongoingCallPubkey) {
    return null;
  }

  return (
    <StyledCallColumn>
      <ApocentroCallInfoOverlay />
      <InConvoCallWindow>
        <RelativeCallWindow>
          <RingingLabel />
          <ConnectingLabel />
          <DurationLabel />
          <VideoContainer>
          <VideoLoadingSpinner fullWidth={false} />
          <StyledVideoElement
            ref={videoRefRemote}
            autoPlay={true}
            $isVideoMuted={remoteStreamVideoIsMuted}
          />
          {remoteStreamVideoIsMuted && (
            <CenteredAvatarInConversation>
              <Avatar size={AvatarSize.XL} pubkey={ongoingCallPubkey} />
            </CenteredAvatarInConversation>
          )}
        </VideoContainer>
        <VideoContainer>
          <StyledVideoElement
            ref={videoRefLocal}
            autoPlay={true}
            muted={true}
            $isVideoMuted={localStreamVideoIsMuted}
          />
          {localStreamVideoIsMuted && (
            <CenteredAvatarInConversation>
              <Avatar size={AvatarSize.XL} pubkey={ourPubkey} />
            </CenteredAvatarInConversation>
          )}
        </VideoContainer>

        <CallWindowControls
          currentConnectedAudioInputs={currentConnectedAudioInputs}
          currentConnectedCameras={currentConnectedCameras}
          isAudioMuted={isAudioMuted}
          currentConnectedAudioOutputs={currentConnectedAudioOutputs}
          isAudioOutputMuted={isAudioOutputMuted}
          localStreamVideoIsMuted={localStreamVideoIsMuted}
          remoteStreamVideoIsMuted={remoteStreamVideoIsMuted}
          isFullScreen={false}
        />
        </RelativeCallWindow>
      </InConvoCallWindow>
    </StyledCallColumn>
  );
};
