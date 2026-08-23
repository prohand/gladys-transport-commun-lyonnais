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
import { fetchParkAndRideFacilities, searchStops } from '../api/tcl.js';
import { searchStations } from '../api/velov.js';
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
 * Handlers of the manifest actions (the buttons of the Configuration screen).
 *
 * The three "search" actions exist because the hard part of setting this
 * integration up is finding the identifiers: they let the user look a stop or
 * a station up from inside Gladys, and paste the answer into the watch lists.
 */
export const ACTIONS = {
  /**
   * Check that the Data Grand Lyon credentials work, by reading the park &
   * ride layer (small, and covers one of the two TCL features).
   */
  async test_grandlyon(gladys, { config }) {
    if (!hasGrandLyonCredentials(config)) {
      return {
        en: 'No Data Grand Lyon credentials: fill in the username and password above.',
        fr: 'Identifiants Data Grand Lyon absents : renseignez le nom d’utilisateur et le mot de passe ci-dessus.',
      };
    }
    const facilities = await fetchParkAndRideFacilities(config);
    // The map is keyed by id AND by name, hence the halving.
    const count = Math.round(facilities.size / 2);
    return {
      en: `Data Grand Lyon OK: ${count} park & ride facilities reachable.`,
      fr: `Data Grand Lyon OK : ${count} parcs relais accessibles.`,
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

  /** List every park & ride facility with its id, capacity and free spaces. */
  async list_park_and_ride(gladys, { config }) {
    const facilities = await fetchParkAndRideFacilities(config);

    const seen = new Set();
    const lines = [];
    for (const facility of facilities.values()) {
      if (seen.has(facility.id)) {
        continue;
      }
      seen.add(facility.id);
      lines.push(
        `${facility.id} — ${facility.name} (${facility.available ?? '?'}/${facility.capacity ?? '?'} free)`,
      );
    }

    if (lines.length === 0) {
      return { en: 'No park & ride returned.', fr: 'Aucun parc relais retourné.' };
    }
    return {
      en: `Paste one of these ids in "Park & ride":\n${lines.join('\n')}`,
      fr: `Collez un de ces identifiants dans "Parcs relais" :\n${lines.join('\n')}`,
    };
  },
};
