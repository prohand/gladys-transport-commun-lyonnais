// -----------------------------------------------------------------------------
// Read scheduling, on top of the Gladys poll scheduler.
//
// Gladys polls a device at one of the intervals its own scheduler knows
// (`DEVICE_POLL_FREQUENCIES`: 1 s to 60 s, no slower), while the configuration
// of this integration talks in refresh intervals of up to an hour — five
// minutes for a park & ride is the default, and it is the right value: the
// occupancy of a car park does not move every minute, and every read costs a
// request on an account-protected open data platform.
//
// The two are reconciled here rather than by lying to one of them: a device is
// published with the fastest tick that fits under its configured interval (see
// `gladysPollFrequency`), and the ticks arriving before the interval has
// elapsed are dropped. A park & ride watched every 5 minutes is therefore
// ticked sixty times an hour by the core and read twelve: four ticks out of
// five return without touching the network.
// -----------------------------------------------------------------------------

/** @type {Map<string, number>} last read timestamp, per device key. */
const lastReads = new Map();

// A tick is never perfectly on time: the core fires its scheduler on a timer
// and the read itself takes a moment, so the elapsed time between two ticks
// drifts a few milliseconds under the nominal interval. Requiring the full
// interval would then need one EXTRA tick — a 120 s refresh polled on a 60 s
// tick would land at 180 s — so a tick that is within a tenth of the interval
// counts as due.
const TOLERANCE_RATIO = 0.9;

/**
 * Whether a device is due for an upstream read, and remember that it is.
 *
 * The tick is consumed here, before the read: a read that then fails is not
 * retried on the next tick, it waits for the next interval like a successful
 * one. Retrying a failing source faster than a working one is how an outage
 * upstream turns into a burst of requests against it.
 *
 * @param {string} key stable device key (the blueprint key)
 * @param {number} intervalMs configured refresh interval, in milliseconds
 * @param {number} [now] injectable clock, for tests
 * @returns {boolean} true when the caller must read, false to skip this tick
 */
export function dueForRead(key, intervalMs, now = Date.now()) {
  const last = lastReads.get(key);
  if (last !== undefined && now - last < intervalMs * TOLERANCE_RATIO) {
    return false;
  }
  lastReads.set(key, now);
  return true;
}

/**
 * Forget every scheduled read (config change, and tests).
 *
 * A configuration change must take effect on the next tick: keeping the
 * timestamps would make a user who just lowered "every 5 minutes" to "every
 * minute" wait out the old interval, and wonder whether the change was saved.
 */
export function clearPollSchedule() {
  lastReads.clear();
}
