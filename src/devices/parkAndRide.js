// -----------------------------------------------------------------------------
// Device type: PARK & RIDE (parc relais TCL)
//
// One device per P+R facility the user watches. Read-only, refreshed by polling
// at `park_and_ride_poll_frequency`.
//
// Features:
//   - Spaces available          (counter)
//   - Accessible spaces available (counter, PMR spaces, when published)
//   - Occupancy                 (percent of the capacity taken)
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { gladysPollFrequency } from '../config.js';
import { fetchParkAndRideFacilities, findParkAndRide } from '../api/tcl.js';

export const DEVICE_TYPE = 'tcl-park-and-ride';

const logger = createLogger({ name: DEVICE_TYPE });

// The largest TCL park & ride holds a few hundred cars; the ceiling only
// bounds the UI gauge.
const MAX_SPACES = 2000;

export const FEATURE = {
  SPACES: 'spaces_available',
  SPACES_DISABLED: 'spaces_available_disabled',
  OCCUPANCY: 'occupancy',
};

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
      const counter = (name, key) => ({
        name,
        external_id: ids.feature(key),
        category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        min: 0,
        max: MAX_SPACES,
        read_only: true,
        has_feedback: false,
        keep_history: true,
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
        ],
      };
    },

    async onPoll(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, watched.id);
      // Whole-layer fetch, shared between every watched facility of the cycle.
      const facilities = await fetchParkAndRideFacilities(config);
      const facility = findParkAndRide(facilities, watched.id);

      if (!facility) {
        throw new Error(
          `Park & ride "${watched.id}" is not in the dataset (check the id in the configuration)`,
        );
      }

      logger.info(
        `P+R ${facility.name}: ${facility.available ?? '?'}/${facility.capacity ?? '?'} space(s) free`,
      );

      const states = [];
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

      if (states.length > 0) {
        await gladys.publishStates(states);
      }
    },
  };
}
