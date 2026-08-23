// -----------------------------------------------------------------------------
// TCL data: next departures at a stop, and park & ride (P+R) occupancy.
//
// Both come from Data Grand Lyon layers:
//   - tclpassagearret : next departures, refreshed every ~20 s from the
//     operator's real-time system (ActIV). One record = one upcoming passage
//     of one line at one stop point.
//   - tclparcrelaistr : park & ride occupancy, refreshed every minute. One
//     record = one P+R facility.
//
// Each of them is declared below as a LIST of names rather than one: the
// platform versions its layers (`tcl_sytral.tclarret` became
// `tcl_sytral.tclarret_2_0_0` when the network was renumbered), splits them
// (`tcl_sytral.tclparcrelais` became a static and a real-time layer) and
// retires the previous spelling, which is exactly what a bare HTTP 404 on an
// otherwise valid account means. `fetchLayer` walks the list and keeps the name
// that answers, so a republished dataset costs a fallback rather than an
// outage.
//
// The park & ride layer is small (~20 facilities) and has no per-facility
// filter, so it is fetched once and cached for the duration of a poll cycle:
// watching five car parks costs one HTTP request, not five.
//
// The stop directory (tclarret) is the opposite: thousands of records, no way
// to search it server-side, and a network that changes twice a year. It is
// downloaded whole, with the long timeout, and kept for an hour — downloading
// it on every keystroke of the search action is what used to end in "Data
// Grand Lyon is unreachable (The operation was aborted due to timeout)".
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  BULK_TIMEOUT_MS,
  equalityParams,
  fetchLayer,
  GrandLyonError,
  pickNumber,
  pickString,
  PROBE_TIMEOUT_MS,
  resolvedLayerFor,
} from './grandlyon.js';

const logger = createLogger({ name: 'tcl' });

// Candidate names for each layer, newest first: the versioned spelling the
// platform publishes today, then the historical one, still served for some
// datasets.
export const DEPARTURES_LAYERS = ['tcl_sytral.tclpassagearret_2_0_0', 'tcl_sytral.tclpassagearret'];
// The park & ride dataset was not versioned, it was SPLIT: SYTRAL now publishes
// `tclparcrelaistr` (temps réel — the occupancy this integration wants) next to
// `tclparcrelaisst` (statique — the facilities and their capacity, no live
// count). `tclparcrelais`, the single layer that used to hold both, is gone,
// which is why an otherwise valid account reported a 404 on this dataset only.
// The static layer is kept as a last resort: capacity and opening hours with no
// live count still beat a device that cannot be read at all.
export const PARK_AND_RIDE_LAYERS = [
  'tcl_sytral.tclparcrelaistr',
  'tcl_sytral.tclparcrelais_2_0_0',
  'tcl_sytral.tclparcrelais',
  'tcl_sytral.tclparcrelaisst',
];
export const STOPS_LAYERS = [
  'tcl_sytral.tclarret_2_0_0',
  'tcl_sytral.tclarret',
  'tcl_sytral.tclpointarret_2_0_0',
  'tcl_sytral.tclpointarret',
];

// Every column the departures layer has used to name the stop a passage
// belongs to. The layer publishes more than one id per record, so this list is
// used as a set of alternatives rather than as a "first one wins" fallback.
export const STOP_ID_COLUMNS = ['id', 'idtarret', 'idarret', 'stopid', 'stop_id'];

// The three TCL datasets, as the configuration screen talks about them.
export const TCL_DATASETS = [
  {
    key: 'departures',
    label: { en: 'Next departures', fr: 'Prochains passages' },
    layers: DEPARTURES_LAYERS,
  },
  {
    key: 'stops',
    label: { en: 'Stop directory', fr: 'Annuaire des arrêts' },
    layers: STOPS_LAYERS,
  },
  {
    key: 'park_and_ride',
    label: { en: 'Park & ride', fr: 'Parcs relais' },
    layers: PARK_AND_RIDE_LAYERS,
  },
];

// How long a whole-layer download stays reusable. Shorter than the shortest
// allowed poll frequency (30 s), so a cached record is never stale enough to
// matter, yet long enough to collapse the burst of onPoll calls Gladys fires
// for the devices sharing a frequency.
const CACHE_TTL_MS = 20_000;

// The stop directory is the one dataset that is neither small nor real time:
// several thousand records with their geometry, and a network that changes a
// couple of times a year. Downloading it on every search is what made the
// search action time out, so it is downloaded once and kept for an hour.
const STOPS_CACHE_TTL_MS = 60 * 60_000;

/** @type {{ expiresAt: number, promise: Promise<Map<string, object>> } | null} */
let parkAndRideCache = null;

/** @type {{ expiresAt: number, promise: Promise<object[]> } | null} */
let stopsCache = null;

/**
 * Fold a name down to what a human means when they type it: no case, no
 * accents, no leading or trailing space. Searching "venissieux" must find
 * "Gare de Vénissieux", which a plain `includes` never does.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

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
  // Filtering server-side is what keeps this request cheap: without it the
  // layer returns the upcoming passages of the WHOLE network. The integration
  // used to send a JSON `filter` parameter, which the web service does not
  // implement and therefore ignored — every poll downloaded the whole network
  // and the stop was picked out of it by luck. `equalityParams` sends the two
  // spellings the service does document.
  const values = await fetchLayer(config, DEPARTURES_LAYERS, {
    params: equalityParams('id', stop.id),
  });

  const departures = values
    // A service that ignored the filter would otherwise answer about every
    // stop of the network, so the stop is checked here too: a record with no
    // readable stop id can only come from a filtered answer, and is kept.
    .filter((record) => belongsToStop(record, stop.id))
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
 * Whether a raw passage record concerns one given stop.
 * @param {Record<string, unknown>} record
 * @param {string} stopId
 * @returns {boolean}
 */
export function belongsToStop(record, stopId) {
  // Every spelling is compared, not just the first one that is present: the
  // departures layer carries BOTH a passage id and a stop id, and which column
  // holds which has moved across revisions. Reading only `id` therefore
  // discarded every departure of a stop whose records name it `idtarret` — the
  // device existed, polled without error, and stayed empty forever.
  const recorded = STOP_ID_COLUMNS.map((column) => pickString(record, [column])).filter(
    (value) => value !== undefined,
  );
  return recorded.length === 0 || recorded.includes(String(stopId));
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
    // `nb_tot_place_dispo` is what the real-time layer publishes today; the
    // other spellings are the ones the retired layers used.
    available: pickNumber(record, [
      'nb_tot_place_dispo',
      'nbplacesdispo',
      'nb_dispo',
      'placesdispo',
      'nbdispo',
    ]),
    capacityDisabled: pickNumber(record, [
      'place_handi',
      'capacitepmr',
      'nb_tot_pmr',
      'nbplacestotalpmr',
    ]),
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

  const promise = fetchLayer(config, PARK_AND_RIDE_LAYERS)
    .then((values) => {
      const byKey = new Map();
      for (const record of values) {
        const facility = normalizeParkAndRide(record);
        if (facility.id) {
          byKey.set(facility.id, facility);
          // The ids of this layer are upper-case codes ("SOI", "BON"): a user
          // who typed one in lower case means the same car park.
          byKey.set(facility.id.toLowerCase(), facility);
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
 * Normalize one raw stop record into what the search action displays.
 * @param {Record<string, unknown>} record
 * @returns {{ id: string, name: string, lines: string }}
 */
export function normalizeStop(record) {
  return {
    id: pickString(record, ['id', 'idtarret', 'idarret', 'code', 'gid']) ?? '',
    name: pickString(record, ['nom', 'name', 'libelle']) ?? '',
    lines: pickString(record, ['desserte', 'lignes', 'routes']) ?? '',
  };
}

/**
 * The whole stop directory, downloaded once and kept for an hour.
 *
 * This is the expensive read of the integration — the layer has no per-name
 * filter, so a substring search has to look at every stop — and it is also the
 * one that never changes between two network revisions. Caching it turns the
 * second search of a configuration session into a local array scan, and the
 * longer timeout is what makes the first one succeed at all on a slow line.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @returns {Promise<Record<string, unknown>[]>}
 */
export function fetchStops(config) {
  const now = Date.now();
  if (stopsCache && stopsCache.expiresAt > now) {
    return stopsCache.promise;
  }

  const promise = fetchLayer(config, STOPS_LAYERS, { timeoutMs: BULK_TIMEOUT_MS })
    .then((values) => {
      logger.debug(`${values.length} stop(s) loaded`);
      return values;
    })
    .catch((err) => {
      // Never cache a failure: a timeout must be retryable straight away.
      stopsCache = null;
      throw err;
    });

  stopsCache = { expiresAt: now + STOPS_CACHE_TTL_MS, promise };
  return promise;
}

/**
 * Search the stop points of the network by name, used by the `search_stops`
 * manifest action so the user can find a stop id without leaving Gladys.
 *
 * Two reads, cheapest first: the exact name the user typed is asked of the
 * platform directly (a filtered request, a few records, instantaneous), and
 * only a search that finds nothing that way falls back on the full directory.
 * Typing "Bellecour" therefore never waits for a several-megabyte download,
 * and typing "belle" waits for it once per hour at most.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string} query free text, matched case- and accent-insensitively on
 *   the stop name
 * @param {number} [limit]
 * @returns {Promise<{ id: string, name: string, lines: string }[]>}
 */
export async function searchStops(config, query, limit = 10) {
  const needle = normalizeText(query);
  if (needle.length === 0) {
    return [];
  }

  const exact = await searchStopsByExactName(config, query, limit);
  if (exact.length > 0) {
    return exact;
  }

  const values = await fetchStops(config);
  return values
    .map(normalizeStop)
    .filter((stop) => stop.id && normalizeText(stop.name).includes(needle))
    .slice(0, limit);
}

/**
 * The stops whose name is exactly what the user typed, asked of the platform.
 *
 * The answer is re-checked locally because the web service is free to ignore
 * a filter it does not implement on a given layer, in which case it answers
 * with an arbitrary page of the directory instead of an error — records that
 * would otherwise be presented as matches. A read that fails here is not
 * fatal: the caller still has the full directory to fall back on.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<{ id: string, name: string, lines: string }[]>}
 */
async function searchStopsByExactName(config, query, limit) {
  const needle = normalizeText(query);
  let values;
  try {
    values = await fetchLayer(config, STOPS_LAYERS, {
      params: equalityParams('nom', query.trim()),
      maxFeatures: 50,
    });
  } catch (err) {
    logger.debug(`Exact-name lookup of "${query}" failed, falling back: ${err.message}`);
    return [];
  }

  return values
    .map(normalizeStop)
    .filter((stop) => stop.id && normalizeText(stop.name) === needle)
    .slice(0, limit);
}

/**
 * Probe the TCL datasets this integration reads, one small request each.
 *
 * The configuration screen used to test the account by listing the park &
 * ride facilities, which reports a retired dataset as a total failure — the
 * user is told to go hunting for a dataset name while their account, their
 * departures and their stop searches are all perfectly fine. Probing each
 * dataset separately says which part works, and a refused account still
 * surfaces as such because that error is the one worth propagating.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @returns {Promise<{ key: string, label: { en: string, fr: string }, ok: boolean,
 *   layer: string | undefined, error: Error | undefined }[]>}
 */
export function checkDatasets(config) {
  return Promise.all(
    TCL_DATASETS.map(async (dataset) => {
      try {
        await fetchLayer(config, dataset.layers, {
          maxFeatures: 1,
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        return {
          ...dataset,
          ok: true,
          layer: resolvedLayerFor(config, dataset.layers)?.layer,
          error: undefined,
        };
      } catch (err) {
        // A refused account is not a property of one dataset: it makes every
        // probe fail, and the user must read about the password rather than
        // about three missing datasets.
        if (err instanceof GrandLyonError && (err.status === 401 || err.status === 403)) {
          throw err;
        }
        return { ...dataset, ok: false, layer: undefined, error: err };
      }
    }),
  );
}

/** Drop the cached TCL payloads (used on config change and by tests). */
export function clearTclCache() {
  parkAndRideCache = null;
  stopsCache = null;
}
