// -----------------------------------------------------------------------------
// Scene triggers (manifest `scene_triggers`, Gladys >= 5.1.0).
//
// A device feature is a state, and Gladys already knows how to start a scene
// on a state ("bikes available < 3"). A scene trigger is the other thing: an
// event, something that HAPPENED between two reads — the last bike of a
// station was taken, a car park just filled up, the tram crossed the "5
// minutes away" mark. The core matches the event against the filters the scene
// author configured, and it only does equality and membership: no operator, no
// threshold. So every threshold of this module is decided here, once, and
// travels as a plain value the scene can compare for equality.
//
// Events are computed from two consecutive reads of the same device, in the
// poll path (see `pollDevice` in src/devices/index.js), and the doctrine of
// the contract is "one event per transition, never a periodic snapshot":
//   - nothing fires on the first read after a start, since there is no
//     transition without a previous value — a container restart must not
//     announce that every watched car park "just became full";
//   - a value the feed did not send is not a transition either: an unreadable
//     count is not a station that emptied.
//
// A failed publication only costs the event: the poll that computed it has
// already published its states, and a scene that did not run is better than a
// device that stops refreshing because an older Gladys answered 404.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE as STOP_TYPE } from '../devices/transitStop.js';
import { DEVICE_TYPE as VELOV_TYPE } from '../devices/velovStation.js';
import {
  computeOccupancy as parkAndRideOccupancy,
  DEVICE_TYPE as PARK_AND_RIDE_TYPE,
} from '../devices/parkAndRide.js';

const logger = createLogger({ name: 'scenes' });

/** Keys of the `scene_triggers` declared in the manifest. Never rename one. */
export const SCENE_TRIGGERS = {
  DEPARTURE_APPROACHING: 'departure_approaching',
  VELOV_STATION_CHANGED: 'velov_station_changed',
  PARK_AND_RIDE_CHANGED: 'park_and_ride_changed',
};

/**
 * The "minutes before the departure" marks a scene can wait for. They are the
 * options of the `threshold` select of the manifest: the core compares the
 * value for equality, so the list lives on both sides and
 * test/manifest.test.js keeps them identical.
 */
export const DEPARTURE_THRESHOLDS = [1, 2, 3, 5, 10, 15];

/** Values of the `event` field of the Vélo'v trigger. */
export const VELOV_EVENTS = {
  NO_BIKE: 'no_bike',
  BIKES_BACK: 'bikes_back',
  NO_DOCK: 'no_dock',
  DOCKS_BACK: 'docks_back',
  OUT_OF_SERVICE: 'out_of_service',
  BACK_IN_SERVICE: 'back_in_service',
};

/** Values of the `event` field of the park & ride trigger. */
export const PARK_AND_RIDE_EVENTS = {
  ALMOST_FULL: 'almost_full',
  FULL: 'full',
  SPACES_BACK: 'spaces_back',
};

// "Almost full" is a threshold, and thresholds are the integration's call (see
// the header). Nine cars out of ten is the level at which the facilities of
// the network start turning drivers away at rush hour.
export const ALMOST_FULL_OCCUPANCY = 90;

/** @type {Map<string, unknown>} previous reading, per blueprint key. */
const previousReadings = new Map();

/** Forget every previous reading (tests). */
export function clearSceneMemory() {
  previousReadings.clear();
}

const isCount = (value) => Number.isFinite(value);

/** The key of a line in one direction, the unit a countdown is followed by. */
function routeOf(departure) {
  return `${departure.line}\u0000${departure.direction}`;
}

/**
 * The soonest departure of each line and direction of a board.
 *
 * A departure has no identity in the feed — no trip id, just a line, a
 * direction and a countdown — so "the same tram" is followed as "the next one
 * of this line in this direction". When it leaves, the next one takes its
 * place with a longer countdown, which is never a crossing.
 *
 * @param {{ line: string, direction: string, minutes: number }[]} departures
 * @returns {Map<string, { line: string, direction: string, minutes: number, realtime: boolean }>}
 */
function soonestByRoute(departures) {
  const byRoute = new Map();
  for (const departure of departures) {
    const route = routeOf(departure);
    const known = byRoute.get(route);
    if (!known || departure.minutes < known.minutes) {
      byRoute.set(route, departure);
    }
  }
  return byRoute;
}

/**
 * The thresholds each route of a stop crossed between two reads.
 *
 * Every mark crossed fires, not only the closest one: a board read every five
 * minutes can go from 11 to 4 in one step, and a scene waiting for "10" is as
 * entitled to run as one waiting for "5". A route absent from the previous
 * read is not followed yet — a line that appears on the board at 3 minutes
 * (the realtime feed dropping it and picking it back up) did not approach, it
 * reappeared.
 *
 * @param {{ line: string, direction: string, minutes: number, realtime: boolean }[]} previous
 * @param {{ line: string, direction: string, minutes: number, realtime: boolean }[]} current
 * @returns {{ departure: object, threshold: number }[]}
 */
export function departureCrossings(previous, current) {
  const crossings = [];
  for (const [route, departure] of soonestByRoute(current)) {
    // Compared with the same vehicle, not with the previous soonest one: the
    // vehicle at the head of the board may have left in between, and the next
    // one, read at 7 minutes then at 5, was then compared with the 1 minute of
    // the one that left — its "5 minutes" never fired. The vehicle it most
    // likely was is the closest one that was not already nearer.
    const was = previous
      .filter((candidate) => routeOf(candidate) === route && candidate.minutes >= departure.minutes)
      .reduce((closest, candidate) => Math.min(closest, candidate.minutes), Infinity);
    if (!Number.isFinite(was)) {
      continue;
    }
    for (const threshold of DEPARTURE_THRESHOLDS) {
      if (was > threshold && departure.minutes <= threshold) {
        crossings.push({ departure, threshold });
      }
    }
  }
  return crossings;
}

/**
 * The Vélo'v events between two reads of one station.
 *
 * @param {{ bikes?: number, docks?: number, installed?: boolean }} previous
 * @param {{ bikes?: number, docks?: number, installed?: boolean }} current
 * @returns {string[]} values of VELOV_EVENTS
 */
export function velovStationEvents(previous, current) {
  const events = [];
  if (isCount(previous.bikes) && isCount(current.bikes)) {
    if (previous.bikes > 0 && current.bikes === 0) events.push(VELOV_EVENTS.NO_BIKE);
    if (previous.bikes === 0 && current.bikes > 0) events.push(VELOV_EVENTS.BIKES_BACK);
  }
  if (isCount(previous.docks) && isCount(current.docks)) {
    if (previous.docks > 0 && current.docks === 0) events.push(VELOV_EVENTS.NO_DOCK);
    if (previous.docks === 0 && current.docks > 0) events.push(VELOV_EVENTS.DOCKS_BACK);
  }
  if (previous.installed === true && current.installed === false) {
    events.push(VELOV_EVENTS.OUT_OF_SERVICE);
  }
  if (previous.installed === false && current.installed === true) {
    events.push(VELOV_EVENTS.BACK_IN_SERVICE);
  }
  return events;
}

/**
 * The park & ride events between two reads of one facility.
 *
 * A facility with no live count never fires: its capacity is known, its
 * occupancy is not, and "no count" read twice is not a car park filling up.
 *
 * @param {{ available?: number, capacity?: number }} previous
 * @param {{ available?: number, capacity?: number }} current
 * @returns {string[]} values of PARK_AND_RIDE_EVENTS
 */
export function parkAndRideEvents(previous, current) {
  const events = [];
  if (!isCount(previous.available) || !isCount(current.available)) {
    return events;
  }
  const wasOccupancy = parkAndRideOccupancy(previous);
  const occupancy = parkAndRideOccupancy(current);
  if (
    wasOccupancy !== null &&
    occupancy !== null &&
    wasOccupancy < ALMOST_FULL_OCCUPANCY &&
    occupancy >= ALMOST_FULL_OCCUPANCY &&
    current.available > 0
  ) {
    events.push(PARK_AND_RIDE_EVENTS.ALMOST_FULL);
  }
  if (previous.available > 0 && current.available === 0) {
    events.push(PARK_AND_RIDE_EVENTS.FULL);
  }
  if (previous.available === 0 && current.available > 0) {
    events.push(PARK_AND_RIDE_EVENTS.SPACES_BACK);
  }
  return events;
}

/**
 * The scene events a read produced, as `{ key, data }` ready for
 * `publishSceneEvent`.
 *
 * The device field of each trigger (`stop`, `station`, `facility`) is a
 * `source: "devices"` select: the scene author picks one of the created
 * devices and the core compares its external_id with the one sent here.
 *
 * @param {object} blueprint the blueprint that was read
 * @param {string} deviceExternalId
 * @param {string} name the name of the device, for the scene variables
 * @param {unknown} previous the reading before this one
 * @param {unknown} current the reading that was just made
 * @returns {{ key: string, data: Record<string, string | number | boolean | null> }[]}
 */
export function sceneEventsBetween(blueprint, deviceExternalId, name, previous, current) {
  switch (blueprint.type) {
    case STOP_TYPE:
      return departureCrossings(previous, current).map(({ departure, threshold }) => ({
        key: SCENE_TRIGGERS.DEPARTURE_APPROACHING,
        data: {
          stop: deviceExternalId,
          stop_name: name,
          line: departure.line,
          direction: departure.direction,
          threshold: String(threshold),
          minutes: departure.minutes,
          realtime: departure.realtime,
        },
      }));
    case VELOV_TYPE:
      return velovStationEvents(previous, current).map((event) => ({
        key: SCENE_TRIGGERS.VELOV_STATION_CHANGED,
        data: {
          station: deviceExternalId,
          station_name: name,
          event,
          bikes: current.bikes ?? null,
          electric_bikes: current.electricBikes ?? null,
          docks: current.docks ?? null,
        },
      }));
    case PARK_AND_RIDE_TYPE:
      return parkAndRideEvents(previous, current).map((event) => ({
        key: SCENE_TRIGGERS.PARK_AND_RIDE_CHANGED,
        data: {
          facility: deviceExternalId,
          facility_name: name,
          event,
          available: current.available ?? null,
          capacity: current.capacity ?? null,
          occupancy: parkAndRideOccupancy(current),
        },
      }));
    default:
      return [];
  }
}

/**
 * Remember a fresh reading of a device and fire the scene events it produced.
 *
 * @param {object} gladys
 * @param {object} blueprint
 * @param {string} name the name of the device, for the scene variables
 * @param {unknown} reading what `blueprint.onPoll` returned
 */
export async function publishSceneEvents(gladys, blueprint, name, reading) {
  if (reading === undefined || reading === null) {
    return;
  }
  const previous = previousReadings.get(blueprint.key);
  previousReadings.set(blueprint.key, reading);
  if (previous === undefined) {
    return;
  }

  const events = sceneEventsBetween(
    blueprint,
    blueprint.deviceExternalId(gladys),
    name,
    previous,
    reading,
  );
  for (const { key, data } of events) {
    try {
      await gladys.publishSceneEvent(key, data);
      logger.info(
        `Scene event ${key} fired for ${name} (${data.event ?? `${data.line} ${data.threshold} min`})`,
      );
    } catch (err) {
      logger.warn(`Scene event ${key} for ${name} could not be published: ${err.message}`);
    }
  }
}
