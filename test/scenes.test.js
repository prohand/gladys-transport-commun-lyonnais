// -----------------------------------------------------------------------------
// Scene triggers and scene actions (Gladys >= 5.1).
//
// The transitions are pure functions and tested as such; the wiring (the poll
// that fires the events, the actions that read the feed) goes through the real
// device code and HTTP clients, with `fetch` stubbed.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';
import { normalizeConfig } from '../src/config.js';
import { buildDiscoveredDevices, findBlueprintByDevice, pollDevice } from '../src/devices/index.js';
import { clearPollSchedule } from '../src/devices/pollSchedule.js';
import { clearStateCache } from '../src/devices/stateCache.js';
import { clearPublishReports } from '../src/devices/publish.js';
import { clearTclCache } from '../src/api/tcl.js';
import { clearVelovCache } from '../src/api/velov.js';
import { clearLayerResolution } from '../src/api/grandlyon.js';
import {
  clearSceneMemory,
  departureCrossings,
  parkAndRideEvents,
  SCENE_TRIGGERS,
  sceneEventsBetween,
  velovStationEvents,
} from '../src/scenes/triggers.js';
import { SCENE_ACTIONS } from '../src/scenes/actions.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

/** The output keys the manifest declares for one scene action. */
const declaredOutputs = (key) =>
  manifest.scene_actions
    .find((action) => action.key === key)
    .outputs.map((output) => output.key)
    .sort();

const CONFIG = normalizeConfig({
  grandlyon_username: 'user',
  grandlyon_password: 'secret',
  stops: '1234:Bellecour',
  velov_stations: '10063:Bellecour',
  park_and_ride: 'PR1:Gorge de Loup',
  max_departures: 2,
});

beforeEach(() => {
  clearPollSchedule();
  clearTclCache();
  clearVelovCache();
  clearLayerResolution();
  clearStateCache();
  clearPublishReports();
  clearSceneMemory();
});

afterEach(() => {
  restoreFetch();
});

const departure = (line, direction, minutes, realtime = true) => ({
  line,
  direction,
  minutes,
  realtime,
});

/** The GBFS routes of one station, with the given live counters. */
function velovRoutes(status) {
  return {
    'gbfs.json': {
      data: {
        feeds: [
          { name: 'station_information', url: 'https://feed.test/station_information.json' },
          { name: 'station_status', url: 'https://feed.test/station_status.json' },
        ],
      },
    },
    station_information: {
      data: { stations: [{ station_id: '10063', name: 'Bellecour', capacity: 20 }] },
    },
    station_status: { data: { stations: [{ station_id: '10063', ...status }] } },
  };
}

/** The two park & ride layers, holding one facility with `free` spaces. */
function parkAndRideRoutes(free) {
  return {
    tclparcrelaistr: {
      values: [{ id: 'PR1', nom: 'Gorge de Loup', capacite: 400, nb_tot_place_dispo: free }],
    },
    tclparcrelaisst: { values: [{ id: 'PR1', nom: 'Gorge de Loup', capacite: 400 }] },
  };
}

// --- Transitions -------------------------------------------------------------

test('a departure crossing a mark fires once for that mark', () => {
  const crossings = departureCrossings(
    [departure('T1', 'IUT Feyssine', 6)],
    [departure('T1', 'IUT Feyssine', 5)],
  );
  assert.deepEqual(
    crossings.map(({ threshold }) => threshold),
    [5],
  );
});

test('a board read rarely fires every mark it jumped over', () => {
  // Read every five minutes, a countdown goes from 11 to 4: a scene waiting
  // for "10" is as entitled to run as one waiting for "5".
  const crossings = departureCrossings(
    [departure('T1', 'IUT Feyssine', 11)],
    [departure('T1', 'IUT Feyssine', 4)],
  );
  assert.deepEqual(
    crossings.map(({ threshold }) => threshold),
    [5, 10],
  );
});

test('the next vehicle taking the place of the one that left is not an approach', () => {
  const crossings = departureCrossings(
    [departure('T1', 'IUT Feyssine', 0), departure('T1', 'IUT Feyssine', 9)],
    [departure('T1', 'IUT Feyssine', 8)],
  );
  assert.deepEqual(crossings, []);
});

test('each line and direction of a stop is followed on its own', () => {
  const crossings = departureCrossings(
    [departure('T1', 'IUT Feyssine', 4), departure('T1', 'Debourg', 3)],
    [departure('T1', 'IUT Feyssine', 3), departure('T1', 'Debourg', 2)],
  );
  assert.deepEqual(
    crossings.map(({ departure: { direction }, threshold }) => `${direction} ${threshold}`),
    ['IUT Feyssine 3', 'Debourg 2'],
  );
});

test('a line appearing on the board close by is not an approach', () => {
  // The realtime feed drops a vehicle and picks it back up: nothing approached.
  assert.deepEqual(departureCrossings([], [departure('C3', 'Vaulx', 2)]), []);
});

test('a Vélo’v station reports its bikes and docks running out and coming back', () => {
  assert.deepEqual(velovStationEvents({ bikes: 1, docks: 19 }, { bikes: 0, docks: 20 }), [
    'no_bike',
  ]);
  assert.deepEqual(velovStationEvents({ bikes: 0, docks: 20 }, { bikes: 2, docks: 18 }), [
    'bikes_back',
  ]);
  assert.deepEqual(velovStationEvents({ bikes: 19, docks: 1 }, { bikes: 20, docks: 0 }), [
    'no_dock',
  ]);
  assert.deepEqual(velovStationEvents({ bikes: 20, docks: 0 }, { bikes: 19, docks: 1 }), [
    'docks_back',
  ]);
  assert.deepEqual(
    velovStationEvents({ bikes: 3, installed: true }, { bikes: 3, installed: false }),
    ['out_of_service'],
  );
});

test('a count the feed did not send is not a station that emptied', () => {
  assert.deepEqual(velovStationEvents({ bikes: 4 }, { bikes: undefined }), []);
});

test('a car park reports filling up, being full, and freeing spaces', () => {
  assert.deepEqual(
    parkAndRideEvents({ available: 100, capacity: 400 }, { available: 30, capacity: 400 }),
    ['almost_full'],
  );
  assert.deepEqual(
    parkAndRideEvents({ available: 30, capacity: 400 }, { available: 0, capacity: 400 }),
    ['full'],
  );
  assert.deepEqual(
    parkAndRideEvents({ available: 0, capacity: 400 }, { available: 12, capacity: 400 }),
    ['spaces_back'],
  );
  // Straight from comfortable to full is "full", not also "almost full".
  assert.deepEqual(
    parkAndRideEvents({ available: 200, capacity: 400 }, { available: 0, capacity: 400 }),
    ['full'],
  );
});

test('a car park nobody counts live never fires', () => {
  assert.deepEqual(parkAndRideEvents({ capacity: 400 }, { capacity: 400 }), []);
});

test('every event carries each field and variable its trigger declares', () => {
  // The core builds the filters and the scene variables from the declared
  // keys, and a declared key absent from the data is null: a filter on it
  // would never match, a variable would always be empty.
  const gladys = createFakeGladys();
  const [stop, velov, parking] = buildDiscoveredDevices(gladys, CONFIG).map((device) =>
    findBlueprintByDevice(gladys, device, CONFIG),
  );
  const events = [
    ...sceneEventsBetween(
      stop,
      'id',
      'Bellecour',
      [departure('T1', 'A', 6)],
      [departure('T1', 'A', 5)],
    ),
    ...sceneEventsBetween(velov, 'id', 'Bellecour', { bikes: 1 }, { bikes: 0 }),
    ...sceneEventsBetween(parking, 'id', 'Gorge de Loup', { available: 1 }, { available: 0 }),
  ];
  assert.equal(events.length, manifest.scene_triggers.length);

  for (const trigger of manifest.scene_triggers) {
    const event = events.find(({ key }) => key === trigger.key);
    for (const { key } of [...trigger.fields, ...trigger.variables]) {
      assert.ok(key in event.data, `"${trigger.key}" events do not carry "${key}"`);
    }
  }
});

// --- Wiring through the poll -------------------------------------------------

test('the first read after a start fires nothing, the next transition does', async () => {
  // A container restart must not announce that every watched car park "just
  // became full": there is no transition without a previous value.
  const gladys = createFakeGladys();
  const [, , device] = buildDiscoveredDevices(gladys, CONFIG);

  stubFetch(parkAndRideRoutes(0));
  await pollDevice(gladys, device, CONFIG);
  assert.deepEqual(gladys.sceneEvents, []);

  clearPollSchedule();
  clearTclCache();
  stubFetch(parkAndRideRoutes(25));
  await pollDevice(gladys, device, CONFIG);

  assert.equal(gladys.sceneEvents.length, 1);
  const [{ key, data }] = gladys.sceneEvents;
  assert.equal(key, SCENE_TRIGGERS.PARK_AND_RIDE_CHANGED);
  assert.deepEqual(data, {
    facility: device.external_id,
    facility_name: 'Gorge de Loup',
    event: 'spaces_back',
    available: 25,
    capacity: 400,
    occupancy: 94,
  });
});

test('a departure event names the stop device the scene filter compares', async () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, CONFIG);
  gladys.devices = [{ external_id: device.external_id, name: 'Arrêt Bellecour' }];

  const inMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
  stubFetch({
    tclpassagearret: {
      values: [{ ligne: 'T1', direction: 'IUT Feyssine', heurepassage: inMinutes(6), type: 'E' }],
    },
  });
  await pollDevice(gladys, device, CONFIG);

  clearPollSchedule();
  stubFetch({
    tclpassagearret: {
      values: [{ ligne: 'T1', direction: 'IUT Feyssine', heurepassage: inMinutes(5), type: 'E' }],
    },
  });
  await pollDevice(gladys, device, CONFIG);

  assert.deepEqual(gladys.sceneEvents, [
    {
      key: SCENE_TRIGGERS.DEPARTURE_APPROACHING,
      data: {
        stop: device.external_id,
        // The name the user gave the device in Gladys wins.
        stop_name: 'Arrêt Bellecour',
        line: 'T1',
        direction: 'IUT Feyssine',
        threshold: '5',
        minutes: 5,
        realtime: true,
      },
    },
  ]);
});

test('an event Gladys refuses does not fail the poll that computed it', async () => {
  const gladys = createFakeGladys();
  gladys.publishSceneEvent = async () => {
    throw new Error('HTTP 404');
  };
  const [, device] = buildDiscoveredDevices(gladys, CONFIG);

  stubFetch(velovRoutes({ num_bikes_available: 1, num_docks_available: 19 }));
  await pollDevice(gladys, device, CONFIG);
  clearPollSchedule();
  clearVelovCache();
  stubFetch(velovRoutes({ num_bikes_available: 0, num_docks_available: 20 }));

  await pollDevice(gladys, device, CONFIG);
  assert.ok(gladys.published.length > 0, 'the states were still published');
});

// --- Scene actions -----------------------------------------------------------

test('reading the next departures answers the soonest one of the line asked for', async () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, CONFIG);
  stubFetch({
    tclpassagearret: {
      values: [
        { ligne: 'C3', direction: 'Vaulx', delaipassage: '1 min', type: 'E' },
        { ligne: 'T1', direction: 'IUT Feyssine', delaipassage: '4 min', type: 'E' },
        { ligne: 'T1', direction: 'IUT Feyssine', delaipassage: '12 min', type: 'T' },
      ],
    },
  });

  const outputs = await SCENE_ACTIONS.get_next_departures(gladys, {
    fields: { stop: device.external_id, line: 't1' },
    config: CONFIG,
  });

  assert.deepEqual(Object.keys(outputs).sort(), declaredOutputs('get_next_departures'));
  assert.deepEqual(outputs, {
    stop_name: 'Bellecour',
    line: 'T1',
    direction: 'IUT Feyssine',
    minutes: 4,
    realtime: true,
    departure: 'T1 → IUT Feyssine',
    following_minutes: 12,
    summary: 'T1 → IUT Feyssine 4 min · ~T1 → IUT Feyssine 12 min',
    count: 2,
  });
});

test('no departure is an answer the scene can test, not an error', async () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, CONFIG);
  stubFetch({ tclpassagearret: { values: [] } });

  const outputs = await SCENE_ACTIONS.get_next_departures(gladys, {
    fields: { stop: device.external_id },
    config: CONFIG,
  });
  assert.equal(outputs.count, 0);
  assert.equal(outputs.minutes, null);
  assert.equal(outputs.summary, 'No upcoming departure');
});

test('reading a Vélo’v station answers its live counters', async () => {
  const gladys = createFakeGladys();
  const [, device] = buildDiscoveredDevices(gladys, CONFIG);
  stubFetch(
    velovRoutes({
      num_bikes_available: 5,
      num_docks_available: 15,
      vehicle_types_available: [{ vehicle_type_id: 'ebike', count: 2 }],
    }),
  );

  const outputs = await SCENE_ACTIONS.get_velov_station(gladys, {
    fields: { station: device.external_id },
    config: CONFIG,
  });
  assert.deepEqual(Object.keys(outputs).sort(), declaredOutputs('get_velov_station'));
  assert.deepEqual(outputs, {
    station_name: 'Bellecour',
    bikes: 5,
    electric_bikes: 2,
    docks: 15,
    occupancy: 25,
    status: 'OK',
  });
});

test('reading a park & ride answers its free spaces', async () => {
  const gladys = createFakeGladys();
  const [, , device] = buildDiscoveredDevices(gladys, CONFIG);
  stubFetch(parkAndRideRoutes(100));

  const outputs = await SCENE_ACTIONS.get_park_and_ride(gladys, {
    fields: { facility: device.external_id },
    config: CONFIG,
  });
  assert.deepEqual(Object.keys(outputs).sort(), declaredOutputs('get_park_and_ride'));
  assert.deepEqual(outputs, {
    facility_name: 'Gorge de Loup',
    available: 100,
    capacity: 400,
    occupancy: 75,
    status: '100/400 free',
  });
});

test('an action set up with a device of another kind says which kind it needs', async () => {
  // The device selects list every device of the integration together.
  const gladys = createFakeGladys();
  const [, velov] = buildDiscoveredDevices(gladys, CONFIG);
  await assert.rejects(
    () =>
      SCENE_ACTIONS.get_next_departures(gladys, {
        fields: { stop: velov.external_id },
        config: CONFIG,
      }),
    /Vélo'v station: choose a transit stop/,
  );
});

test('an action pointing at a device removed from the watch lists says so', async () => {
  const gladys = createFakeGladys();
  const [, , device] = buildDiscoveredDevices(gladys, CONFIG);
  const withoutParkAndRide = normalizeConfig({ ...CONFIG, park_and_ride: '' });
  await assert.rejects(
    () =>
      SCENE_ACTIONS.get_park_and_ride(gladys, {
        fields: { facility: device.external_id },
        config: withoutParkAndRide,
      }),
    /no longer in the integration configuration/,
  );
});
