// -----------------------------------------------------------------------------
// Vélo'v data, through GBFS (General Bikeshare Feed Specification).
//
// The Métropole de Lyon and JCDecaux publish the Vélo'v network as a standard
// GBFS feed, refreshed every minute and open to everyone (no account, no key):
//
//   gbfs.json               -> the feed index (which files exist, and where)
//   station_information.json -> static data: id, name, capacity, position
//   station_status.json      -> real-time data: bikes and docks available
//
// Two GBFS versions are in the wild (v2 and v3) and they differ on details:
// the index nests feeds under a language key in v2 but not in v3, and a
// station name is a plain string in v2 and an array of localized strings in
// v3. Everything below reads both, so switching `velov_gbfs_url` between the
// two published versions does not break the integration.
//
// Both files are fetched once per cycle and cached: watching ten stations
// costs two HTTP requests, not twenty.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'velov' });

const REQUEST_TIMEOUT_MS = 15_000;

// Real-time availability is recomputed upstream every minute; static station
// information changes a few times a year.
const STATUS_TTL_MS = 20_000;
const INFORMATION_TTL_MS = 3_600_000;

/** @type {{ url: string, expiresAt: number, promise: Promise<Map<string, object>> } | null} */
let informationCache = null;
/** @type {{ url: string, expiresAt: number, promise: Promise<Map<string, object>> } | null} */
let statusCache = null;
/** @type {{ url: string, expiresAt: number, promise: Promise<Record<string, string>> } | null} */
let indexCache = null;

/**
 * GET a JSON document, with a timeout and a readable error.
 * @param {string} url
 * @returns {Promise<Record<string, unknown>>}
 */
async function getJson(url) {
  logger.debug(`GET ${url}`);
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Vélo'v feed is unreachable (${err.message})`, { cause: err });
  }
  if (!response.ok) {
    throw new Error(`Vélo'v feed answered HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Read a GBFS name field: a plain string in v2, an array of
 * `{ text, language }` in v3.
 * @param {unknown} value
 * @returns {string}
 */
export function readGbfsName(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    // Prefer French, then English, then whatever came first.
    const preferred =
      value.find((entry) => entry?.language === 'fr') ??
      value.find((entry) => entry?.language === 'en') ??
      value[0];
    return String(preferred?.text ?? '');
  }
  return '';
}

/**
 * Resolve the feed index into a `{ feedName: url }` map.
 * @param {string} gbfsUrl
 * @returns {Promise<Record<string, string>>}
 */
async function fetchFeedIndex(gbfsUrl) {
  const now = Date.now();
  if (indexCache && indexCache.url === gbfsUrl && indexCache.expiresAt > now) {
    return indexCache.promise;
  }

  const promise = getJson(gbfsUrl)
    .then((body) => {
      const data = body?.data ?? {};
      // v3: { data: { feeds: [...] } } — v2: { data: { fr: { feeds: [...] } } }
      const feeds = Array.isArray(data.feeds)
        ? data.feeds
        : (Object.values(data).find((entry) => Array.isArray(entry?.feeds))?.feeds ?? []);

      const byName = {};
      for (const feed of feeds) {
        if (feed?.name && feed?.url) {
          byName[String(feed.name).replace(/\.json$/, '')] = String(feed.url);
        }
      }
      return byName;
    })
    .catch((err) => {
      indexCache = null;
      throw err;
    });

  indexCache = { url: gbfsUrl, expiresAt: now + INFORMATION_TTL_MS, promise };
  return promise;
}

/**
 * Resolve the URL of one GBFS file, falling back to the conventional path next
 * to `gbfs.json` when the index does not advertise it.
 * @param {string} gbfsUrl
 * @param {string} feedName e.g. 'station_status'
 * @returns {Promise<string>}
 */
async function resolveFeedUrl(gbfsUrl, feedName) {
  const index = await fetchFeedIndex(gbfsUrl).catch(() => ({}));
  if (index[feedName]) {
    return index[feedName];
  }
  return new URL(`${feedName}.json`, gbfsUrl).toString();
}

/**
 * Normalize one `station_information` record.
 * @param {Record<string, unknown>} record
 */
export function normalizeStationInformation(record) {
  return {
    id: String(record.station_id ?? ''),
    name: readGbfsName(record.name),
    capacity: Number.isFinite(Number(record.capacity)) ? Number(record.capacity) : undefined,
    latitude: Number(record.lat),
    longitude: Number(record.lon),
  };
}

/**
 * Normalize one `station_status` record.
 *
 * v2 exposes `num_bikes_available`; v3 renamed it `num_vehicles_available` and
 * details the fleet in `vehicle_types_available`. Electric bikes are reported
 * under the `ebike`/`electric` vehicle type id depending on the operator, so
 * they are matched loosely.
 *
 * @param {Record<string, unknown>} record
 */
export function normalizeStationStatus(record) {
  const vehicleTypes = Array.isArray(record.vehicle_types_available)
    ? record.vehicle_types_available
    : [];

  let electric;
  for (const entry of vehicleTypes) {
    if (/e-?bike|electric|assist/i.test(String(entry?.vehicle_type_id ?? ''))) {
      electric = (electric ?? 0) + (Number(entry?.count) || 0);
    }
  }

  const bikes = Number(record.num_bikes_available ?? record.num_vehicles_available);
  const docks = Number(record.num_docks_available);

  return {
    id: String(record.station_id ?? ''),
    bikes: Number.isFinite(bikes) ? bikes : undefined,
    electricBikes: electric,
    docks: Number.isFinite(docks) ? docks : undefined,
    // GBFS omits the flags when everything is nominal, hence the `!== false`.
    renting: record.is_renting !== false && record.is_renting !== 0,
    returning: record.is_returning !== false && record.is_returning !== 0,
    installed: record.is_installed !== false && record.is_installed !== 0,
  };
}

/**
 * Build a lookup map from a GBFS station file, keyed by station id AND by
 * lower-cased station name (so the configuration accepts "Hotel de Ville" as
 * well as an opaque numeric id).
 * @param {string} url
 * @param {(record: Record<string, unknown>) => { id: string, name?: string }} normalize
 */
async function fetchStationMap(url, normalize) {
  const body = await getJson(url);
  const stations = body?.data?.stations ?? [];
  const byKey = new Map();
  for (const record of stations) {
    const station = normalize(record);
    if (station.id) {
      byKey.set(station.id, station);
    }
    if (station.name) {
      byKey.set(station.name.toLowerCase(), station);
    }
  }
  return byKey;
}

/**
 * Static information of every Vélo'v station, keyed by id and by name.
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function fetchStationInformation(config) {
  const now = Date.now();
  const url = config.velov_gbfs_url;
  if (informationCache && informationCache.url === url && informationCache.expiresAt > now) {
    return informationCache.promise;
  }

  const promise = resolveFeedUrl(url, 'station_information')
    .then((feedUrl) => fetchStationMap(feedUrl, normalizeStationInformation))
    .catch((err) => {
      informationCache = null;
      throw err;
    });

  informationCache = { url, expiresAt: now + INFORMATION_TTL_MS, promise };
  return promise;
}

/**
 * Real-time status of every Vélo'v station, keyed by id.
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function fetchStationStatus(config) {
  const now = Date.now();
  const url = config.velov_gbfs_url;
  if (statusCache && statusCache.url === url && statusCache.expiresAt > now) {
    return statusCache.promise;
  }

  const promise = resolveFeedUrl(url, 'station_status')
    .then((feedUrl) => fetchStationMap(feedUrl, normalizeStationStatus))
    .catch((err) => {
      statusCache = null;
      throw err;
    });

  statusCache = { url, expiresAt: now + STATUS_TTL_MS, promise };
  return promise;
}

/**
 * Availability of one station: its static information merged with its live
 * counters.
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string} idOrName station id, or station name
 */
export async function fetchStationAvailability(config, idOrName) {
  const [information, status] = await Promise.all([
    fetchStationInformation(config),
    fetchStationStatus(config),
  ]);

  const key = String(idOrName).toLowerCase();
  const info = information.get(idOrName) ?? information.get(key);
  const live = status.get(idOrName) ?? status.get(key) ?? (info ? status.get(info.id) : undefined);

  if (!live) {
    return null;
  }
  return { ...info, ...live, capacity: info?.capacity, name: info?.name ?? String(idOrName) };
}

/**
 * Search Vélo'v stations by name, used by the `search_velov_stations` action.
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string} query
 * @param {number} [limit]
 */
export async function searchStations(config, query, limit = 10) {
  const information = await fetchStationInformation(config);
  const needle = query.trim().toLowerCase();

  const seen = new Set();
  const results = [];
  for (const station of information.values()) {
    if (seen.has(station.id) || !station.name.toLowerCase().includes(needle)) {
      continue;
    }
    seen.add(station.id);
    results.push(station);
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

/** Drop every cached GBFS payload (used on config change and by tests). */
export function clearVelovCache() {
  informationCache = null;
  statusCache = null;
  indexCache = null;
}
