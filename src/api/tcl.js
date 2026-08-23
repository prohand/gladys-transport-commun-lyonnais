// -----------------------------------------------------------------------------
// TCL data: next departures at a stop, and park & ride (P+R) occupancy.
//
// Both come from Data Grand Lyon layers:
//   - tcl_sytral.tclpassagearret : next departures, refreshed every ~20 s from
//     the operator's real-time system (ActIV). One record = one upcoming
//     passage of one line at one stop point.
//   - tcl_sytral.tclparcrelais   : park & ride occupancy, refreshed every
//     minute. One record = one P+R facility.
//
// The park & ride layer is small (~20 facilities) and has no per-facility
// filter, so it is fetched once and cached for the duration of a poll cycle:
// watching five car parks costs one HTTP request, not five.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { fetchLayer, pickNumber, pickString } from './grandlyon.js';

const logger = createLogger({ name: 'tcl' });

export const DEPARTURES_LAYER = 'tcl_sytral.tclpassagearret';
export const PARK_AND_RIDE_LAYER = 'tcl_sytral.tclparcrelais';
export const STOPS_LAYER = 'tcl_sytral.tclarret';

// How long a whole-layer download stays reusable. Shorter than the shortest
// allowed poll frequency (30 s), so a cached record is never stale enough to
// matter, yet long enough to collapse the burst of onPoll calls Gladys fires
// for the devices sharing a frequency.
const CACHE_TTL_MS = 20_000;

/** @type {{ expiresAt: number, promise: Promise<Map<string, object>> } | null} */
let parkAndRideCache = null;

/**
 * Convert an upcoming passage into "minutes from now".
 *
 * `heurepassage` is the authoritative field (an ISO timestamp); `delaipassage`
 * is a display string the operator also sends ("3 min", "Proche"). We prefer
 * the timestamp and fall back on parsing the label.
 *
 * @param {Record<string, unknown>} record one raw passage record
 * @param {Date} [now] injectable clock, for tests
 * @returns {number | null} whole minutes, floored at 0, or null if unreadable
 */
export function minutesUntilPassage(record, now = new Date()) {
  const timestamp = pickString(record, ['heurepassage', 'heure_passage', 'expectedtime']);
  if (timestamp) {
    const passage = new Date(timestamp);
    if (!Number.isNaN(passage.getTime())) {
      return Math.max(0, Math.round((passage.getTime() - now.getTime()) / 60_000));
    }
  }

  const label = pickString(record, ['delaipassage', 'delai_passage', 'delais']);
  if (label) {
    // "Proche" / "A l'approche" / "imminent" all mean "it is arriving now".
    if (/proche|approche|imminent/i.test(label)) {
      return 0;
    }
    const match = label.match(/(\d+)/);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

/**
 * Normalize one raw passage record into the shape the device module uses.
 * @param {Record<string, unknown>} record
 * @param {Date} [now]
 * @returns {{ line: string, direction: string, minutes: number | null, realtime: boolean }}
 */
export function normalizePassage(record, now = new Date()) {
  // `type` is 'E' (estimé, i.e. real-time) or 'T' (théorique, i.e. timetable).
  const type = pickString(record, ['type', 'typepassage']) ?? '';
  return {
    line: pickString(record, ['ligne', 'ligne_id', 'idligne', 'route']) ?? '?',
    direction: pickString(record, ['direction', 'destination', 'terminus']) ?? '',
    minutes: minutesUntilPassage(record, now),
    realtime: type.toUpperCase().startsWith('E'),
  };
}

/**
 * Fetch the upcoming departures at one stop point, soonest first.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {{ id: string, lines: string[] }} stop watched stop (see config.js)
 * @param {Date} [now] injectable clock, for tests
 * @returns {Promise<{ line: string, direction: string, minutes: number | null, realtime: boolean }[]>}
 */
export async function fetchDepartures(config, stop, now = new Date()) {
  // The rdata `filter` parameter is what keeps this request cheap: without it
  // the layer returns the upcoming passages of the WHOLE network.
  const values = await fetchLayer(config, DEPARTURES_LAYER, { filter: { id: stop.id } });

  const departures = values
    .map((record) => normalizePassage(record, now))
    .filter((departure) => departure.minutes !== null);

  const filtered =
    stop.lines.length === 0
      ? departures
      : departures.filter((departure) => stop.lines.includes(departure.line.toUpperCase()));

  filtered.sort((a, b) => a.minutes - b.minutes);
  logger.debug(`Stop ${stop.id}: ${filtered.length} upcoming departure(s)`);
  return filtered;
}

/**
 * Normalize one raw park & ride record.
 * @param {Record<string, unknown>} record
 * @returns {{ id: string, name: string, capacity: number | undefined,
 *   available: number | undefined, capacityDisabled: number | undefined,
 *   availableDisabled: number | undefined }}
 */
export function normalizeParkAndRide(record) {
  return {
    id: pickString(record, ['id', 'idparcrelais', 'code', 'gid']) ?? '',
    name: pickString(record, ['nom', 'name', 'libelle']) ?? 'P+R',
    capacity: pickNumber(record, ['capacite', 'nb_tot', 'nbplacestotal', 'capacitevoiture']),
    available: pickNumber(record, ['nbplacesdispo', 'nb_dispo', 'placesdispo', 'nbdispo']),
    capacityDisabled: pickNumber(record, ['capacitepmr', 'nb_tot_pmr', 'nbplacestotalpmr']),
    availableDisabled: pickNumber(record, ['nbplacesdispopmr', 'nb_dispo_pmr', 'placesdispopmr']),
  };
}

/**
 * Fetch every park & ride facility, keyed by id (and also by lower-cased name,
 * so the user can write a readable "Gorge de Loup" in the configuration
 * instead of an opaque numeric id).
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @returns {Promise<Map<string, ReturnType<typeof normalizeParkAndRide>>>}
 */
export function fetchParkAndRideFacilities(config) {
  const now = Date.now();
  if (parkAndRideCache && parkAndRideCache.expiresAt > now) {
    return parkAndRideCache.promise;
  }

  const promise = fetchLayer(config, PARK_AND_RIDE_LAYER)
    .then((values) => {
      const byKey = new Map();
      for (const record of values) {
        const facility = normalizeParkAndRide(record);
        if (facility.id) {
          byKey.set(facility.id, facility);
        }
        byKey.set(facility.name.toLowerCase(), facility);
      }
      logger.debug(`${values.length} park & ride facilities loaded`);
      return byKey;
    })
    .catch((err) => {
      // Never cache a failure: the next poll must retry immediately.
      parkAndRideCache = null;
      throw err;
    });

  parkAndRideCache = { expiresAt: now + CACHE_TTL_MS, promise };
  return promise;
}

/**
 * Look up one facility by id or by name, case-insensitively.
 * @param {Map<string, object>} facilities
 * @param {string} idOrName
 */
export function findParkAndRide(facilities, idOrName) {
  return facilities.get(idOrName) ?? facilities.get(String(idOrName).toLowerCase());
}

/**
 * Search the stop points of the network by name, used by the `search_stops`
 * manifest action so the user can find a stop id without leaving Gladys.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string} query free text, matched case-insensitively on the stop name
 * @param {number} [limit]
 * @returns {Promise<{ id: string, name: string, lines: string }[]>}
 */
export async function searchStops(config, query, limit = 10) {
  const values = await fetchLayer(config, STOPS_LAYER);
  const needle = query.trim().toLowerCase();

  return values
    .map((record) => ({
      id: pickString(record, ['id', 'idtarret', 'code', 'gid']) ?? '',
      name: pickString(record, ['nom', 'name', 'libelle']) ?? '',
      lines: pickString(record, ['desserte', 'lignes', 'routes']) ?? '',
    }))
    .filter((stop) => stop.id && stop.name.toLowerCase().includes(needle))
    .slice(0, limit);
}

/** Drop the cached park & ride payload (used on config change and by tests). */
export function clearTclCache() {
  parkAndRideCache = null;
}
