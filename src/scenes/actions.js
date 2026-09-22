// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`, Gladys >= 5.1.0).
//
// The devices already hold the latest values, but a scene reading them gets
// whatever the last poll left there — up to five minutes old for a park &
// ride, and a departure countdown that was right a minute ago is wrong now.
// These actions read the feed at the moment the scene reaches them and hand
// the answer to the following steps as outputs: "at 7:40, tell me when the
// next T1 leaves" is one scene with one action and one message.
//
// The actions read, they never publish: a device state has one writer, the
// poll, and the scene triggers compare consecutive polls — a read squeezed in
// between by a scene would be a transition nobody else saw.
//
// Throwing fails the action only (the scene logs it and carries on), which is
// the right answer to a device of the wrong kind or a feed that is down: the
// outputs of an action that could not read anything would be made up.
// -----------------------------------------------------------------------------

import { deviceName, findSelectedBlueprint } from '../devices/index.js';
import {
  DEVICE_TYPE as STOP_TYPE,
  formatDeparture,
  formatSummary,
} from '../devices/transitStop.js';
import {
  computeOccupancy as velovOccupancy,
  DEVICE_TYPE as VELOV_TYPE,
  formatStatus as velovStatus,
} from '../devices/velovStation.js';
import {
  computeOccupancy as parkAndRideOccupancy,
  DEVICE_TYPE as PARK_AND_RIDE_TYPE,
  formatStatus as parkAndRideStatus,
} from '../devices/parkAndRide.js';

/** Keys of the `scene_actions` declared in the manifest. Never rename one. */
export const SCENE_ACTION_KEYS = {
  NEXT_DEPARTURES: 'get_next_departures',
  VELOV_STATION: 'get_velov_station',
  PARK_AND_RIDE: 'get_park_and_ride',
};

// How many departures the `summary` output lists: enough to answer "and the
// one after?", short enough for a notification.
const SUMMARY_DEPARTURES = 3;

/**
 * Handlers of the scene actions, by key. Each one receives the resolved
 * `fields` of the action (the `source: "devices"` select carries the chosen
 * device external_id) and resolves the declared outputs.
 */
export const SCENE_ACTIONS = {
  /**
   * The next departures of a watched stop, optionally narrowed to one line.
   *
   * The line is compared without case: a scene author typing "t1" means the
   * tram the pole calls "T1". No departure is an answer, not an error — the
   * outputs say so (`count` 0, `minutes` null) and the scene can test it.
   */
  async [SCENE_ACTION_KEYS.NEXT_DEPARTURES](gladys, { fields, config }) {
    const blueprint = findSelectedBlueprint(gladys, fields.stop, config, STOP_TYPE);
    const line = String(fields.line ?? '')
      .trim()
      .toUpperCase();
    const departures = (await blueprint.read(config)).filter(
      (departure) => line === '' || departure.line.toUpperCase() === line,
    );
    const next = departures[0];
    return {
      stop_name: deviceName(gladys, blueprint, config),
      line: next?.line ?? null,
      direction: next?.direction ?? null,
      minutes: next?.minutes ?? null,
      realtime: next?.realtime ?? null,
      departure: next ? formatDeparture(next) : null,
      following_minutes: departures[1]?.minutes ?? null,
      summary: formatSummary(departures.slice(0, SUMMARY_DEPARTURES)),
      count: departures.length,
    };
  },

  /** The live availability of a watched Vélo'v station. */
  async [SCENE_ACTION_KEYS.VELOV_STATION](gladys, { fields, config }) {
    const blueprint = findSelectedBlueprint(gladys, fields.station, config, VELOV_TYPE);
    const station = await blueprint.read(config);
    return {
      station_name: deviceName(gladys, blueprint, config),
      bikes: station.bikes ?? null,
      electric_bikes: station.electricBikes ?? null,
      docks: station.docks ?? null,
      occupancy: velovOccupancy(station),
      status: velovStatus(station),
    };
  },

  /**
   * The availability of a watched park & ride facility. A facility with no
   * live count answers its capacity and a null `available`, which is what the
   * platform knows; the `status` output says which of the two reasons applies.
   */
  async [SCENE_ACTION_KEYS.PARK_AND_RIDE](gladys, { fields, config }) {
    const blueprint = findSelectedBlueprint(gladys, fields.facility, config, PARK_AND_RIDE_TYPE);
    const facility = await blueprint.read(config);
    return {
      facility_name: deviceName(gladys, blueprint, config),
      available: facility.available ?? null,
      capacity: facility.capacity ?? null,
      occupancy: parkAndRideOccupancy(facility),
      status: parkAndRideStatus(facility),
    };
  },
};
