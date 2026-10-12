// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device modules rely on:
//   - devices                        -> the devices the user created, as the
//                                       SDK keeps them (read by the internal
//                                       refresh loop)
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates   -> record calls so tests can assert them
//   - publishChangedStates / forgetPublishedStates -> the SDK 0.15
//                                       deduplication, reproduced in memory
//   - publishTransports              -> record calls so tests can assert them
//   - setConnectionStatus            -> record calls so tests can assert them
//   - publishSceneEvent              -> record calls so tests can assert them
// This lets us test the pure "wiring" logic (discovery payloads, dispatch)
// without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const published = [];
  const transports = [];
  const connectionStatuses = [];
  const sceneEvents = [];
  // Last value Gladys accepted per feature, as the SDK remembers it.
  const publishedStates = new Map();

  return {
    published,
    transports,
    connectionStatuses,
    sceneEvents,
    publishedStates,
    // The SDK resynchronizes this list on every connection and keeps it up to
    // date with the device-created/updated/deleted events; tests fill it in
    // with the devices they pretend the user created.
    devices: [],

    externalIds(type, platformId) {
      const device = `${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const s of states) {
        // Text features publish `text` instead of `state`: record both, the
        // tests read whichever the feature under test uses.
        published.push({
          featureExternalId: s.device_feature_external_id,
          state: s.state,
          text: s.text,
        });
      }
    },

    // Same rules as the SDK method: an entry equal (same state, same text) to
    // the last value ACCEPTED for its feature is skipped, within the call too;
    // `heartbeat` re-sends an unchanged value that old; a value is remembered
    // only if publishStates (overridable by a test) accepted it.
    async publishChangedStates(states, { heartbeat } = {}) {
      const now = Date.now();
      const previous = new Map();
      const changed = states.filter(({ device_feature_external_id: id, state, text }) => {
        const last = previous.has(id) ? previous.get(id) : publishedStates.get(id);
        previous.set(id, { state, text, at: now });
        return (
          last === undefined ||
          last.state !== state ||
          last.text !== text ||
          (heartbeat !== undefined && now - last.at >= heartbeat)
        );
      });
      for (let start = 0; start < changed.length; start += 100) {
        const batch = changed.slice(start, start + 100);
        batch.forEach(({ device_feature_external_id: id, state, text }) =>
          publishedStates.set(id, { state, text, at: now }),
        );
        try {
          await this.publishStates(batch);
        } catch (err) {
          batch.forEach(({ device_feature_external_id: id }) => publishedStates.delete(id));
          throw err;
        }
      }
      return { success: true, count: changed.length };
    },

    // The SDK also calls it itself when Gladys creates, updates or deletes a
    // device; a test plays that part by calling it.
    forgetPublishedStates(externalId) {
      if (externalId === undefined) {
        publishedStates.clear();
        return;
      }
      for (const id of [...publishedStates.keys()]) {
        if (id === externalId || id.startsWith(`${externalId}:`)) {
          publishedStates.delete(id);
        }
      }
    },

    async publishTransports(entries) {
      transports.push(...entries);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },

    async publishSceneEvent(key, data) {
      sceneEvents.push({ key, data });
    },
  };
}
