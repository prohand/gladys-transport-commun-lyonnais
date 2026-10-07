// -----------------------------------------------------------------------------
// Dashboard widgets (manifest `widgets`, Gladys >= 5.1.0).
//
// The devices already put every value on the dashboard, one feature per tile,
// and that is exactly what a departure board is bad at: "Next departure 3",
// "Next departure line T1 → IUT Feyssine", "Departure 2 7"... six tiles that
// only mean something read together. A widget is a card the integration
// composes itself, so each kind of device gets the card it deserves:
//   - departures    : the board of a stop, soonest first;
//   - velov_station : bikes, e-bikes and docks, the fill gauge, the day's curve;
//   - park_and_ride : free spaces, capacity, the fill gauge, the day's curve.
//
// Each widget instance is bound to one created device (a `source: "devices"`
// setting) and reads the feed through the same `read` as the poll, so the card
// and the device never disagree about the data, only about how fresh it is:
// the card is pulled when a dashboard shows it and cached by the core for its
// `ttl_seconds`, chosen from how fast each feed moves. The curves are the
// exception: they are the history Gladys already keeps for the device
// (`device_features`), so they cost this integration nothing.
//
// Nothing here throws at the dashboard. A device of the wrong kind, a device
// removed from the watch lists or a feed that is down all render as a card
// saying so — an empty or failed widget is the one outcome that tells the user
// nothing.
// -----------------------------------------------------------------------------

import {
  createLogger,
  WIDGET_CHART_INTERVALS,
  WIDGET_COLORS,
  WIDGET_TEXT_VARIANTS,
} from '@gladysassistant/integration-sdk';
import { DeviceSelectionError, deviceName, findSelectedBlueprint } from '../devices/index.js';
import { createdFeatures } from '../devices/publish.js';
import { DEVICE_TYPE as STOP_TYPE, formatDeparture } from '../devices/transitStop.js';
import {
  computeOccupancy as velovOccupancy,
  DEVICE_TYPE as VELOV_TYPE,
  FEATURE as VELOV_FEATURE,
} from '../devices/velovStation.js';
import {
  computeOccupancy as parkAndRideOccupancy,
  DEVICE_TYPE as PARK_AND_RIDE_TYPE,
  FEATURE as PARK_AND_RIDE_FEATURE,
} from '../devices/parkAndRide.js';
import { GrandLyonError } from '../api/grandlyon.js';

const logger = createLogger({ name: 'widgets' });

/** Keys of the `widgets` declared in the manifest. Never rename one. */
export const WIDGET_KEYS = {
  DEPARTURES: 'departures',
  VELOV_STATION: 'velov_station',
  PARK_AND_RIDE: 'park_and_ride',
};

// How long the core may serve a card before pulling it again. A countdown is
// stale after half a minute; a car park moves over minutes.
// The core waits 15 s for a widget, then shows "data unavailable" and never
// retries until the dashboard is reloaded — and one Data Grand Lyon request is
// allowed 15 s on its own. Past this deadline the card says it is loading, and
// the read keeps going: the feeds cache it, so the re-pull 15 s later finds it.
export const PULL_DEADLINE_MS = 9000;
const LOADING_TTL_SECONDS = 15;

/**
 * Settle with the promise, or with null once the deadline passed.
 * @param {Promise<object>} promise
 * @param {number} deadlineMs
 * @returns {Promise<object|null>}
 */
function withDeadline(promise, deadlineMs) {
  // A failure after the deadline must not be left unhandled.
  promise.catch((err) => logger.debug(`Widget read failed after the deadline: ${err.message}`));
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
    timer.unref?.();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const TTL_SECONDS = {
  [WIDGET_KEYS.DEPARTURES]: 30,
  [WIDGET_KEYS.VELOV_STATION]: 60,
  [WIDGET_KEYS.PARK_AND_RIDE]: 120,
};

// The board lists at most this many departures: the core caps a status list at
// ten rows, and a card is read at a glance.
const BOARD_ROWS = 8;

const { NEUTRAL, SUCCESS, WARNING, DANGER } = WIDGET_COLORS;

/**
 * The curves of a device, restricted to the features the created device
 * actually carries. A device created by an older release may lack one, and a
 * chart pointing at a feature that does not exist is an empty frame.
 *
 * @param {object} gladys
 * @param {string} deviceExternalId
 * @param {string[]} featureExternalIds
 * @returns {string[]}
 */
function chartableFeatures(gladys, deviceExternalId, featureExternalIds) {
  const created = createdFeatures(gladys, deviceExternalId);
  return created ? featureExternalIds.filter((id) => created.has(id)) : [];
}

/** A one-paragraph card, for everything that is not data. */
function messageContent(ttlSeconds, message) {
  return {
    ttl_seconds: ttlSeconds,
    components: [{ type: 'text', variant: WIDGET_TEXT_VARIANTS.BODY, text: message }],
  };
}

/**
 * The countdown of one departure as the board displays it: 0 is what the feed
 * makes of the operator's "Proche", so the card says it the same way.
 * @param {number} minutes
 */
function formatMinutes(minutes) {
  return minutes === 0 ? { en: 'Now', fr: 'Proche' } : `${minutes} min`;
}

/**
 * The state of a Vélo'v station, in both languages, with the color of its dot.
 * The device's own Status feature is a single English string (a text feature
 * holds one value); the card can do better.
 *
 * @param {{ installed: boolean, renting: boolean, returning: boolean,
 *   bikes?: number, docks?: number }} station
 * @returns {{ value: { en: string, fr: string }, color: string }}
 */
export function describeVelovStation(station) {
  if (!station.installed) {
    return { value: { en: 'Out of service', fr: 'Hors service' }, color: DANGER };
  }
  const issues = [];
  if (!station.renting) issues.push({ en: 'no rental', fr: 'location impossible' });
  if (!station.returning) issues.push({ en: 'no return', fr: 'retour impossible' });
  if (station.bikes === 0) issues.push({ en: 'no bike', fr: 'aucun vélo' });
  if (station.docks === 0) issues.push({ en: 'no free dock', fr: 'aucune place' });
  if (issues.length === 0) {
    return { value: { en: 'OK', fr: 'OK' }, color: SUCCESS };
  }
  return {
    value: {
      en: issues.map((issue) => issue.en).join(', '),
      fr: issues.map((issue) => issue.fr).join(', '),
    },
    color: WARNING,
  };
}

/**
 * The state of a park & ride facility, in both languages, with the color of
 * its dot. The two reasons for a missing count stay distinct here too (see
 * `formatStatus` in src/devices/parkAndRide.js): one is the open data, the
 * other is a bug to report.
 *
 * @param {{ available?: number, capacity?: number, live?: boolean }} facility
 * @returns {{ value: { en: string, fr: string }, color: string }}
 */
export function describeParkAndRide(facility) {
  if (!Number.isFinite(facility.available)) {
    return facility.live === true
      ? { value: { en: 'Live count unreadable', fr: 'Comptage illisible' }, color: WARNING }
      : { value: { en: 'No live count', fr: 'Pas de comptage en direct' }, color: NEUTRAL };
  }
  if (facility.available === 0) {
    return { value: { en: 'Full', fr: 'Complet' }, color: DANGER };
  }
  const occupancy = parkAndRideOccupancy(facility);
  return occupancy !== null && occupancy >= 90
    ? { value: { en: 'Almost full', fr: 'Presque complet' }, color: WARNING }
    : { value: { en: 'Spaces available', fr: 'Places disponibles' }, color: SUCCESS };
}

/**
 * The card of a transit stop: the next departure as a tile, the board below.
 *
 * @param {string} name
 * @param {{ line: string, direction: string, minutes: number, realtime: boolean }[]} departures
 */
export function departuresContent(name, departures) {
  const components = [{ type: 'text', variant: WIDGET_TEXT_VARIANTS.HEADING, text: name }];
  const [next] = departures;
  if (!next) {
    components.push({
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.BODY,
      text: { en: 'No upcoming departure.', fr: 'Aucun passage à venir.' },
    });
    return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.DEPARTURES], components };
  }

  components.push({
    type: 'value',
    value: next.minutes,
    unit: 'min',
    label: formatDeparture(next),
    icon: 'clock',
    color: next.realtime ? SUCCESS : NEUTRAL,
  });
  components.push({
    type: 'status',
    items: departures.slice(0, BOARD_ROWS).map((departure) => ({
      label: formatDeparture(departure),
      value: formatMinutes(departure.minutes),
      // The dot says how much to trust the countdown: green is a vehicle the
      // operator tracks, grey is the timetable.
      color: departure.realtime ? SUCCESS : NEUTRAL,
    })),
  });
  if (departures.slice(0, BOARD_ROWS).some((departure) => !departure.realtime)) {
    components.push({
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.CAPTION,
      text: {
        en: '~ timetable estimate, not tracked in real time',
        fr: '~ horaire théorique, non suivi en temps réel',
      },
    });
  }
  return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.DEPARTURES], components };
}

/**
 * The card of a Vélo'v station.
 *
 * @param {string} name
 * @param {object} station a reading of the station (src/api/velov.js)
 * @param {string[]} chartFeatures feature external_ids to draw the day of
 */
export function velovStationContent(name, station, chartFeatures = []) {
  const components = [{ type: 'text', variant: WIDGET_TEXT_VARIANTS.HEADING, text: name }];
  if (Number.isFinite(station.bikes)) {
    components.push({
      type: 'value',
      value: station.bikes,
      label: { en: 'Bikes', fr: 'Vélos' },
      color: station.bikes === 0 ? DANGER : SUCCESS,
    });
  }
  if (Number.isFinite(station.electricBikes)) {
    components.push({
      type: 'value',
      value: station.electricBikes,
      label: { en: 'Electric bikes', fr: 'Vélos électriques' },
      icon: 'zap',
    });
  }
  if (Number.isFinite(station.docks)) {
    components.push({
      type: 'value',
      value: station.docks,
      label: { en: 'Free docks', fr: 'Places libres' },
      color: station.docks === 0 ? WARNING : NEUTRAL,
    });
  }
  const occupancy = velovOccupancy(station);
  if (occupancy !== null) {
    components.push({
      type: 'gauge',
      value: occupancy,
      min: 0,
      max: 100,
      unit: '%',
      label: { en: 'Fill', fr: 'Remplissage' },
    });
  }
  if (chartFeatures.length > 0) {
    components.push({
      type: 'chart',
      device_features: chartFeatures,
      interval: WIDGET_CHART_INTERVALS.LAST_DAY,
      chart_type: 'line',
      title: { en: 'Last 24 hours', fr: 'Dernières 24 heures' },
    });
  }
  const state = describeVelovStation(station);
  components.push({
    type: 'status',
    items: [{ label: { en: 'State', fr: 'État' }, value: state.value, color: state.color }],
  });
  return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.VELOV_STATION], components };
}

/**
 * The card of a park & ride facility.
 *
 * @param {string} name
 * @param {object} facility a reading of the facility (src/api/tcl.js)
 * @param {string[]} chartFeatures feature external_ids to draw the day of
 */
export function parkAndRideContent(name, facility, chartFeatures = []) {
  const components = [{ type: 'text', variant: WIDGET_TEXT_VARIANTS.HEADING, text: name }];
  if (Number.isFinite(facility.available)) {
    components.push({
      type: 'value',
      value: facility.available,
      label: { en: 'Free spaces', fr: 'Places libres' },
      color: facility.available === 0 ? DANGER : SUCCESS,
    });
  }
  if (Number.isFinite(facility.capacity)) {
    components.push({
      type: 'value',
      value: facility.capacity,
      label: { en: 'Capacity', fr: 'Capacité' },
    });
  }
  if (Number.isFinite(facility.availableDisabled)) {
    components.push({
      type: 'value',
      value: facility.availableDisabled,
      label: { en: 'Accessible spaces', fr: 'Places PMR' },
    });
  }
  const occupancy = parkAndRideOccupancy(facility);
  if (occupancy !== null) {
    components.push({
      type: 'gauge',
      value: occupancy,
      min: 0,
      max: 100,
      unit: '%',
      label: { en: 'Fill', fr: 'Remplissage' },
    });
  }
  // A facility with no live count has no curve to draw: an empty frame would
  // look like a chart that failed.
  if (chartFeatures.length > 0 && Number.isFinite(facility.available)) {
    components.push({
      type: 'chart',
      device_features: chartFeatures,
      interval: WIDGET_CHART_INTERVALS.LAST_DAY,
      chart_type: 'line',
      title: { en: 'Free spaces, last 24 hours', fr: 'Places libres, dernières 24 h' },
    });
  }
  const state = describeParkAndRide(facility);
  components.push({
    type: 'status',
    items: [{ label: { en: 'State', fr: 'État' }, value: state.value, color: state.color }],
  });
  return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.PARK_AND_RIDE], components };
}

/**
 * The raw handlers: the device the widget is bound to, read, turned into a
 * card. Each one receives the SDK options (`settings` holds the chosen device
 * external_id) and the current configuration.
 */
const RAW_WIDGETS = {
  async [WIDGET_KEYS.DEPARTURES](gladys, { settings, config }) {
    const blueprint = findSelectedBlueprint(gladys, settings.stop, config, STOP_TYPE);
    const departures = await blueprint.read(config);
    return departuresContent(deviceName(gladys, blueprint, config), departures);
  },

  async [WIDGET_KEYS.VELOV_STATION](gladys, { settings, config }) {
    const blueprint = findSelectedBlueprint(gladys, settings.station, config, VELOV_TYPE);
    const station = await blueprint.read(config);
    const ids = gladys.externalIds(VELOV_TYPE, blueprint.station.id);
    const chart = chartableFeatures(gladys, ids.device, [
      ids.feature(VELOV_FEATURE.BIKES),
      ids.feature(VELOV_FEATURE.DOCKS),
    ]);
    return velovStationContent(deviceName(gladys, blueprint, config), station, chart);
  },

  async [WIDGET_KEYS.PARK_AND_RIDE](gladys, { settings, config }) {
    const blueprint = findSelectedBlueprint(gladys, settings.facility, config, PARK_AND_RIDE_TYPE);
    const facility = await blueprint.read(config);
    const ids = gladys.externalIds(PARK_AND_RIDE_TYPE, blueprint.facility.id);
    const chart = chartableFeatures(gladys, ids.device, [
      ids.feature(PARK_AND_RIDE_FEATURE.SPACES),
    ]);
    return parkAndRideContent(deviceName(gladys, blueprint, config), facility, chart);
  },
};

/**
 * Handlers of the widgets, by key, with every failure turned into a card that
 * says what is wrong. The settings problems and the refused Data Grand Lyon
 * account already carry a bilingual explanation; anything else is a feed that
 * could not be read, logged for the report and summed up on the card.
 */
export const WIDGETS = Object.fromEntries(
  Object.entries(RAW_WIDGETS).map(([key, handler]) => [
    key,
    async (gladys, context, { deadlineMs = PULL_DEADLINE_MS } = {}) => {
      try {
        const read = handler(gladys, context);
        const content = await withDeadline(read, deadlineMs);
        if (content === null) {
          logger.info(`Widget ${key}: no answer within ${deadlineMs} ms, serving a loading card`);
          return messageContent(LOADING_TTL_SECONDS, {
            en: 'Reading the data, this takes longer than usual…',
            fr: 'Lecture des données, plus longue que d’habitude…',
          });
        }
        return content;
      } catch (err) {
        if (err instanceof DeviceSelectionError) {
          return messageContent(TTL_SECONDS[key], err.userMessage);
        }
        if (err instanceof GrandLyonError && err.userMessage) {
          logger.warn(`Widget ${key} failed: ${err.message}`);
          return messageContent(TTL_SECONDS[key], err.userMessage);
        }
        logger.warn(`Widget ${key} failed: ${err.message}`);
        return messageContent(TTL_SECONDS[key], {
          en: `The data could not be read right now (${err.message}).`,
          fr: `Les données n’ont pas pu être lues pour l’instant (${err.message}).`,
        });
      }
    },
  ]),
);
