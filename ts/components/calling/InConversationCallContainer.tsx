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
} from '../../session/utils/calling/ApocentroLanCalling';

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
// local/remote candidate + state), like the Android call debug overlay. Shown
// while a call is connected.
const StyledCallInfoOverlay = styled.div`
  position: absolute;
  top: 30px; // sits just under the ringing/connecting/duration label, like extra lines of it
  left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  color: var(--text-secondary-color);
  font-size: 11px;
  line-height: 1.5;
  font-family: var(--font-mono, monospace);
  pointer-events: none;
  max-width: 90%;
  white-space: nowrap;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
`;

const StyledConnBadge = styled.div<{ $connected: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 11px;
  font-weight: 600;
  margin-bottom: 4px;
  background: ${props =>
    props.$connected ? 'rgba(0, 190, 100, 0.92)' : 'rgba(255, 255, 255, 0.14)'};
  color: ${props => (props.$connected ? '#04150c' : 'var(--text-primary-color)')};
`;

const StyledBars = styled.div`
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 13px;
`;

const StyledBar = styled.div<{ $on: boolean; $h: number; $connected: boolean }>`
  width: 3px;
  height: ${props => props.$h}px;
  border-radius: 1px;
  background: ${props =>
    props.$on
      ? props.$connected
        ? '#04150c'
        : 'var(--text-primary-color)'
      : props.$connected
        ? 'rgba(4, 21, 12, 0.3)'
        : 'rgba(255, 255, 255, 0.25)'};
`;

const SignalBars = ({ filled, connected }: { filled: number; connected: boolean }) => {
  const heights = [5, 8, 11, 14];
  return (
    <StyledBars>
      {heights.map((h, i) => (
        <StyledBar key={h} $h={h} $on={i < filled} $connected={connected} />
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
  const badge = stats?.isLocalNetwork ? 'Local network' : (stats?.type ?? '…');
  const remoteCountry = countryForIp(stats?.remoteAddress ?? null);
  return (
    <StyledCallInfoOverlay>
      <StyledConnBadge $connected={isConnected}>
        {badge}
        <SignalBars filled={barsForConnection(stats)} connected={isConnected} />
        {stats?.rttMs != null ? `${stats.rttMs} ms` : ''}
      </StyledConnBadge>
      <div>LAN peer: {lanReachable ? 'discovered ✓' : 'not discovered ✗'}</div>
      <div>
        LAN send:{' '}
        {lanSend ? `${lanSend.ok ? 'OK ✓' : 'failed ✗'} ${lanSend.detail}` : '—'}
      </div>
      <div>state: {stats?.connectionState ?? '…'}</div>
      {stats?.remoteAddress && (
        <div>
          peer: {remoteCountry ? `${remoteCountry.flag} ` : ''}
          {stats.remoteAddress} ({stats.remoteCandidateType})
        </div>
      )}
      {stats?.localAddress && (
        <div>
          you: {stats.localAddress} ({stats.localCandidateType})
        </div>
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
    <InConvoCallWindow>
      <RelativeCallWindow>
        <RingingLabel />
        <ConnectingLabel />
        <DurationLabel />
        <ApocentroCallInfoOverlay />
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
  );
};
