// -----------------------------------------------------------------------------
// Internal refresh loop: the integration's own ticker over the devices the
// user actually created.
//
// Gladys polls a device only when its row carries `should_poll` — a flag read
// once, from the payload the Discovery screen posts at creation
// (see src/devices/transitStop.js). Two consequences shape this module:
//
//   - a device created before that flag was published is scheduled by nobody,
//     and nothing in the integration can flip it: `publishDiscoveredDevices`
//     only upserts params and feature options on an already-created device,
//     and the "Update" button of the Discovery screen appears on a feature
//     change, which a flag is not. Those devices would keep the empty features
//     that this loop was written for, until the user deleted and re-added them;
//   - a device whose poll never reaches the container (a tick dropped while
//     the integration was reconnecting) waits a full interval for the next one.
//
// So the container refreshes its devices itself, and `dueForRead` (the same
// gate the Gladys ticks go through) keeps the upstream feed read once per
// configured interval no matter how many tickers ask for it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { gladysPollFrequency } from '../config.js';
import { pollDevice } from './index.js';

const logger = createLogger({ name: 'refresh' });

/** @type {NodeJS.Timeout | null} */
let timer = null;
// A tick that finds the previous one still running is dropped: a feed that
// answers slowly must not stack reads on top of each other.
let refreshing = false;

/**
 * Period of the internal ticker: the fastest tick Gladys itself would use for
 * these devices.
 *
 * Ticking faster would not read anything sooner (`dueForRead` gates on the
 * configured interval) and ticking slower would make the fastest device miss
 * its interval, so the loop mirrors the core scheduler rather than inventing
 * a rhythm of its own.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @returns {number} tick period in milliseconds
 */
export function refreshTickMs(config) {
  return Math.min(
    gladysPollFrequency(config.departures_poll_frequency),
    gladysPollFrequency(config.velov_poll_frequency),
    gladysPollFrequency(config.park_and_ride_poll_frequency),
  );
}

/**
 * Refresh every device the user created, once.
 *
 * `gladys.devices` is the SDK's own cache of the devices created out of this
 * integration's discoveries: it is resynchronized on every (re)connection and
 * updated by the device-created/updated/deleted events, so the loop never
 * reads a feed for a device nobody added.
 *
 * A device that fails is logged and the loop moves on: one unreachable feed
 * must not stop the others from refreshing.
 *
 * @param {object} gladys
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export async function refreshCreatedDevices(gladys, config) {
  if (refreshing) {
    logger.debug('Refresh skipped: the previous one is still running');
    return;
  }
  refreshing = true;
  try {
    for (const device of gladys.devices ?? []) {
      try {
        await pollDevice(gladys, device, config);
      } catch (err) {
        logger.warn(`Refreshing ${device.external_id} failed: ${err.message}`);
      }
    }
  } finally {
    refreshing = false;
  }
}

/**
 * Start (or restart) the internal ticker.
 *
 * The configuration is read through a getter rather than captured, because it
 * is hot-reloaded: a loop holding the configuration it was started with would
 * keep watching the previous list of stops.
 *
 * The first refresh is immediate: a container that just started is the moment
 * a device created long ago is the most likely to be showing nothing, and
 * waiting a whole tick to fill it in would be waiting for no reason.
 *
 * @param {object} gladys
 * @param {() => ReturnType<import('../config.js').normalizeConfig>} getConfig
 */
export function startRefreshLoop(gladys, getConfig) {
  stopRefreshLoop();
  const intervalMs = refreshTickMs(getConfig());
  logger.debug(`Internal refresh loop started, ticking every ${intervalMs} ms`);
  timer = setInterval(() => {
    refreshCreatedDevices(gladys, getConfig()).catch((err) =>
      logger.warn(`Refresh loop tick failed: ${err.message}`),
    );
  }, intervalMs);
  refreshCreatedDevices(gladys, getConfig()).catch((err) =>
    logger.warn(`First refresh failed: ${err.message}`),
  );
}

/**
 * Stop the internal ticker (disconnection, shutdown, and tests).
 *
 * Reading the feeds while Gladys is unreachable would only throw away the
 * result, and the reconnection restarts the loop.
 */
export function stopRefreshLoop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
