// -----------------------------------------------------------------------------
// Publishing states to the device Gladys actually created.
//
// A state is addressed to a FEATURE, by external_id, and Gladys only holds the
// features a device was created with. That is not a detail of the protocol: it
// is the one thing this container cannot fix by itself. Re-publishing a
// discovery upserts the `params` and the feature `supported_options` of an
// already-created device and nothing else — a device that gained a feature in
// a new version of the integration keeps the features it was born with until
// the user presses "Update" in the Discovery screen (or deletes and adds it
// again). The SDK offers no other path.
//
// So a state sent to a feature the device does not carry goes nowhere. That is
// the second half of the reported "sur les parcs relais je n'ai pas de
// valeurs": the release that gave the park & ride device its Total capacity
// and its Status published, for a facility nobody counts live, exactly those
// two states and nothing else — both of them to features the device created by
// the previous version did not have. The car park kept showing nothing, and
// the only line in the logs was the "no live count" warning, which says the
// feed is thin, not that the publication had nowhere to land.
//
// This module is what makes that visible and survivable:
//   - it publishes only the states the device can accept, so one unknown
//     feature never takes the whole batch down with it;
//   - it says, once, what is missing and what the user has to press;
//   - it flags the device itself in the Gladys UI (degraded transport badge),
//     because somebody whose car park shows nothing looks at the device, not
//     at the container logs;
//   - it forgets the dropped states, so the read that follows the update
//     publishes them immediately instead of waiting for the periodic
//     republication of src/devices/stateCache.js.
//
// The filtering only applies when the features of the created device are
// actually known: `gladys.devices` is resynchronized on every connection, but
// a device missing from that list, or listed without its features, must be
// published to as before — a filter that is not sure is a filter that must not
// drop anything.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { forgetStates } from './stateCache.js';

const logger = createLogger({ name: 'publish' });

/**
 * What has already been said about a device, so the explanation is logged once
 * rather than at every poll: `null` for a device seen complete, or the list of
 * the feature keys it was missing.
 *
 * @type {Map<string, string | null>}
 */
const reported = new Map();

/**
 * Whether the host accepts the per-device transport badge at all. An older
 * Gladys answers 404 on that endpoint: it is worth trying once, not once a
 * minute forever.
 */
let transportsSupported = true;

/**
 * Forget what was reported (reconnection, configuration change, tests).
 *
 * A reconnection may be a different Gladys, and a configuration change may be
 * a different device list; in both cases the state of the created devices is
 * worth looking at again.
 */
export function clearPublishReports() {
  reported.clear();
  transportsSupported = true;
}

/**
 * The features of the device the user created, or `null` when the SDK does not
 * know them — an unknown device is published to blindly, on purpose.
 *
 * @param {object} gladys
 * @param {string} deviceExternalId
 * @returns {Set<string> | null}
 */
function createdFeatures(gladys, deviceExternalId) {
  const device = (gladys.devices ?? []).find(
    (candidate) => candidate?.external_id === deviceExternalId,
  );
  if (!device || !Array.isArray(device.features) || device.features.length === 0) {
    return null;
  }
  const externalIds = new Set(
    device.features.map((feature) => feature?.external_id).filter((id) => typeof id === 'string'),
  );
  // Features listed without their external_id say nothing about what this
  // device can store: that is "unknown", not "nothing", and dropping every
  // state over it would be this module causing the silence it exists to
  // prevent.
  return externalIds.size > 0 ? externalIds : null;
}

/**
 * The readable half of a feature external_id: `ext:<selector>:<type>:<id>:<key>`
 * is the device external_id plus the feature key, and the key is the only part
 * a human needs to recognize which value is missing.
 *
 * @param {string} featureExternalId
 * @param {string} deviceExternalId
 * @returns {string}
 */
function featureKey(featureExternalId, deviceExternalId) {
  return featureExternalId.startsWith(`${deviceExternalId}:`)
    ? featureExternalId.slice(deviceExternalId.length + 1)
    : featureExternalId;
}

/**
 * Say once — and in the terms of the screen the user has to open — that a
 * device is older than the integration publishing to it.
 *
 * The count of the states that DID land matters here: a device missing one
 * feature out of five is showing stale-looking values, a device missing every
 * feature the read produced is the empty device somebody is about to report as
 * a bug.
 *
 * @param {string} deviceExternalId
 * @param {string} deviceName
 * @param {string[]} missingKeys
 * @param {number} publishedCount
 */
function reportOutdatedDevice(deviceExternalId, deviceName, missingKeys, publishedCount) {
  const signature = missingKeys.join(',');
  if (reported.get(deviceExternalId) === signature) {
    return;
  }
  reported.set(deviceExternalId, signature);

  const missing = missingKeys.join(', ');
  logger.error(
    `"${deviceName}" does not have the feature(s) ${missing} in Gladys: it was created by an ` +
      'older version of this integration, and a container cannot add a feature to a device that ' +
      'already exists. ' +
      (publishedCount === 0
        ? 'Nothing of this read could be recorded, which is why this device shows no value. '
        : `${missingKeys.length} value(s) of this read had nowhere to go. `) +
      'Open the Discovery screen of the integration and press "Update" on this device (deleting ' +
      'and adding it again works too) — the values arrive on the read that follows.',
  );
}

/**
 * The missing features as they fit in a badge tooltip: Gladys caps a transport
 * message at 200 characters per language and the SDK REFUSES a longer one, so
 * a device missing half a dozen features must not turn the badge into an
 * exception. The full list is in the log line above.
 *
 * @param {string[]} missingKeys
 * @returns {string}
 */
function shortList(missingKeys) {
  const shown = [];
  let length = 0;
  for (const key of missingKeys) {
    // 80 characters of keys leaves room for the sentence around them in both
    // languages.
    if (length + key.length > 80) {
      return `${shown.join(', ')} (+${missingKeys.length - shown.length})`;
    }
    shown.push(key);
    length += key.length + 2;
  }
  return shown.join(', ');
}

/**
 * Flag the device in the Gladys UI itself: an orange dot on its transport
 * badge, with the reason in the tooltip.
 *
 * This is the same information as the log line above, put where somebody
 * looking at a device with no value actually looks. It is best effort — an
 * older host has no such endpoint, and a badge is worth no failed poll — and
 * `degraded` is published without a message once the device is complete
 * again, which is how the core clears the dot.
 *
 * @param {object} gladys
 * @param {string} deviceExternalId
 * @param {string[]} missingKeys empty once the device carries every feature
 */
async function flagDevice(gladys, deviceExternalId, missingKeys) {
  if (!transportsSupported || typeof gladys.publishTransports !== 'function') {
    return;
  }
  // The data comes from an open-data web service: the transport is 'cloud'
  // whatever state the device is in.
  const entry = { external_id: deviceExternalId, transport: DEVICE_TRANSPORTS.CLOUD };
  if (missingKeys.length > 0) {
    entry.degraded = true;
    const missing = shortList(missingKeys);
    entry.message = {
      en: `Update this device in the Discovery screen: Gladys is missing ${missing}.`,
      fr: `Mettez cet appareil à jour dans l’écran Découverte : il manque ${missing} à Gladys.`,
    };
  }
  try {
    await gladys.publishTransports([entry]);
  } catch (err) {
    transportsSupported = false;
    logger.debug(`This Gladys does not take device transports (${err.message})`);
  }
}

/**
 * Publish the states of one device, keeping the ones Gladys can store.
 *
 * @param {object} gladys
 * @param {string} deviceExternalId the device the states belong to
 * @param {{ device_feature_external_id: string, state?: number, text?: string }[]} states
 */
export async function publishDeviceStates(gladys, deviceExternalId, states) {
  if (states.length === 0) {
    return;
  }

  const features = createdFeatures(gladys, deviceExternalId);
  if (features === null) {
    // Nothing known about this device: publishing everything is what the
    // integration did before this module existed, and it is the right answer
    // for a device the SDK simply has not listed yet.
    await gladys.publishStates(states);
    return;
  }

  const publishable = states.filter((state) => features.has(state.device_feature_external_id));
  const orphans = states.filter((state) => !features.has(state.device_feature_external_id));

  if (publishable.length > 0) {
    await gladys.publishStates(publishable);
    // What actually reached Gladys, which is the one thing the logs did not
    // say when a device stayed empty: `LOG_LEVEL=debug` now answers "was this
    // value published at all" without having to reason about the feed.
    logger.debug(
      `${deviceExternalId}: published ${publishable
        .map((state) => featureKey(state.device_feature_external_id, deviceExternalId))
        .join(', ')}`,
    );
  }

  if (orphans.length === 0) {
    // A device that used to be incomplete and is not any more: clear the badge
    // and let a future regression be reported again.
    if (reported.get(deviceExternalId)) {
      reported.set(deviceExternalId, null);
      await flagDevice(gladys, deviceExternalId, []);
    }
    return;
  }

  // Never remembered as published: they were not.
  forgetStates(orphans);

  const device = (gladys.devices ?? []).find(
    (candidate) => candidate?.external_id === deviceExternalId,
  );
  const missingKeys = orphans.map((state) =>
    featureKey(state.device_feature_external_id, deviceExternalId),
  );
  const alreadyReported = reported.get(deviceExternalId) === missingKeys.join(',');
  reportOutdatedDevice(
    deviceExternalId,
    device?.name ?? deviceExternalId,
    missingKeys,
    publishable.length,
  );
  if (!alreadyReported) {
    await flagDevice(gladys, deviceExternalId, missingKeys);
  }
}
