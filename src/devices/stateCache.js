// -----------------------------------------------------------------------------
// State de-duplication: publish a value only when it has actually changed.
//
// Everything this integration publishes is written down twice by Gladys: once
// in `t_device_feature.last_value`, and once more as a row of
// `t_device_feature_state` for every feature that keeps an history. The reads
// are deliberately frequent — a departure countdown is only worth anything
// while it is fresh, and the configuration allows one read every 30 seconds —
// so the values that did NOT move between two reads are what fills the
// database: a park & ride whose free spaces do not change all night still
// writes one row a minute per feature, forever, for nothing.
//
// Dropping them costs nothing: Gladys keeps the last value it was given, and a
// series recorded "one point per change" draws exactly the same chart as one
// recorded "one point per poll" — with a hundredth of the rows on a quiet
// night.
//
// The cache is trusted, but not blindly: it is the integration's belief about
// what Gladys holds, and that belief is wrong the moment a device is deleted
// and re-created (the new device starts with no value at all, and this module
// would happily keep quiet about the value it "already sent"). That is the
// "device added, nothing recorded" symptom this repository has already shipped
// once, so an unchanged value is republished anyway every REPUBLISH_AFTER_MS.
// -----------------------------------------------------------------------------

// How long an unchanged value may stay unpublished. Short enough that a device
// the user just re-created fills in while they are still looking at it, long
// enough that a still feature writes 96 rows a day instead of 2880.
const REPUBLISH_AFTER_MS = 15 * 60_000;

/** @type {Map<string, { signature: string, at: number }>} per feature external_id. */
const published = new Map();

/**
 * What identifies a published value. Both fields are part of it: a feature
 * publishes either `state` (a number) or `text`, and the SDK sends whichever
 * the caller filled in.
 *
 * @param {{ state?: unknown, text?: unknown }} state
 * @returns {string}
 */
function signatureOf(state) {
  return JSON.stringify([state.state ?? null, state.text ?? null]);
}

/**
 * Keep, out of the states a poll produced, the ones worth sending to Gladys.
 *
 * The states that are dropped are remembered as published: they were already
 * sent, and their timestamp is what makes the periodic republication above a
 * refresh rather than a reset.
 *
 * @param {{ device_feature_external_id: string, state?: unknown, text?: unknown }[]} states
 * @param {number} [now] injectable clock, for tests
 * @returns {typeof states} the subset to publish, possibly empty
 */
export function changedStates(states, now = Date.now()) {
  const worthPublishing = [];

  for (const state of states) {
    const key = state.device_feature_external_id;
    const signature = signatureOf(state);
    const previous = published.get(key);

    if (previous && previous.signature === signature && now - previous.at < REPUBLISH_AFTER_MS) {
      continue;
    }

    published.set(key, { signature, at: now });
    worthPublishing.push(state);
  }

  return worthPublishing;
}

/**
 * Forget a few published values, so the next read publishes them again.
 *
 * This is what a state that never reached Gladys needs: `changedStates` has
 * already written it down as published, and believing that would keep the
 * value out of the next fifteen minutes of reads. The one caller is the
 * publication path, when Gladys turns out not to hold the feature the state
 * was meant for (see src/devices/publish.js) — the value is not published, so
 * it is not remembered either, and the read that follows the user's fix fills
 * the feature in immediately.
 *
 * @param {{ device_feature_external_id: string }[]} states
 */
export function forgetStates(states) {
  for (const state of states) {
    published.delete(state.device_feature_external_id);
  }
}

/**
 * Forget every published value (configuration change, reconnection, tests).
 *
 * A reconnection is the moment the assumption behind this cache is the least
 * safe — the Gladys instance on the other end may not be the one the values
 * were sent to — and republishing a handful of states costs one request.
 */
export function clearStateCache() {
  published.clear();
}
