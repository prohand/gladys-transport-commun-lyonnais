// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device modules rely on:
//   - devices                        -> the devices the user created, as the
//                                       SDK keeps them (read by the internal
//                                       refresh loop)
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates   -> record calls so tests can assert them
//   - publishTransports              -> record calls so tests can assert them
//   - setConnectionStatus            -> record calls so tests can assert them
// This lets us test the pure "wiring" logic (discovery payloads, dispatch)
// without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const published = [];
  const transports = [];
  const connectionStatuses = [];

  return {
    published,
    transports,
    connectionStatuses,
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

    async publishTransports(entries) {
      transports.push(...entries);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };
}
