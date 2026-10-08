// -----------------------------------------------------------------------------
// The last reading of each device, shared between the poll and the widgets.
//
// A dashboard pulls a widget every time it is shown, and every card used to
// read its feed afresh: three family members opening the dashboard, or one
// tablet left on it, cost a Data Grand Lyon request each — on top of the poll
// that had just read the very same stop. The departures are the costly case:
// unlike the park & ride and Vélo'v feeds, they are filtered per stop and have
// no feed-level cache to absorb the burst.
//
// So the poll leaves its reading here, and a widget takes it while it is
// younger than the card's own lifetime on the dashboard (`ttl_seconds`): the
// core would have served a card that old anyway. Past that, the widget reads
// again, and the widgets asking at the same moment share that one read.
//
// The scene actions do not go through here: they promise a fresh read.
// -----------------------------------------------------------------------------

/** @type {Map<string, { reading: unknown, at: number }>} per blueprint key. */
const latest = new Map();

/** @type {Map<string, Promise<unknown>>} reads in flight, per blueprint key. */
const inFlight = new Map();

/**
 * Remember what a read of a device returned.
 * @param {string} key the blueprint key
 * @param {unknown} reading
 * @param {number} [now] injectable clock, for tests
 */
export function recordReading(key, reading, now = Date.now()) {
  latest.set(key, { reading, at: now });
}

/**
 * The reading of a device no older than `maxAgeMs`: the last one when it is
 * recent enough, else the read already in flight, else a new read.
 *
 * @param {{ key: string, read: (config: object) => Promise<unknown> }} blueprint
 * @param {object} config
 * @param {{ maxAgeMs: number, now?: number }} options
 * @returns {Promise<unknown>}
 */
export function sharedReading(blueprint, config, { maxAgeMs, now = Date.now() }) {
  const last = latest.get(blueprint.key);
  if (last && now - last.at < maxAgeMs) {
    return Promise.resolve(last.reading);
  }
  const pending = inFlight.get(blueprint.key);
  if (pending) {
    return pending;
  }
  const promise = Promise.resolve()
    .then(() => blueprint.read(config))
    .then((reading) => {
      recordReading(blueprint.key, reading);
      return reading;
    })
    .finally(() => {
      if (inFlight.get(blueprint.key) === promise) {
        inFlight.delete(blueprint.key);
      }
    });
  inFlight.set(blueprint.key, promise);
  return promise;
}

/**
 * Forget every reading (configuration change, and tests): a stop whose line
 * filter just changed must not show the board of the previous filter.
 */
export function clearReadings() {
  latest.clear();
  inFlight.clear();
}
