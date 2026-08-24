// -----------------------------------------------------------------------------
// Device type: VÉLO'V STATION
//
// One device per bike-sharing station the user watches. Read-only, refreshed
// by polling at `velov_poll_frequency` (the GBFS feed itself is recomputed
// once a minute upstream, so polling faster only costs requests).
//
// Features:
//   - Bikes available          (counter)
//   - Electric bikes available (counter, only when the feed details the fleet)
//   - Docks available          (counter)
//   - Occupancy                (percent of the capacity holding a bike)
//   - Status                   (text: out of service, no bikes, docks full...)
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { gladysPollFrequency } from '../config.js';
import { fetchStationAvailability } from '../api/velov.js';

export const DEVICE_TYPE = 'velov-station';

const logger = createLogger({ name: DEVICE_TYPE });

// Vélo'v stations top out around 40 stands; the ceiling only bounds the UI
// gauge, it never clips a published value.
const MAX_STANDS = 100;

export const FEATURE = {
  BIKES: 'bikes_available',
  ELECTRIC_BIKES: 'electric_bikes_available',
  DOCKS: 'docks_available',
  OCCUPANCY: 'occupancy',
  STATUS: 'status',
};

/**
 * Short status line for the station.
 * @param {{ installed: boolean, renting: boolean, returning: boolean,
 *   bikes?: number, docks?: number }} station
 */
export function formatStatus(station) {
  if (!station.installed) {
    return 'Out of service';
  }
  const issues = [];
  if (!station.renting) {
    issues.push('no rental');
  }
  if (!station.returning) {
    issues.push('no return');
  }
  if (station.bikes === 0) {
    issues.push('no bike available');
  }
  if (station.docks === 0) {
    issues.push('no free dock');
  }
  return issues.length === 0 ? 'OK' : issues.join(', ');
}

/**
 * Share of the capacity currently holding a bike, in percent.
 * @param {{ bikes?: number, docks?: number, capacity?: number }} station
 * @returns {number | null} null when the feed gives no usable capacity
 */
export function computeOccupancy(station) {
  const capacity =
    station.capacity ??
    (Number.isFinite(station.bikes) && Number.isFinite(station.docks)
      ? station.bikes + station.docks
      : undefined);

  if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(station.bikes)) {
    return null;
  }
  return Math.round((station.bikes / capacity) * 100);
}

/**
 * The blueprint of one watched Vélo'v station.
 * @param {{ id: string, name: string | null }} watched entry from the config
 */
export function createVelovStationBlueprint(watched) {
  return {
    key: `${DEVICE_TYPE}:${watched.id}`,
    type: DEVICE_TYPE,
    station: watched,

    deviceExternalId(gladys) {
      return gladys.externalIds(DEVICE_TYPE, watched.id).device;
    },

    pollIntervalMs(config) {
      return config.velov_poll_frequency * 1000;
    },

    buildDevice(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, watched.id);
      const counter = (name, key) => ({
        name,
        external_id: ids.feature(key),
        category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        min: 0,
        max: MAX_STANDS,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      });

      return {
        name: watched.name ?? `Vélo'v ${watched.id}`,
        external_id: ids.device,
        poll_frequency: gladysPollFrequency(config.velov_poll_frequency),
        params: [
          { name: 'station_id', value: watched.id },
          { name: 'source', value: 'GBFS (Métropole de Lyon / JCDecaux)' },
        ],
        features: [
          counter('Bikes available', FEATURE.BIKES),
          counter('Electric bikes available', FEATURE.ELECTRIC_BIKES),
          counter('Docks available', FEATURE.DOCKS),
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
            read_only: true,
            has_feedback: false,
            keep_history: false,
          },
        ],
      };
    },

    async onPoll(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, watched.id);
      const station = await fetchStationAvailability(config, watched.id);

      if (!station) {
        // Unknown id: say so loudly once per poll rather than publishing
        // zeroes that would look like a full, empty station.
        throw new Error(
          `Vélo'v station "${watched.id}" is not in the feed (check the id in the configuration)`,
        );
      }

      logger.info(
        `Vélo'v ${station.name}: ${station.bikes ?? '?'} bike(s), ${station.docks ?? '?'} dock(s)`,
      );

      const states = [
        { device_feature_external_id: ids.feature(FEATURE.STATUS), text: formatStatus(station) },
      ];
      // A counter the feed did not send is left untouched: republishing 0
      // would be a lie, and Gladys keeps the previous value.
      if (Number.isFinite(station.bikes)) {
        states.push({
          device_feature_external_id: ids.feature(FEATURE.BIKES),
          state: station.bikes,
        });
      }
      if (Number.isFinite(station.electricBikes)) {
        states.push({
          device_feature_external_id: ids.feature(FEATURE.ELECTRIC_BIKES),
          state: station.electricBikes,
        });
      }
      if (Number.isFinite(station.docks)) {
        states.push({
          device_feature_external_id: ids.feature(FEATURE.DOCKS),
          state: station.docks,
        });
      }
      const occupancy = computeOccupancy(station);
      if (occupancy !== null) {
        states.push({
          device_feature_external_id: ids.feature(FEATURE.OCCUPANCY),
          state: occupancy,
        });
      }

      await gladys.publishStates(states);
    },
  };
}
