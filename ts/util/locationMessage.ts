/**
 * Apocentro "send my location" message format.
 *
 * A location rides inside a normal (E2EE, magic-bytes-wrapped) text message, so
 * no protocol change is needed and a client that doesn't know the format still
 * shows something useful -- a tappable OpenStreetMap link:
 *
 *     📍 My location
 *     geo:37.422000,-122.084100
 *     https://www.openstreetmap.org/?mlat=37.422000&mlon=-122.084100#map=17/37.422000/-122.084100
 *     ±12 m
 *
 * This must stay byte-identical to Android's LocationMessage.kt, which is the
 * reference implementation. In particular the geo: line carries the bare
 * "geo:LAT,LON" -- Android's parser splits it on "," and rejects anything that
 * doesn't yield exactly two parts, so the "geo:LAT,LON?q=LAT,LON" form used for
 * maps-app intents must never go on the wire.
 */

const MARKER = '\u{1F4CD} My location';
const GEO_PREFIX = 'geo:';
const ACCURACY_PREFIX = '±';
const DECIMALS = 6;

export interface ParsedLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
}

/** "37.422000, -122.084100", matching Android's Parsed.coordinatesLabel. */
export function coordinatesLabel({ latitude, longitude }: ParsedLocation): string {
  return `${latitude.toFixed(DECIMALS)}, ${longitude.toFixed(DECIMALS)}`;
}

/** The map link we hand to the OS. Desktop has no geo: handler, so we use the web map. */
export function openStreetMapUrl({ latitude, longitude }: ParsedLocation): string {
  const lat = latitude.toFixed(DECIMALS);
  const lon = longitude.toFixed(DECIMALS);

  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
}

export function buildLocationMessage(
  latitude: number,
  longitude: number,
  accuracyMeters: number | null
): string {
  const parsed: ParsedLocation = { latitude, longitude, accuracyMeters };
  const lat = latitude.toFixed(DECIMALS);
  const lon = longitude.toFixed(DECIMALS);

  let body = `${MARKER}\n${GEO_PREFIX}${lat},${lon}\n${openStreetMapUrl(parsed)}`;

  if (accuracyMeters !== null && accuracyMeters > 0) {
    body += `\n${ACCURACY_PREFIX}${accuracyMeters} m`;
  }

  return body;
}

function finiteNumberOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);

  return Number.isFinite(parsed) ? parsed : null;
}

/** Returns the location if `body` is an Apocentro location message, else null. */
export function parseLocationMessage(body: string | null | undefined): ParsedLocation | null {
  if (!body || !body.startsWith(MARKER)) {
    return null;
  }
  const lines = body.split('\n');

  const geoLine = lines.find(line => line.startsWith(GEO_PREFIX));
  if (!geoLine) {
    return null;
  }
  const coords = geoLine.slice(GEO_PREFIX.length).split(',');
  if (coords.length !== 2) {
    return null;
  }
  const latitude = finiteNumberOrNull(coords[0]);
  const longitude = finiteNumberOrNull(coords[1]);
  if (latitude === null || longitude === null) {
    return null;
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return null;
  }

  const accuracyLine = lines.find(line => line.startsWith(ACCURACY_PREFIX));
  const accuracyRaw = accuracyLine
    ?.slice(ACCURACY_PREFIX.length)
    .replace(/ m$/, '')
    .trim();
  // Android parses this with toIntOrNull, so only a plain integer counts.
  const accuracyMeters =
    accuracyRaw && /^-?\d+$/.test(accuracyRaw) ? Number.parseInt(accuracyRaw, 10) : null;

  return { latitude, longitude, accuracyMeters };
}

export function isLocationMessage(body: string | null | undefined): boolean {
  return parseLocationMessage(body) !== null;
}
