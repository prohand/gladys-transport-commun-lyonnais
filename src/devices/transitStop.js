// -----------------------------------------------------------------------------
// Device type: TRANSIT STOP (arrêt TCL)
//
// One device per stop the user watches. Read-only, refreshed by polling at
// `departures_poll_frequency` (departures are countdowns: they are only useful
// while fresh).
//
// Features, for each of the N next departures (N = `max_departures`):
//   - "Departure n" : minutes to wait          (duration sensor, charted)
//   - "Departure n details" : "T1 -> IUT Feyssine" (text sensor)
// plus one "Next departures" text feature summarizing the whole board, handy
// for a dashboard tile or a chat answer.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { gladysPollFrequency } from '../config.js';
import { TEXT_FEATURE_RANGE } from './featureRange.js';
import { fetchDepartures } from '../api/tcl.js';

export const DEVICE_TYPE = 'tcl-stop';

const logger = createLogger({ name: DEVICE_TYPE });

// A departure further away than this is reported as "no departure": the board
// only ever advertises the next couple of runs anyway.
const NO_DEPARTURE_MINUTES = 999;

/** Feature key of the n-th departure countdown (n starts at 1). */
export const departureFeatureKey = (rank) => `departure_${rank}`;
/** Feature key of the n-th departure label. */
export const departureDetailsFeatureKey = (rank) => `departure_${rank}_details`;
export const SUMMARY_FEATURE = 'departures';

/**
 * Human label of one departure: "T1 -> IUT Feyssine" (with a "~" prefix when
 * the operator sent a timetable estimate rather than a real-time one).
 * @param {{ line: string, direction: string, realtime: boolean }} departure
 */
export function formatDeparture(departure) {
  const direction = departure.direction ? ` → ${departure.direction}` : '';
  return `${departure.realtime ? '' : '~'}${departure.line}${direction}`;
}

/**
 * One-line board: "T1 → IUT Feyssine 3 min · C3 → Vaulx 7 min".
 * @param {{ line: string, direction: string, minutes: number, realtime: boolean }[]} departures
 */
export function formatSummary(departures) {
  if (departures.length === 0) {
    return 'No upcoming departure';
  }
  return departures
    .map((departure) => `${formatDeparture(departure)} ${departure.minutes} min`)
    .join(' · ');
}

/**
 * Default device name when the user did not give one: the stop id plus the
 * line filter, e.g. "TCL stop 1234 (T1)".
 * @param {{ id: string, lines: string[], name: string | null }} stop
 */
function deviceName(stop) {
  if (stop.name) {
    return stop.name;
  }
  const lines = stop.lines.length > 0 ? ` (${stop.lines.join(', ')})` : '';
  return `TCL stop ${stop.id}${lines}`;
}

/**
 * The blueprint of one watched stop. Built per configured entry (see
 * src/devices/index.js) rather than being a module-level singleton, because
 * how many stops exist is a user decision.
 *
 * @param {{ id: string, lines: string[], name: string | null }} stop
 */
export function createTransitStopBlueprint(stop) {
  // The line filter is part of the platform id: watching the same stop twice
  // with two different filters must yield two distinct devices.
  const platformId = stop.lines.length > 0 ? `${stop.id}@${stop.lines.join('|')}` : stop.id;

  return {
    key: `${DEVICE_TYPE}:${platformId}`,
    type: DEVICE_TYPE,
    stop,

    deviceExternalId(gladys) {
      return gladys.externalIds(DEVICE_TYPE, platformId).device;
    },

    pollIntervalMs(config) {
      return config.departures_poll_frequency * 1000;
    },

    buildDevice(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, platformId);
      const features = [];

      for (let rank = 1; rank <= config.max_departures; rank += 1) {
        features.push({
          name: rank === 1 ? 'Next departure' : `Departure ${rank}`,
          external_id: ids.feature(departureFeatureKey(rank)),
          category: DEVICE_FEATURE_CATEGORIES.DURATION,
          type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
          unit: DEVICE_FEATURE_UNITS.MINUTES,
          min: 0,
          max: NO_DEPARTURE_MINUTES,
          read_only: true,
          has_feedback: false,
          // Charted: the waiting time at a stop over the day is meaningful.
          keep_history: true,
        });
        features.push({
          name: rank === 1 ? 'Next departure line' : `Departure ${rank} line`,
          external_id: ids.feature(departureDetailsFeatureKey(rank)),
          category: DEVICE_FEATURE_CATEGORIES.TEXT,
          type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
          ...TEXT_FEATURE_RANGE,
          read_only: true,
          has_feedback: false,
          // A label changing every minute would only bloat the history.
          keep_history: false,
        });
      }

      features.push({
        name: 'Next departures',
        external_id: ids.feature(SUMMARY_FEATURE),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        ...TEXT_FEATURE_RANGE,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      });

      return {
        name: deviceName(stop),
        external_id: ids.device,
        // Gladys calls onPoll at this interval, in milliseconds, and only
        // accepts the values its own scheduler knows: the configured refresh
        // interval is honored by pollSchedule.js, not by this field.
        poll_frequency: gladysPollFrequency(config.departures_poll_frequency),
        params: [
          { name: 'stop_id', value: stop.id },
          { name: 'lines', value: stop.lines.join(',') },
          { name: 'source', value: 'data.grandlyon.com' },
        ],
        features,
      };
    },

    async onPoll(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, platformId);
      const departures = await fetchDepartures(config, stop);

      logger.info(`Stop ${stop.id}: ${departures.length} departure(s) upcoming`);

      const states = [
        {
          device_feature_external_id: ids.feature(SUMMARY_FEATURE),
          text: formatSummary(departures.slice(0, config.max_departures)),
        },
      ];

      for (let rank = 1; rank <= config.max_departures; rank += 1) {
        const departure = departures[rank - 1];
        states.push({
          device_feature_external_id: ids.feature(departureFeatureKey(rank)),
          // Publishing a sentinel rather than skipping the feature keeps the
          // dashboard honest: a stale "2 min" left over from the last run
          // would read as a tram that is never coming.
          state: departure ? departure.minutes : NO_DEPARTURE_MINUTES,
        });
        states.push({
          device_feature_external_id: ids.feature(departureDetailsFeatureKey(rank)),
          text: departure ? formatDeparture(departure) : '',
        });
      }

      // One batched request for the whole board.
      await gladys.publishStates(states);
    },
  };
}
