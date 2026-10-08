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
 * The tick is consumed here, before the read, so that two tickers asking at
 * once (the core scheduler and the internal loop) read once. A read that then
 * fails calls `readFailed`, which brings the next attempt forward — but never
 * closer than RETRY_AFTER_FAILURE_MS (see there).
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

// How soon a failed read is attempted again. Without it, a park & ride read
// every 5 minutes that hit one timeout showed its previous value for five
// more minutes, ten in all. One minute is the slowest tick the core itself
// uses, so a failing source is never asked more often than a working one
// configured at the slowest Gladys frequency — retrying faster than that is
// how an upstream outage turns into a burst of requests against it. An
// interval already shorter than this is simply kept.
export const RETRY_AFTER_FAILURE_MS = 60_000;

/**
 * Bring the next read of a device forward after a failed one.
 *
 * @param {string} key stable device key (the blueprint key)
 * @param {number} intervalMs configured refresh interval, in milliseconds
 * @param {number} [now] injectable clock, for tests
 */
export function readFailed(key, intervalMs, now = Date.now()) {
  // Back-date the read so that `dueForRead` says yes RETRY_AFTER_FAILURE_MS
  // from now (with the same tolerance as a regular tick), or after the
  // regular interval when that one is shorter.
  const head = Math.max(0, (intervalMs - RETRY_AFTER_FAILURE_MS) * TOLERANCE_RATIO);
  lastReads.set(key, now - head);
}

/**
 * Forget when one device was read, so its next tick reads it.
 *
 * The device the user just created (or updated from the Discovery screen) is
 * the one they are looking at: it is read straight away, not after whatever
 * remains of an interval started before it existed.
 *
 * @param {string} key stable device key (the blueprint key)
 */
export function forgetRead(key) {
  lastReads.delete(key);
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
