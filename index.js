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
import { ACTIONS, buildDiscoveredDevices, pollDevice } from './src/devices/index.js';
import { clearPollSchedule } from './src/devices/pollSchedule.js';
import { clearStateCache } from './src/devices/stateCache.js';
import { startRefreshLoop, stopRefreshLoop } from './src/devices/refreshLoop.js';
import { clearLayerResolution } from './src/api/grandlyon.js';
import { clearTclCache } from './src/api/tcl.js';
import { clearVelovCache } from './src/api/velov.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing the configured stops, stations and car parks');
  await publishDevices();
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// Every device of this integration is read-only and refreshed here. The core
// scheduler ticks at the `poll_frequency` the device was published with (one
// minute at the slowest, which is all Gladys offers); `pollDevice` routes the
// tick to the right blueprint and drops the ones that fall inside the
// configured refresh interval. The container also ticks on its own (see
// src/devices/refreshLoop.js) for the devices Gladys does not know it has to
// poll; both paths go through the same gate, so the feed is read once.
gladys.onPoll(async (device) => {
  await pollDevice(gladys, device, config);
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
  // previous configuration is now suspect, including which layer name answered
  // under the previous base URL.
  clearLayerResolution();
  clearTclCache();
  clearVelovCache();
  // A refresh interval that just changed must apply on the next tick, not
  // after the old one has elapsed.
  clearPollSchedule();
  // The watch lists may have changed: the values remembered as "already
  // published" belong to devices that may no longer be the same ones, and a
  // full republication is one request.
  clearStateCache();
  // Re-publish the devices: the watch lists and the poll frequencies live in
  // the configuration. publishDiscoveredDevices is idempotent (upsert by
  // external_id).
  await publishDevices();
  await reportConnectionStatus();
  // The internal ticker derives its period from the refresh intervals, and it
  // is holding the previous ones: restart it on the new configuration.
  startRefreshLoop(gladys, () => config);
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK itself logs the WebSocket lifecycle (connections, disconnections,
// reconnection attempts) under the `gladys-sdk` name: no need to log it again
// here, this handler only runs the integration's own initialization.
gladys.on('connected', async () => {
  try {
    // 1) Fetch the config filled in by the user.
    config = normalizeConfig(await gladys.getConfig());

    // The de-duplication of the published states is a belief about what the
    // instance on the other end already holds, and a (re)connection is exactly
    // when that belief can be wrong: publish everything once, then only the
    // changes (see src/devices/stateCache.js).
    clearStateCache();

    // 2) Refresh the devices the user already created, now and at every tick.
    // The Gladys scheduler is the nominal path; this one is what fills in a
    // device it does not know it must poll (see src/devices/refreshLoop.js).
    // It comes before the publication on purpose: a publication that fails
    // must not leave the existing devices without anything refreshing them,
    // which is the very symptom this loop exists for.
    startRefreshLoop(gladys, () => config);

    // 3) (Re)publish all configured devices as soon as we are connected.
    await publishDevices();

    // 4) Report the application-level status, shown in the Configuration
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

// Reading the feeds while Gladys is unreachable would only throw the result
// away: the internal ticker stops here, and the next 'connected' restarts it.
gladys.on('disconnected', () => {
  stopRefreshLoop();
});

/**
 * Publish the devices described by the current configuration, and log what was
 * published by name.
 *
 * The log line is the point: "nothing in the Discovery screen" has exactly two
 * causes — a watch list Gladys never saved, and a watch list the integration
 * parsed into zero entries — and they are indistinguishable from the UI. One
 * line naming every device (or saying there are none) tells them apart without
 * having to reason about the mini-syntax of the fields.
 */
async function publishDevices() {
  const devices = buildDiscoveredDevices(gladys, config);
  logger.info(
    devices.length === 0
      ? 'No device to publish: the three watch lists of the configuration are empty'
      : `Publishing ${devices.length} device(s): ${devices.map((device) => device.name).join(', ')}`,
  );
  await gladys.publishDiscoveredDevices(devices);
}

/**
 * A short bilingual inventory of what the configuration asks for, shown next
 * to the connection status: it is how the user checks that the entry they just
 * typed was understood, without opening the container logs.
 *
 * @param {{ stops: unknown[], velovStations: unknown[], parkAndRide: unknown[] }} watched
 * @returns {{ en: string, fr: string }}
 */
function describeWatchList({ stops, velovStations, parkAndRide }) {
  const parts = [
    { count: stops.length, en: 'stop', fr: 'arrêt' },
    { count: velovStations.length, en: "Vélo'v station", fr: 'station Vélo’v' },
    { count: parkAndRide.length, en: 'park & ride', fr: 'parc relais' },
  ].filter((part) => part.count > 0);

  return {
    en: parts.map((part) => `${part.count} ${part.en}${part.count > 1 ? 's' : ''}`).join(', '),
    fr: parts.map((part) => `${part.count} ${part.fr}${part.count > 1 ? 's' : ''}`).join(', '),
  };
}

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

  // Connected AND explicit about what is being watched: a status reading
  // "1 stop" right after saving is the fastest confirmation that the watch
  // list was understood, and "0" would have been the answer to the first
  // "I pasted a stop id and the Discovery screen stayed empty" report.
  const watched = describeWatchList(config.watched);
  await gladys.setConnectionStatus(true, {
    en: `Connected. Watching ${watched.en} — they appear in the Discovery screen.`,
    fr: `Connecté. Surveille ${watched.fr} — ils apparaissent dans l’écran Découverte.`,
  });
}

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopRefreshLoop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Transports en Commun Lyonnais integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
