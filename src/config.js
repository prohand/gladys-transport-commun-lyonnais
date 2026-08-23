// -----------------------------------------------------------------------------
// Integration configuration.
//
// The values come from the `config_schema` declared in
// `gladys-assistant-integration.json`: Gladys renders the form, the SDK fetches
// the result (`gladys.getConfig()`) and notifies every change through
// `gladys.onConfigUpdated()`.
//
// This module owns the defaults, forces the types (a form always sends
// strings) and parses the three "list of things to watch" fields into the
// structures the device modules consume.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (test/manifest.test.js enforces it).
export const DEFAULT_CONFIG = {
  // --- Data Grand Lyon credentials (TCL departures + park & ride) -----------
  grandlyon_username: '',
  grandlyon_password: '',
  grandlyon_base_url: 'https://data.grandlyon.com/fr/datapusher/ws/rdata',

  // --- What to watch --------------------------------------------------------
  stops: '',
  velov_stations: '',
  park_and_ride: '',

  // --- Poll frequencies, in seconds ----------------------------------------
  // Gladys drives the refresh: each device is published with its own
  // `poll_frequency`, and the core calls `onPoll(device)` at that interval.
  // The three sources do not move at the same speed, hence three knobs:
  //   - departures change every minute (they are countdowns);
  //   - Vélo'v availability is recomputed by JCDecaux every minute;
  //   - park & ride occupancy moves slowly outside rush hours.
  departures_poll_frequency: 60,
  velov_poll_frequency: 120,
  park_and_ride_poll_frequency: 300,

  // --- Misc -----------------------------------------------------------------
  velov_gbfs_url: 'https://api.cyclocity.fr/contracts/lyon/gbfs/v3/gbfs.json',
  max_departures: 3,
};

// Poll frequencies are clamped to this range: below 30 s the upstream feeds
// return the same payload anyway (and the open data platforms rate-limit),
// above one hour a "real-time" sensor stops being real-time.
const MIN_POLL_FREQUENCY = 30;
const MAX_POLL_FREQUENCY = 3600;

/**
 * Clamp a poll frequency to the accepted range, falling back to the default
 * when the form sent something unusable (empty string, NaN...).
 * @param {unknown} value raw value from the config form
 * @param {number} fallback default declared in the manifest
 * @returns {number} a poll frequency in seconds
 */
export function normalizePollFrequency(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(MAX_POLL_FREQUENCY, Math.max(MIN_POLL_FREQUENCY, Math.round(parsed)));
}

/**
 * Split a user-provided list. Accepts commas, semicolons and newlines so the
 * user can paste a column from a spreadsheet as easily as a one-liner.
 * @param {unknown} raw
 * @returns {string[]} trimmed, non-empty entries
 */
function splitList(raw) {
  if (typeof raw !== 'string') {
    return [];
  }
  return raw
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse a watched transit stop.
 *
 * Syntax: `<stopId>[@<line>[|<line>...]][:<custom name>]`
 *   - `1234`                       every departure of stop 1234
 *   - `1234@T1`                    only line T1
 *   - `1234@C3|C13`                lines C3 and C13
 *   - `1234@T1:Home tram stop`     only T1, displayed as "Home tram stop"
 *
 * @param {string} entry one raw entry of the `stops` field
 * @returns {{ id: string, lines: string[], name: string | null } | null}
 */
export function parseStopEntry(entry) {
  // The custom name is free text and may itself contain '@', so cut on ':' first.
  const separatorIndex = entry.indexOf(':');
  const target = separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
  const name = separatorIndex === -1 ? null : entry.slice(separatorIndex + 1).trim() || null;

  const [rawId, rawLines] = target.split('@');
  const id = rawId.trim();
  if (id.length === 0) {
    return null;
  }

  const lines = (rawLines ?? '')
    .split('|')
    .map((line) => line.trim().toUpperCase())
    .filter((line) => line.length > 0);

  return { id, lines, name };
}

/**
 * Parse an entry of the Vélo'v / park & ride lists.
 * Syntax: `<id>[:<custom name>]`.
 * @param {string} entry
 * @returns {{ id: string, name: string | null } | null}
 */
export function parseSimpleEntry(entry) {
  const separatorIndex = entry.indexOf(':');
  const id = (separatorIndex === -1 ? entry : entry.slice(0, separatorIndex)).trim();
  if (id.length === 0) {
    return null;
  }
  const name = separatorIndex === -1 ? null : entry.slice(separatorIndex + 1).trim() || null;
  return { id, name };
}

/**
 * Merge the user config with the defaults and pre-parse the watch lists, so
 * the rest of the code never deals with `undefined` nor with raw strings.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    grandlyon_username: String(raw.grandlyon_username ?? '').trim(),
    grandlyon_password: String(raw.grandlyon_password ?? ''),
    grandlyon_base_url: String(raw.grandlyon_base_url || DEFAULT_CONFIG.grandlyon_base_url).replace(
      /\/+$/,
      '',
    ),
    velov_gbfs_url: String(raw.velov_gbfs_url || DEFAULT_CONFIG.velov_gbfs_url),
    departures_poll_frequency: normalizePollFrequency(
      raw.departures_poll_frequency,
      DEFAULT_CONFIG.departures_poll_frequency,
    ),
    velov_poll_frequency: normalizePollFrequency(
      raw.velov_poll_frequency,
      DEFAULT_CONFIG.velov_poll_frequency,
    ),
    park_and_ride_poll_frequency: normalizePollFrequency(
      raw.park_and_ride_poll_frequency,
      DEFAULT_CONFIG.park_and_ride_poll_frequency,
    ),
    max_departures: Math.min(
      5,
      Math.max(1, Math.round(Number(raw.max_departures ?? DEFAULT_CONFIG.max_departures)) || 1),
    ),
  };

  // Pre-parsed watch lists, consumed by src/devices/index.js.
  config.watched = {
    stops: splitList(config.stops).map(parseStopEntry).filter(Boolean),
    velovStations: splitList(config.velov_stations).map(parseSimpleEntry).filter(Boolean),
    parkAndRide: splitList(config.park_and_ride).map(parseSimpleEntry).filter(Boolean),
  };

  return config;
}

/**
 * Whether the Data Grand Lyon credentials are filled in. Vélo'v needs none
 * (GBFS is fully open), so the integration stays usable without them.
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function hasGrandLyonCredentials(config) {
  return config.grandlyon_username.length > 0 && config.grandlyon_password.length > 0;
}
