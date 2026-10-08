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
// The park & ride layers are small (22 facilities) and have no per-facility
// filter, so they are fetched once and cached for the duration of a poll
// cycle: watching five car parks costs two HTTP requests, not ten.
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
// The park & ride dataset was not versioned, it was SPLIT: SYTRAL publishes
// `tclparcrelaistr` (temps réel — the occupancy) next to `tclparcrelaisst`
// (statique — every facility, its capacity and its opening hours, no live
// count). `tclparcrelais`, the single layer that used to hold both, is gone,
// which is why an otherwise valid account reported a 404 on this dataset only.
//
// The two are read TOGETHER rather than one as a fallback for the other, and
// that is the fix for "the park & ride list is incomplete": the real-time
// layer only carries the facilities SYTRAL counts live, so listing it alone
// silently hides the others — a user looking for a car park that exists, is
// signposted P+R and is in the open data, simply could not find it. The static
// layer is the inventory (22 facilities today), the real-time one adds the
// free spaces where they are published.
export const PARK_AND_RIDE_REALTIME_LAYERS = [
  'tcl_sytral.tclparcrelaistr',
  'tcl_sytral.tclparcrelais_2_0_0',
  'tcl_sytral.tclparcrelais',
];
export const PARK_AND_RIDE_STATIC_LAYERS = ['tcl_sytral.tclparcrelaisst'];
// Both, for the dataset probe of the configuration screen: the account can
// read the family as soon as one of the two answers.
export const PARK_AND_RIDE_LAYERS = [
  ...PARK_AND_RIDE_REALTIME_LAYERS,
  ...PARK_AND_RIDE_STATIC_LAYERS,
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

/** @type {{ expiresAt: number, promise: Promise<object[]> } | null} */
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
 * Fold a facility name down to what it identifies: `normalizeText`, plus the
 * punctuation the two layers do not spell the same way. "Vaulx-en-Velin La
 * Soie" and "Vaulx en Velin la Soie" are the same car park, and a user typing
 * the second one must not be told their facility is not in the dataset.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function foldName(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// The network's own time zone: a passage time written without an offset is a
// wall-clock time in Lyon, whatever the time zone of the container reading it.
const NETWORK_TIME_ZONE = 'Europe/Paris';

// `2026-10-08 14:05:00`, `2026-10-08T14:05`, `2026-10-08T14:05:00.000+02:00`,
// `...Z`: a date, a time, and an optional offset. Anything else is left to
// `Date` as before.
const PASSAGE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3})\d*)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

const networkClock = new Intl.DateTimeFormat('en-US', {
  timeZone: NETWORK_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * How far ahead of UTC Lyon is at one instant, in milliseconds.
 * @param {number} instant
 * @returns {number}
 */
function networkOffsetMs(instant) {
  const parts = Object.fromEntries(
    networkClock.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  const wallClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wallClock - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * Read a passage time as an instant.
 *
 * The departures layer declares `heurepassage` as a `timestamp` WITHOUT a time
 * zone: the value is Lyon's wall clock. `new Date('2026-10-08 14:05:00')`
 * reads such a string in the time zone of the process, and the container runs
 * in UTC — every countdown was then two hours too long in summer, one in
 * winter, and a tram due in 5 minutes read "125 min". A string that carries
 * its own offset (`Z`, `+02:00`) is read as it says; one that does not is read
 * in Europe/Paris, through `Intl` (no date library).
 *
 * Lyon is UTC+1 or UTC+2, so a wall-clock time is one of two instants. Around
 * the autumn change both are real (02:30 happens twice): the one nearest to
 * `now` wins, since an upcoming departure is never an hour away from its own
 * board. In the spring gap neither is (02:30 never happens): the time is read
 * in winter time, i.e. 03:30 summer time, the clock a timetable would follow.
 *
 * @param {string} value
 * @param {Date} [now] tie-breaker for the ambiguous autumn hour
 * @returns {Date | null}
 */
export function parsePassageTime(value, now = new Date()) {
  const text = String(value).trim();
  const match = text.match(PASSAGE_TIME);
  if (!match) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const [, year, month, day, hour, minute, second = '0', fraction = '0', offset] = match;
  const wallClock = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, '0')),
  );
  if (Number.isNaN(wallClock)) {
    return null;
  }

  if (offset) {
    if (offset.toUpperCase() === 'Z') {
      return new Date(wallClock);
    }
    const sign = offset.startsWith('-') ? -1 : 1;
    const digits = offset.slice(1).replace(':', '');
    const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0);
    return new Date(wallClock - sign * minutes * 60_000);
  }

  const candidates = [60, 120]
    .map((minutes) => wallClock - minutes * 60_000)
    .filter((instant) => instant + networkOffsetMs(instant) === wallClock);
  if (candidates.length === 0) {
    return new Date(wallClock - 60 * 60_000);
  }
  candidates.sort((a, b) => Math.abs(a - now.getTime()) - Math.abs(b - now.getTime()) || a - b);
  return new Date(candidates[0]);
}

/**
 * Convert an upcoming passage into "minutes from now".
 *
 * `heurepassage` is the authoritative field (a timestamp, Lyon's wall clock
 * unless it says otherwise: see `parsePassageTime`); `delaipassage` is a
 * display string the operator also sends ("3 min", "Proche"). We prefer the
 * timestamp and fall back on parsing the label.
 *
 * @param {Record<string, unknown>} record one raw passage record
 * @param {Date} [now] injectable clock, for tests
 * @returns {number | null} whole minutes, floored at 0, or null if unreadable
 */
export function minutesUntilPassage(record, now = new Date()) {
  const timestamp = pickString(record, ['heurepassage', 'heure_passage', 'expectedtime']);
  if (timestamp) {
    const passage = parsePassageTime(timestamp, now);
    if (passage) {
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

// The most records a filtered departures read may bring back. One stop point
// has a few dozen upcoming passages at the busiest hour; the cap only matters
// the day the service ignores the filter again, when it is the difference
// between a page of the board and the whole network (~24,000 records) every
// 30 seconds.
export const DEPARTURES_MAX_FEATURES = 200;

/** Stops whose ignored filter has already been reported, so it is said once. */
const ignoredFilterReported = new Set();

/**
 * Say it when a filtered departures read answers about other stops.
 *
 * The records are re-checked anyway, so the board stays right; what goes
 * wrong is the cost — a service that drops the filter hands back a page of
 * the whole network instead of one stop, and the stop's own passages may not
 * even be on that page. That is a regression of the platform worth reporting,
 * not something to absorb in silence.
 *
 * @param {string} stopId
 * @param {number} received records the service sent
 * @param {number} kept records that belong to the stop
 */
function warnAboutIgnoredFilter(stopId, received, kept) {
  if (kept === received || ignoredFilterReported.has(stopId)) {
    return;
  }
  ignoredFilterReported.add(stopId);
  logger.warn(
    `Stop ${stopId}: the departures service answered ${received} record(s), ` +
      `${received - kept} of them about other stops — it seems to ignore the stop filter ` +
      `(the read is capped at ${DEPARTURES_MAX_FEATURES} records), please report it`,
  );
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
    maxFeatures: DEPARTURES_MAX_FEATURES,
  });

  // A service that ignored the filter would otherwise answer about every
  // stop of the network, so the stop is checked here too: a record with no
  // readable stop id can only come from a filtered answer, and is kept.
  const ours = values.filter((record) => belongsToStop(record, stop.id));
  warnAboutIgnoredFilter(stop.id, values.length, ours.length);

  const departures = ours
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

// The name a facility gets when its record carries none. It is a placeholder,
// not data: `mergeParkAndRide` must never let it overwrite the real name the
// other layer published.
const UNNAMED_FACILITY = 'P+R';

/**
 * A column name, folded down to what it says: no case, no accent, no
 * separator. `nb_tot_place_dispo`, `nbPlacesDispo` and `nb places dispo` all
 * become the same string, which is what makes the hints below readable.
 *
 * @param {string} column
 * @returns {string}
 */
function normalizeColumn(column) {
  return normalizeText(column).replace(/[^a-z0-9]/g, '');
}

const saysFree = (column) => /dispo|libre|free|available/.test(column);
const saysAccessible = (column) => /pmr|handi|accessible/.test(column);
const saysCapacity = (column) => /capacit|nbtot|nbplace|nbpl|total|places/.test(column);
// A park & ride publishes more than car spaces: the bicycle shelter and the
// motorbike bays are counted in their own columns, and they must never be read
// as the free spaces of the car park.
const saysOtherVehicle = (column) => /velo|cycle|moto|bus|covoit/.test(column);

// What each value looks like when the column NAME is all there is to go on.
// The columns of this dataset have already moved once under the integration's
// feet — the split renamed `nbplacesdispo` into `nb_tot_place_dispo` — and a
// count published under a spelling nobody listed is not an error anybody can
// raise: it is a device that stays empty forever, silently. So every value is
// read twice, through the spellings we know and then through what the column
// name says it holds.
const COLUMN_HINTS = [
  {
    field: 'available',
    matches: (column) => saysFree(column) && !saysAccessible(column) && !saysOtherVehicle(column),
  },
  { field: 'availableDisabled', matches: (column) => saysFree(column) && saysAccessible(column) },
  {
    field: 'capacity',
    matches: (column) =>
      saysCapacity(column) &&
      !saysFree(column) &&
      !saysAccessible(column) &&
      !saysOtherVehicle(column),
  },
  {
    field: 'capacityDisabled',
    matches: (column) => saysCapacity(column) && saysAccessible(column) && !saysFree(column),
  },
];

/**
 * The counts of a record, read from the names of its columns.
 *
 * Only used as a fallback, after the known spellings: the first column whose
 * name reads as a given value wins, so a layer that publishes both the
 * spelling we know and another one is unaffected.
 *
 * @param {Record<string, unknown>} record
 * @returns {{ capacity?: number, available?: number, capacityDisabled?: number,
 *   availableDisabled?: number }}
 */
export function readCountsByColumnName(record) {
  const found = {};
  for (const [column, value] of Object.entries(record ?? {})) {
    const number = Number(value);
    if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(number)) {
      continue;
    }
    const name = normalizeColumn(column);
    for (const hint of COLUMN_HINTS) {
      if (found[hint.field] === undefined && hint.matches(name)) {
        found[hint.field] = number;
      }
    }
  }
  return found;
}

/**
 * A count as this integration is willing to publish it.
 *
 * A negative value is the platform saying "unknown", not a car park owing
 * spaces to the network: it is dropped rather than published, because Gladys
 * stores what it is given and a gauge declared from 0 has nowhere to put -1.
 *
 * @param {number | undefined} value
 * @returns {number | undefined}
 */
function usableCount(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The columns of one record, as `name=value`, for a message a user can act on.
 *
 * A facility with no readable count is a bug report waiting to be written, and
 * "no live count" alone does not say whether the column was renamed again or
 * whether the platform published -1 (its way of saying "unknown"). The values
 * are what tells the two apart, so they are carried along with the names —
 * the long ones (an opening-hours sentence, a geometry) are dropped, they say
 * nothing about a count.
 *
 * @param {Record<string, unknown>} record
 * @returns {string[]}
 */
function describeColumns(record) {
  return Object.entries(record ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([column, value]) => `${column}=${String(value)}`)
    .filter((entry) => entry.length <= 60);
}

/**
 * Normalize one raw park & ride record.
 *
 * `live` says which of the two layers the record comes from, and it is not
 * decoration: a facility with no free-space count is either absent from the
 * real-time layer — the platform counts nothing there, and there is nothing to
 * fix — or present in it with a count nobody could read, which is a column
 * rename to report. Both look exactly the same on the device, so the answer
 * has to be carried from here.
 *
 * @param {Record<string, unknown>} record
 * @param {{ live?: boolean }} [origin]
 * @returns {{ id: string, name: string, capacity: number | undefined,
 *   available: number | undefined, capacityDisabled: number | undefined,
 *   availableDisabled: number | undefined, live: boolean,
 *   liveColumns: string[] | undefined }}
 */
export function normalizeParkAndRide(record, { live = false } = {}) {
  // Fallback for every count the known spellings miss: see COLUMN_HINTS.
  const byName = readCountsByColumnName(record);
  return {
    live,
    // Only the real-time record is worth describing: the inventory has no
    // count to look for in the first place.
    liveColumns: live ? describeColumns(record) : undefined,
    id: pickString(record, ['id', 'idparcrelais', 'code', 'gid']) ?? '',
    name: pickString(record, ['nom', 'name', 'libelle']) ?? UNNAMED_FACILITY,
    capacity: usableCount(
      pickNumber(record, ['capacite', 'nb_tot', 'nbplacestotal', 'capacitevoiture']) ??
        byName.capacity,
    ),
    // `nb_tot_place_dispo` is what the real-time layer publishes today; the
    // other spellings are the ones the retired layers used.
    available: usableCount(
      pickNumber(record, [
        'nb_tot_place_dispo',
        'nbplacesdispo',
        'nb_dispo',
        'placesdispo',
        'nbdispo',
      ]) ?? byName.available,
    ),
    capacityDisabled: usableCount(
      pickNumber(record, ['place_handi', 'capacitepmr', 'nb_tot_pmr', 'nbplacestotalpmr']) ??
        byName.capacityDisabled,
    ),
    availableDisabled: usableCount(
      pickNumber(record, ['nbplacesdispopmr', 'nb_dispo_pmr', 'placesdispopmr']) ??
        byName.availableDisabled,
    ),
  };
}

/**
 * Merge a facility read from one layer into what another layer already said
 * about it: a column the second record publishes wins, a column it omits keeps
 * the value of the first — so the inventory of the static layer and the live
 * count of the real-time one end up on the same object.
 *
 * @param {ReturnType<typeof normalizeParkAndRide> | undefined} base
 * @param {ReturnType<typeof normalizeParkAndRide>} update
 * @returns {ReturnType<typeof normalizeParkAndRide>}
 */
export function mergeParkAndRide(base, update) {
  if (!base) {
    return update;
  }
  const merged = { ...base };
  for (const [field, value] of Object.entries(update)) {
    // `live` is a fact about the layers a facility was seen in, so it is a
    // logical or, never an overwrite: the static record of a counted facility
    // must not un-count it.
    if (field === 'live') {
      merged.live = base.live || value;
      continue;
    }
    // `undefined` is "this layer does not publish that column", never "the
    // value is unknown now": it must not erase what the other layer knows.
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (field === 'name' && value === UNNAMED_FACILITY) {
      continue;
    }
    merged[field] = value;
  }
  return merged;
}

/**
 * Every park & ride facility of the network, sorted by name.
 *
 * Both layers are read, and a failure of one of them is survivable: with the
 * real-time layer alone the list is short (only the counted facilities), with
 * the static one alone every facility is listed without its free spaces. Only
 * a double failure is an error — and the one reported is the real-time one,
 * because that is the read the devices depend on.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @returns {Promise<ReturnType<typeof normalizeParkAndRide>[]>}
 */
async function loadParkAndRideFacilities(config) {
  const [realtime, statique] = await Promise.allSettled([
    fetchLayer(config, PARK_AND_RIDE_REALTIME_LAYERS),
    fetchLayer(config, PARK_AND_RIDE_STATIC_LAYERS),
  ]);

  if (realtime.status === 'rejected' && statique.status === 'rejected') {
    throw realtime.reason;
  }
  if (realtime.status === 'rejected') {
    logger.warn(
      `Park & ride occupancy is unreadable (${realtime.reason.message}); ` +
        'listing the facilities without their free spaces',
    );
  }
  if (statique.status === 'rejected') {
    logger.warn(
      `The park & ride inventory is unreadable (${statique.reason.message}); ` +
        'only the facilities counted in real time are listed',
    );
  }

  // Static first, real-time second: the live count is the value that must win
  // when both layers publish a column.
  const byId = new Map();
  for (const [result, origin] of [
    [statique, { live: false }],
    [realtime, { live: true }],
  ]) {
    if (result.status !== 'fulfilled') {
      continue;
    }
    for (const record of result.value) {
      const facility = normalizeParkAndRide(record, origin);
      // A record without an id cannot be watched (the configuration names a
      // facility by its id or its name) nor merged: skipping it is what keeps
      // the anonymous rows of a partially published layer out of the list.
      const key = facility.id ? facility.id.toUpperCase() : normalizeText(facility.name);
      if (key.length === 0) {
        continue;
      }
      byId.set(key, mergeParkAndRide(byId.get(key), facility));
    }
  }

  let facilities = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (realtime.status === 'rejected') {
    // A layer nobody could read says nothing about the facilities it holds:
    // "not counted in real time" would be a diagnosis made out of an outage.
    facilities = facilities.map((facility) => ({ ...facility, live: undefined }));
  }
  logger.debug(`${facilities.length} park & ride facilities loaded`);
  warnAboutUnreadableCounts(realtime);
  return facilities;
}

/**
 * Say it out loud when the real-time layer answers with records nothing in
 * them can be read as a free-space count.
 *
 * That is the failure with no error attached: the request succeeds, the
 * facilities are listed, and every watched car park publishes nothing at all
 * because the column holding the count has been renamed once more. The columns
 * the layer did send are the only thing that makes the next report actionable,
 * so they are named here rather than left for somebody to guess.
 *
 * @param {PromiseSettledResult<Record<string, unknown>[]>} realtime
 */
function warnAboutUnreadableCounts(realtime) {
  if (realtime.status !== 'fulfilled' || realtime.value.length === 0) {
    return;
  }
  const counted = realtime.value.filter((record) =>
    Number.isFinite(normalizeParkAndRide(record).available),
  );
  if (counted.length > 0) {
    return;
  }
  const columns = [...new Set(realtime.value.flatMap((record) => Object.keys(record)))];
  logger.warn(
    `The park & ride real-time layer answered with ${realtime.value.length} record(s) and no ` +
      `readable free-space count: its columns are ${columns.join(', ')} — please report it`,
  );
}

/**
 * The park & ride facilities, sorted by name, cached for the duration of a
 * poll cycle (watching five car parks costs two HTTP requests, not ten).
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @returns {Promise<ReturnType<typeof normalizeParkAndRide>[]>}
 */
export function listParkAndRideFacilities(config) {
  const now = Date.now();
  if (parkAndRideCache && parkAndRideCache.expiresAt > now) {
    return parkAndRideCache.promise;
  }

  const promise = loadParkAndRideFacilities(config).catch((err) => {
    // Never cache a failure: the next poll must retry immediately. Only THIS
    // read is dropped, though: a slow read that fails after the cache expired
    // and a newer one took its place must not throw the newer one away.
    if (parkAndRideCache?.promise === promise) {
      parkAndRideCache = null;
    }
    throw err;
  });

  parkAndRideCache = { expiresAt: now + CACHE_TTL_MS, promise };
  return promise;
}

/**
 * The same facilities, keyed by id (and also by lower-cased id and name, so
 * the user can write a readable "Gorge de Loup" in the configuration instead
 * of an opaque code).
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @returns {Promise<Map<string, ReturnType<typeof normalizeParkAndRide>>>}
 */
export async function fetchParkAndRideFacilities(config) {
  const byKey = new Map();
  for (const facility of await listParkAndRideFacilities(config)) {
    if (facility.id) {
      byKey.set(facility.id, facility);
      // The ids of this layer are upper-case codes ("SOI", "BON"): a user who
      // typed one in lower case means the same car park.
      byKey.set(facility.id.toLowerCase(), facility);
    }
    // The name is indexed folded (no case, no accent, no punctuation): a user
    // who typed "Vaulx en Velin la Soie" means the facility the layer spells
    // "Vaulx-en-Velin La Soie", and answering "not in the dataset" over a
    // hyphen is a device that never publishes anything.
    byKey.set(foldName(facility.name), facility);
  }
  return byKey;
}

/**
 * Look up one facility by id or by name, case-insensitively.
 * @param {Map<string, object>} facilities
 * @param {string} idOrName
 */
export function findParkAndRide(facilities, idOrName) {
  return (
    facilities.get(idOrName) ??
    facilities.get(String(idOrName).toLowerCase()) ??
    facilities.get(foldName(idOrName))
  );
}

/**
 * Normalize one raw stop record into what the search action displays.
 *
 * `direction` is the one the DIRECTORY itself publishes, and most of the time
 * there is none: `tclarret` describes a stop as a place, both directions
 * lumped together, and only the per-stop-point layers (`tclpointarret`, the
 * fallback of STOPS_LAYERS) name a direction of travel. It is read through
 * `pick` like every other column so that a layer which does publish it is not
 * ignored; the answer that always works comes from the departures instead, see
 * `fetchStopDirections`.
 *
 * @param {Record<string, unknown>} record
 * @returns {{ id: string, name: string, lines: string, direction: string }}
 */
export function normalizeStop(record) {
  return {
    id: pickString(record, ['id', 'idtarret', 'idarret', 'code', 'gid']) ?? '',
    name: pickString(record, ['nom', 'name', 'libelle']) ?? '',
    lines: pickString(record, ['desserte', 'lignes', 'routes']) ?? '',
    direction: pickString(record, ['sens', 'direction', 'destination', 'terminus']) ?? '',
  };
}

/**
 * The lines calling at one stop and where they are headed, read from the
 * departures layer.
 *
 * This is the missing half of a stop search: the directory answers with an id
 * and a name, and a name is exactly what does not tell two stops apart — the
 * network numbers each direction of a route separately, so "Bellecour" comes
 * back several times and nothing on the line says which of them is the
 * platform towards Part-Dieu. The departures do say it: every passage carries
 * its terminus, which is also what is written on the pole and on the front of
 * the tram.
 *
 * It is read per stop and filtered server-side, so it costs one small request
 * per result rather than a download of anything. What it cannot do is invent a
 * direction where no vehicle is expected: a stop searched at three in the
 * morning has an empty board, and the caller falls back on the lines the
 * directory advertises.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string} stopId
 * @returns {Promise<{ line: string, direction: string }[]>} unique pairs, by line
 */
export async function fetchStopDirections(config, stopId) {
  const values = await fetchLayer(config, DEPARTURES_LAYERS, {
    params: equalityParams('id', stopId),
    maxFeatures: DEPARTURES_MAX_FEATURES,
    // The short budget on purpose: this is the bonus on top of a search that
    // has already spent up to a minute downloading the directory, and the
    // action has ninety seconds in total before Gladys gives up on it. A
    // direction that takes too long is dropped, the id is not.
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  const byKey = new Map();
  for (const record of values) {
    if (!belongsToStop(record, stopId)) {
      continue;
    }
    const { line, direction } = normalizePassage(record);
    // A passage without a terminus says nothing about the direction, and the
    // same line/terminus pair comes back once per upcoming run: both are
    // dropped here so the search shows a route map, not a timetable.
    if (!direction) {
      continue;
    }
    const key = `${line}\u0000${direction}`;
    if (!byKey.has(key)) {
      byKey.set(key, { line, direction });
    }
  }

  return [...byKey.values()].sort(
    (a, b) => a.line.localeCompare(b.line, 'fr') || a.direction.localeCompare(b.direction, 'fr'),
  );
}

/**
 * Attach the directions to a handful of search results, in parallel.
 *
 * A failed lookup is not a failed search: the directions are a convenience on
 * top of the id the user came for, so a stop whose departures are unreadable
 * is still listed — without them.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {ReturnType<typeof normalizeStop>[]} stops
 * @returns {Promise<(ReturnType<typeof normalizeStop> & { directions: { line: string, direction: string }[] })[]>}
 */
async function attachDirections(config, stops) {
  const lookups = await Promise.allSettled(
    stops.map((stop) => fetchStopDirections(config, stop.id)),
  );

  return stops.map((stop, index) => {
    const lookup = lookups[index];
    if (lookup.status === 'rejected') {
      logger.debug(`No direction for stop ${stop.id}: ${lookup.reason.message}`);
      return { ...stop, directions: [] };
    }
    return { ...stop, directions: lookup.value };
  });
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
      // Never cache a failure: a timeout must be retryable straight away —
      // unless a newer download has already replaced this one.
      if (stopsCache?.promise === promise) {
        stopsCache = null;
      }
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
 * Each result then gets the directions its lines serve (see
 * `fetchStopDirections`), because an id and a name are not enough to choose:
 * the network gives the two sides of the same street two different stop ids
 * under the same name, and picking the wrong one is picking the tram going the
 * other way. That enrichment runs on the handful of results being shown, after
 * `limit` has been applied, so it costs a few small filtered requests.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string} query free text, matched case- and accent-insensitively on
 *   the stop name
 * @param {number} [limit]
 * @returns {Promise<(ReturnType<typeof normalizeStop> & {
 *   directions: { line: string, direction: string }[] })[]>}
 */
export async function searchStops(config, query, limit = 10) {
  const needle = normalizeText(query);
  if (needle.length === 0) {
    return [];
  }

  const exact = await searchStopsByExactName(config, query, limit);
  if (exact.length > 0) {
    return attachDirections(config, exact);
  }

  const values = await fetchStops(config);
  const matches = values
    .map(normalizeStop)
    .filter((stop) => stop.id && normalizeText(stop.name).includes(needle))
    .slice(0, limit);

  return attachDirections(config, matches);
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
 * @returns {Promise<ReturnType<typeof normalizeStop>[]>}
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
  ignoredFilterReported.clear();
}
