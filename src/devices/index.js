// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike the official template, the device list here is NOT static: it is a
// function of the configuration. The user tells the integration which stops,
// Vélo'v stations and park & ride facilities to watch, and one device is built
// per entry.
//
// Each blueprint (see the three modules of this folder) exposes:
//   - key                        : short identifier, used in logs
//   - deviceExternalId(gladys)   : the device external_id, used for dispatch
//   - buildDevice(gladys, config): the discovery payload sent to Gladys
//   - onPoll(gladys, config)     : periodic read, publishes the states
//
// Nothing here is controllable: TCL data is read-only, so no blueprint
// implements onSetValue.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { createTransitStopBlueprint } from './transitStop.js';
import { createVelovStationBlueprint } from './velovStation.js';
import { createParkAndRideBlueprint } from './parkAndRide.js';
import { dueForRead } from './pollSchedule.js';
import { checkDatasets, listParkAndRideFacilities, searchStops } from '../api/tcl.js';
import { searchStations } from '../api/velov.js';
import { GrandLyonError } from '../api/grandlyon.js';
import { hasGrandLyonCredentials } from '../config.js';

const logger = createLogger({ name: 'devices' });

/**
 * Build every blueprint described by the configuration.
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @returns {ReturnType<typeof createTransitStopBlueprint>[]}
 */
export function buildBlueprints(config) {
  const { stops, velovStations, parkAndRide } = config.watched;

  const blueprints = [
    ...stops.map(createTransitStopBlueprint),
    ...velovStations.map(createVelovStationBlueprint),
    ...parkAndRide.map(createParkAndRideBlueprint),
  ];

  logger.debug(
    `Configuration -> ${stops.length} stop(s), ${velovStations.length} Vélo'v station(s), ` +
      `${parkAndRide.length} park & ride facility(ies)`,
  );

  return blueprints;
}

/**
 * Build the discovery payload for Gladys (all configured devices).
 * @param {object} gladys
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function buildDiscoveredDevices(gladys, config) {
  return buildBlueprints(config).map((blueprint) => blueprint.buildDevice(gladys, config));
}

/**
 * Find the blueprint owning a device, from its external_id (used to route
 * onPoll to the right stop / station / car park).
 * @param {object} gladys
 * @param {{ external_id: string }} device
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function findBlueprintByDevice(gladys, device, config) {
  return buildBlueprints(config).find(
    (blueprint) => blueprint.deviceExternalId(gladys) === device.external_id,
  );
}

/**
 * Handle one `device.poll` from the Gladys scheduler: route it to the
 * blueprint owning the device, and skip the ticks that arrive before the
 * configured refresh interval has elapsed.
 *
 * The skipping is what keeps the "Refresh intervals" section of the
 * configuration meaningful: the core scheduler tops out at one tick a minute
 * (see `gladysPollFrequency`), so without it, a park & ride configured to
 * refresh every 5 minutes would be read from the platform every minute.
 *
 * @param {object} gladys
 * @param {{ external_id: string }} device
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export async function pollDevice(gladys, device, config) {
  const blueprint = findBlueprintByDevice(gladys, device, config);
  if (!blueprint) {
    // The user removed the entry from the watch list but the device still
    // exists in Gladys: nothing to read, and nothing worth erroring about.
    logger.debug(`onPoll ignored, ${device.external_id} is no longer configured`);
    return;
  }
  if (!dueForRead(blueprint.key, blueprint.pollIntervalMs(config))) {
    logger.debug(`onPoll skipped, ${blueprint.key} was refreshed less than an interval ago`);
    return;
  }
  await blueprint.onPoll(gladys, config);
}

/**
 * Handlers of the manifest actions (the buttons of the Configuration screen).
 *
 * The three "search" actions exist because the hard part of setting this
 * integration up is finding the identifiers: they let the user look a stop or
 * a station up from inside Gladys, and paste the answer into the watch lists.
 */
const RAW_ACTIONS = {
  /**
   * Check that the Data Grand Lyon credentials work, and report which of the
   * three TCL datasets the account can actually read.
   *
   * It used to read the park & ride layer only, which conflates two very
   * different answers: "your password is refused" and "this one dataset was
   * retired". The second one made the button report a failure to a user whose
   * account, departures and stop searches were all fine, and sent them looking
   * for a dataset name instead. Each dataset is now probed on its own, and a
   * refused account is still reported as such by the wrapper below — it is the
   * one error `checkDatasets` propagates.
   */
  async test_grandlyon(gladys, { config }) {
    if (!hasGrandLyonCredentials(config)) {
      return {
        en: 'No Data Grand Lyon credentials: fill in the username and password above.',
        fr: 'Identifiants Data Grand Lyon absents : renseignez le nom d’utilisateur et le mot de passe ci-dessus.',
      };
    }

    const datasets = await checkDatasets(config);
    const reachable = datasets.filter((dataset) => dataset.ok);
    // Reaching this point at all means the platform authenticated the
    // request: it answers 401 before it answers anything else. Saying so is
    // the point of the button, and it is what a 404 on one dataset must not
    // hide.
    const summary = {
      en:
        reachable.length === datasets.length
          ? 'Data Grand Lyon OK: your account works and every dataset is readable.'
          : `Data Grand Lyon accepted your account, but ${datasets.length - reachable.length} of ` +
            `its ${datasets.length} datasets could not be read.`,
      fr:
        reachable.length === datasets.length
          ? 'Data Grand Lyon OK : votre compte fonctionne et tous les jeux de données sont lisibles.'
          : `Data Grand Lyon a accepté votre compte, mais ${datasets.length - reachable.length} ` +
            `de ses ${datasets.length} jeux de données n’ont pas pu être lus.`,
    };

    const lines = datasets.map((dataset) => ({
      en: dataset.ok
        ? `✔ ${dataset.label.en} (${dataset.layer})`
        : `✖ ${dataset.label.en}: ${describeFailure(dataset.error).en}`,
      fr: dataset.ok
        ? `✔ ${dataset.label.fr} (${dataset.layer})`
        : `✖ ${dataset.label.fr} : ${describeFailure(dataset.error).fr}`,
    }));

    return {
      en: [summary.en, ...lines.map((line) => line.en)].join('\n'),
      fr: [summary.fr, ...lines.map((line) => line.fr)].join('\n'),
    };
  },

  /** Search a TCL stop point by name and show the ids to paste. */
  async search_stops(gladys, { fields, config }) {
    const query = String(fields.query ?? '').trim();
    if (query.length < 2) {
      return { en: 'Type at least 2 characters.', fr: 'Saisissez au moins 2 caractères.' };
    }
    const results = await searchStops(config, query);
    if (results.length === 0) {
      return { en: `No stop matches "${query}".`, fr: `Aucun arrêt ne correspond à "${query}".` };
    }
    const list = results.map((stop) => `${stop.id} — ${stop.name}`).join('\n');
    return {
      en: `Paste one of these ids in "Transit stops":\n${list}`,
      fr: `Collez un de ces identifiants dans "Arrêts" :\n${list}`,
    };
  },

  /** Search a Vélo'v station by name and show the ids to paste. */
  async search_velov_stations(gladys, { fields, config }) {
    const query = String(fields.query ?? '').trim();
    if (query.length < 2) {
      return { en: 'Type at least 2 characters.', fr: 'Saisissez au moins 2 caractères.' };
    }
    const results = await searchStations(config, query);
    if (results.length === 0) {
      return {
        en: `No Vélo'v station matches "${query}".`,
        fr: `Aucune station Vélo'v ne correspond à "${query}".`,
      };
    }
    const list = results
      .map((station) => `${station.id} — ${station.name} (${station.capacity ?? '?'} stands)`)
      .join('\n');
    return {
      en: `Paste one of these ids in "Vélo'v stations":\n${list}`,
      fr: `Collez un de ces identifiants dans "Stations Vélo'v" :\n${list}`,
    };
  },

  /**
   * List every park & ride facility with its id, capacity and free spaces.
   *
   * "The list is incomplete" is the bug this reads two layers for: the
   * real-time layer only holds the facilities SYTRAL counts live, and it is
   * the one the integration used to list. The inventory comes from the static
   * layer instead (see `listParkAndRideFacilities`), so a car park with no
   * live counting is still offered — with a "?" where its free spaces would
   * be, which is the honest answer rather than a missing line.
   */
  async list_park_and_ride(gladys, { config }) {
    const facilities = await listParkAndRideFacilities(config);

    if (facilities.length === 0) {
      return { en: 'No park & ride returned.', fr: 'Aucun parc relais retourné.' };
    }

    const lines = facilities.map(
      (facility) =>
        `${facility.id} — ${facility.name} (${facility.available ?? '?'}/${facility.capacity ?? '?'} free)`,
    );
    const withoutLiveCount = facilities.filter(
      (facility) => !Number.isFinite(facility.available),
    ).length;
    const note = {
      en:
        withoutLiveCount > 0
          ? `\n(${withoutLiveCount} of them publish no live count: "?" free spaces.)`
          : '',
      fr:
        withoutLiveCount > 0
          ? `\n(${withoutLiveCount} d’entre eux ne publient pas de comptage temps réel : « ? » places libres.)`
          : '',
    };

    return {
      en: `${facilities.length} park & ride facilities. Paste one of these ids in "Park & ride":\n${lines.join('\n')}${note.en}`,
      fr: `${facilities.length} parcs relais. Collez un de ces identifiants dans "Parcs relais" :\n${lines.join('\n')}${note.fr}`,
    };
  },
};

/**
 * One line explaining why a dataset probe failed, short enough to sit under a
 * button next to two other ones.
 *
 * @param {Error | undefined} error
 * @returns {{ en: string, fr: string }}
 */
function describeFailure(error) {
  if (error instanceof GrandLyonError && error.status === 404) {
    // The names the platform serves around the dataset are the only actionable
    // part of a 404: they say whether the dataset was renamed (report those
    // names) or genuinely retired (nothing to report). Showing "please report
    // it" with nothing to report is what sent the first user who hit this
    // looking for a dataset name on their own.
    const closest = error.published.slice(0, 3).join(', ');
    if (closest) {
      return {
        en: `not published under any name this integration knows; the platform serves ${closest} — please report it`,
        fr: `publié sous aucun nom connu de l’intégration ; la plateforme sert ${closest} — merci de le signaler`,
      };
    }
    return {
      en: 'not published under any name this integration knows — please report it',
      fr: 'publié sous aucun nom connu de l’intégration — merci de le signaler',
    };
  }
  return { en: error?.message ?? 'unreadable', fr: error?.message ?? 'illisible' };
}

/**
 * Handlers of the manifest actions, with the Data Grand Lyon failures turned
 * into something the user can act on.
 *
 * An action that throws shows the raw error under the button, which for the
 * most common failure — the platform refusing the credentials — is a bare
 * "HTTP 401" the user cannot do anything with. `GrandLyonError` carries the
 * bilingual explanation instead (see src/api/grandlyon.js), so display it and
 * let anything else bubble up as a genuine bug.
 */
export const ACTIONS = Object.fromEntries(
  Object.entries(RAW_ACTIONS).map(([key, handler]) => [
    key,
    async (gladys, context) => {
      try {
        return await handler(gladys, context);
      } catch (err) {
        if (err instanceof GrandLyonError && err.userMessage) {
          logger.warn(`Action ${key} failed: ${err.message}`);
          return err.userMessage;
        }
        throw err;
      }
    },
  ]),
);
