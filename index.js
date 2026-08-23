// -----------------------------------------------------------------------------
// Entry point of the "Transports en Commun Lyonnais" Gladys integration.
//
// Role of this file: wire the SDK to the device catalog (src/devices/). It
// holds no transport logic: reading the feeds lives in src/api/, and turning a
// feed into features lives in src/devices/. This file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects and publishes the discovered devices.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { hasGrandLyonCredentials, normalizeConfig } from './src/config.js';
import { ACTIONS, buildDiscoveredDevices, findBlueprintByDevice } from './src/devices/index.js';
import { clearTclCache } from './src/api/tcl.js';
import { clearVelovCache } from './src/api/velov.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing the configured stops, stations and car parks');
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// Every device of this integration is read-only and refreshed here, at the
// `poll_frequency` it was published with (one per data source, see
// src/config.js).
gladys.onPoll(async (device) => {
  const blueprint = findBlueprintByDevice(gladys, device, config);
  if (!blueprint) {
    // The user removed the entry from the watch list but the device still
    // exists in Gladys: nothing to read, and nothing worth erroring about.
    logger.debug(`onPoll ignored, ${device.external_id} is no longer configured`);
    return;
  }
  await blueprint.onPoll(gladys, config);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
// Each action declared in the `actions` field of the manifest is registered by
// key; the message resolved by the handler is displayed under the button.
for (const [actionKey, handler] of Object.entries(ACTIONS)) {
  gladys.onAction(actionKey, (fields) => handler(gladys, { fields, config }));
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // The credentials or the feed URL may have changed: anything cached from the
  // previous configuration is now suspect.
  clearTclCache();
  clearVelovCache();
  // Re-publish the devices: the watch lists and the poll frequencies live in
  // the configuration. publishDiscoveredDevices is idempotent (upsert by
  // external_id).
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
  await reportConnectionStatus();
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK itself logs the WebSocket lifecycle (connections, disconnections,
// reconnection attempts) under the `gladys-sdk` name: no need to log it again
// here, this handler only runs the integration's own initialization.
gladys.on('connected', async () => {
  try {
    // 1) Fetch the config filled in by the user.
    config = normalizeConfig(await gladys.getConfig());

    // 2) (Re)publish all configured devices as soon as we are connected.
    await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));

    // 3) Report the application-level status, shown in the Configuration
    // screen. Distinct from the container state machine: an integration can
    // be RUNNING and still unable to read its data source.
    await reportConnectionStatus();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

/**
 * Tell Gladys whether the integration is actually able to do its job.
 *
 * Vélo'v needs no account, so an integration watching only Vélo'v stations is
 * fully operational without credentials. The TCL feeds (departures and park &
 * ride) do need a Data Grand Lyon account: watching them without credentials
 * is the one case worth flagging in the UI.
 */
async function reportConnectionStatus() {
  const { stops, parkAndRide, velovStations } = config.watched;
  const needsCredentials = stops.length > 0 || parkAndRide.length > 0;

  if (needsCredentials && !hasGrandLyonCredentials(config)) {
    await gladys.setConnectionStatus(false, {
      en: 'Transit stops and park & ride need a Data Grand Lyon account: fill in the username and password.',
      fr: 'Les arrêts et parcs relais nécessitent un compte Data Grand Lyon : renseignez le nom d’utilisateur et le mot de passe.',
    });
    return;
  }

  if (stops.length + parkAndRide.length + velovStations.length === 0) {
    await gladys.setConnectionStatus(false, {
      en: 'Nothing to watch yet: add a transit stop, a Vélo’v station or a park & ride in the configuration.',
      fr: 'Rien à surveiller : ajoutez un arrêt, une station Vélo’v ou un parc relais dans la configuration.',
    });
    return;
  }

  await gladys.setConnectionStatus(true);
}

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Transports en Commun Lyonnais integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
