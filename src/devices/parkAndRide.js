// -----------------------------------------------------------------------------
// Device type: PARK & RIDE (parc relais TCL)
//
// One device per P+R facility the user watches. Read-only, refreshed by polling
// at `park_and_ride_poll_frequency`.
//
// Features:
//   - Spaces available          (counter)
//   - Accessible spaces available (counter, PMR spaces, when published)
//   - Total capacity            (counter, the inventory of the facility)
//   - Occupancy                 (percent of the capacity taken)
//   - Status                    (text: "120/655 free", "No live count"...)
//
// Total capacity and Status are what makes this device readable at all for the
// facilities SYTRAL does not count live. The occupancy layer only covers part
// of the network (see src/api/tcl.js): a car park that is in the inventory and
// not in the live counts had no readable value to publish, so its device
// stayed empty forever without a single error being raised — the reported "sur
// les parcs relais je n'ai pas de valeurs". Its capacity is known, and "no
// live count" is an answer; publishing neither was not.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { gladysPollFrequency } from '../config.js';
import { TEXT_FEATURE_RANGE } from './featureRange.js';
import { changedStates } from './stateCache.js';
import { fetchParkAndRideFacilities, findParkAndRide } from '../api/tcl.js';

export const DEVICE_TYPE = 'tcl-park-and-ride';

const logger = createLogger({ name: DEVICE_TYPE });

// The largest TCL park & ride holds a few hundred cars; the ceiling only
// bounds the UI gauge.
const MAX_SPACES = 2000;

export const FEATURE = {
  SPACES: 'spaces_available',
  SPACES_DISABLED: 'spaces_available_disabled',
  CAPACITY: 'capacity',
  OCCUPANCY: 'occupancy',
  STATUS: 'status',
};

/**
 * One line saying what the facility is doing, and — when the platform counts
 * nothing there — saying that too.
 *
 * This is the feature a car park with no live count still fills in, so the
 * user reads "no live count published" on their dashboard instead of staring
 * at an empty device wondering whether the integration is broken.
 *
 * @param {{ available?: number, capacity?: number }} facility
 * @returns {string}
 */
export function formatStatus(facility) {
  if (!Number.isFinite(facility.available)) {
    return Number.isFinite(facility.capacity)
      ? `No live count (${facility.capacity} spaces)`
      : 'No live count';
  }
  if (facility.available === 0) {
    return 'Full';
  }
  return Number.isFinite(facility.capacity)
    ? `${facility.available}/${facility.capacity} free`
    : `${facility.available} free`;
}

/**
 * Share of the capacity currently taken, in percent.
 * @param {{ capacity?: number, available?: number }} facility
 * @returns {number | null} null when the feed gives no usable capacity
 */
export function computeOccupancy(facility) {
  if (
    !Number.isFinite(facility.capacity) ||
    facility.capacity <= 0 ||
    !Number.isFinite(facility.available)
  ) {
    return null;
  }
  const taken = facility.capacity - facility.available;
  // Clamp: the operator occasionally publishes more free spaces than the
  // declared capacity right after a capacity change.
  return Math.min(100, Math.max(0, Math.round((taken / facility.capacity) * 100)));
}

/**
 * The blueprint of one watched park & ride facility.
 * @param {{ id: string, name: string | null }} watched entry from the config
 */
export function createParkAndRideBlueprint(watched) {
  return {
    key: `${DEVICE_TYPE}:${watched.id}`,
    type: DEVICE_TYPE,
    facility: watched,

    deviceExternalId(gladys) {
      return gladys.externalIds(DEVICE_TYPE, watched.id).device;
    },

    pollIntervalMs(config) {
      return config.park_and_ride_poll_frequency * 1000;
    },

    buildDevice(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, watched.id);
      // `keepHistory` is a choice per feature: the free spaces are a curve
      // worth keeping, the capacity of a car park is a number that changes
      // when the operator repaints the lines.
      const counter = (name, key, keepHistory = true) => ({
        name,
        external_id: ids.feature(key),
        category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        min: 0,
        max: MAX_SPACES,
        read_only: true,
        has_feedback: false,
        keep_history: keepHistory,
      });

      return {
        name: watched.name ?? `P+R ${watched.id}`,
        external_id: ids.device,
        poll_frequency: gladysPollFrequency(config.park_and_ride_poll_frequency),
        // Without this flag the core stores `poll_frequency` and never
        // schedules the device: see src/devices/transitStop.js.
        should_poll: true,
        params: [
          { name: 'park_and_ride_id', value: watched.id },
          { name: 'source', value: 'data.grandlyon.com' },
        ],
        features: [
          counter('Spaces available', FEATURE.SPACES),
          counter('Accessible spaces available', FEATURE.SPACES_DISABLED),
          counter('Total capacity', FEATURE.CAPACITY, false),
          {
            name: 'Occupancy',
            external_id: ids.feature(FEATURE.OCCUPANCY),
            category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
            type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
            unit: DEVICE_FEATURE_UNITS.PERCENT,
            min: 0,
            max: 100,
            read_only: true,
            has_feedback: false,
            keep_history: true,
          },
          {
            name: 'Status',
            external_id: ids.feature(FEATURE.STATUS),
            category: DEVICE_FEATURE_CATEGORIES.TEXT,
            type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
            ...TEXT_FEATURE_RANGE,
            read_only: true,
            has_feedback: false,
            keep_history: false,
          },
        ],
      };
    },

    async onPoll(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, watched.id);
      // Whole-layer fetch, shared between every watched facility of the cycle.
      const facilities = await fetchParkAndRideFacilities(config);
      const facility = findParkAndRide(facilities, watched.id);

      if (!facility) {
        // Naming a few of the ids the dataset does hold turns "check the id"
        // into something the user can act on without leaving the logs.
        const known = [...new Set([...facilities.values()].map((entry) => entry.id))]
          .filter(Boolean)
          .slice(0, 5)
          .join(', ');
        throw new Error(
          `Park & ride "${watched.id}" is not in the dataset (check the id in the ` +
            `configuration${known ? `; the dataset holds ${known}...` : ''})`,
        );
      }

      if (Number.isFinite(facility.available)) {
        logger.info(
          `P+R ${facility.name}: ${facility.available}/${facility.capacity ?? '?'} space(s) free`,
        );
      } else {
        // Not an error, and not silence either: this facility is in the
        // inventory and outside the live counts, which is a property of the
        // open data rather than of the configuration.
        logger.warn(
          `P+R ${facility.name}: the platform publishes no live count for this facility, ` +
            'only its capacity',
        );
      }

      // The status is published on every read, whatever the platform said:
      // it is what a facility with no live count has to show, and it is the
      // proof the device is being read at all.
      const states = [
        { device_feature_external_id: ids.feature(FEATURE.STATUS), text: formatStatus(facility) },
      ];
      if (Number.isFinite(facility.capacity)) {
        states.push({
          device_feature_external_id: ids.feature(FEATURE.CAPACITY),
          state: facility.capacity,
        });
      }
      if (Number.isFinite(facility.available)) {
        states.push({
          device_feature_external_id: ids.feature(FEATURE.SPACES),
          state: facility.available,
        });
      }
      if (Number.isFinite(facility.availableDisabled)) {
        states.push({
          device_feature_external_id: ids.feature(FEATURE.SPACES_DISABLED),
          state: facility.availableDisabled,
        });
      }
      const occupancy = computeOccupancy(facility);
      if (occupancy !== null) {
        states.push({
          device_feature_external_id: ids.feature(FEATURE.OCCUPANCY),
          state: occupancy,
        });
      }

      // Only what moved: the occupancy of a car park is flat for hours at a
      // time, and republishing it unchanged is what fills the Gladys database
      // without adding a single point to the chart (see stateCache.js).
      const updates = changedStates(states);
      if (updates.length > 0) {
        await gladys.publishStates(updates);
      }
    },
  };
}
