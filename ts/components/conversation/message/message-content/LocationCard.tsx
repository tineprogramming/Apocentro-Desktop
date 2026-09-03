import styled from 'styled-components';

import { getAppDispatch } from '../../../../state/dispatch';
import { updateOpenUrlModal } from '../../../../state/ducks/modalDialog';
import { tr } from '../../../../localization/localeTools';
import {
  coordinatesLabel,
  openStreetMapUrl,
  type ParsedLocation,
} from '../../../../util/locationMessage';
import { LucideIcon } from '../../../icon/LucideIcon';
import { LUCIDE_ICONS_UNICODE } from '../../../icon/lucide';
import { createButtonOnKeyDownForClickEventHandler } from '../../../../util/keyboardShortcuts';

/**
 * Apocentro location bubble, mirroring Android's LocationCardView.
 *
 * Deliberately tile-free, like Android: no map SDK and no tile fetch, so simply
 * receiving a location never reaches out to a map server and leaks that the
 * message was opened. Clicking hands the OpenStreetMap link to the usual
 * "open this link?" modal instead.
 */
const StyledLocationCard = styled.button`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--margins-sm);
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  text-align: start;
  cursor: pointer;
  font-family: inherit;
`;

const StyledIconCircle = styled.div`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background-color: var(--primary-color);
`;

const StyledTextColumn = styled.div`
  display: flex;
  flex-direction: column;
  min-width: 0;
`;

const StyledTitle = styled.span`
  font-weight: bold;
`;

const StyledCoordinates = styled.span`
  font-size: var(--font-size-sm);
  opacity: 0.8;
  word-break: break-word;
`;

const StyledOpen = styled.span`
  font-size: var(--font-size-sm);
  opacity: 0.6;
`;

export const LocationCard = ({ location }: { location: ParsedLocation }) => {
  const dispatch = getAppDispatch();

  const onClick = () => {
    dispatch(updateOpenUrlModal({ urlToOpen: openStreetMapUrl(location) }));
  };

  const coordinates =
    location.accuracyMeters !== null
      ? `${coordinatesLabel(location)} · ±${location.accuracyMeters} m`
      : coordinatesLabel(location);

  return (
    <StyledLocationCard
      onClick={onClick}
      onKeyDown={createButtonOnKeyDownForClickEventHandler(onClick)}
      data-testid="location-card"
      aria-label={tr('locationMyLocationDev')}
    >
      <StyledIconCircle>
        <LucideIcon
          unicode={LUCIDE_ICONS_UNICODE.PIN}
          iconSize="medium"
          iconColor="var(--black-color)"
        />
      </StyledIconCircle>
      <StyledTextColumn>
        <StyledTitle>{tr('locationMyLocationDev')}</StyledTitle>
        <StyledCoordinates>{coordinates}</StyledCoordinates>
        <StyledOpen>{tr('locationOpenInMapsDev')}</StyledOpen>
      </StyledTextColumn>
    </StyledLocationCard>
  );
};
