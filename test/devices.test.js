// -----------------------------------------------------------------------------
// Device catalog: discovery payloads, onPoll dispatch and published states.
//
// The upstream feeds are stubbed at the `fetch` level, so these tests cover
// the real code path (HTTP client included) without touching the network.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { GLADYS_POLL_FREQUENCIES_MS, normalizeConfig } from '../src/config.js';
import { buildDiscoveredDevices, findBlueprintByDevice, pollDevice } from '../src/devices/index.js';
import { clearPollSchedule } from '../src/devices/pollSchedule.js';
import { clearStateCache } from '../src/devices/stateCache.js';
import { refreshCreatedDevices, refreshTickMs } from '../src/devices/refreshLoop.js';
import { formatDeparture, formatSummary } from '../src/devices/transitStop.js';
import { computeOccupancy as velovOccupancy, formatStatus } from '../src/devices/velovStation.js';
import { computeOccupancy as parkingOccupancy } from '../src/devices/parkAndRide.js';
import { clearTclCache } from '../src/api/tcl.js';
import { clearVelovCache } from '../src/api/velov.js';
import { clearLayerResolution } from '../src/api/grandlyon.js';
import { ACTIONS } from '../src/devices/index.js';

const CONFIG = normalizeConfig({
  grandlyon_username: 'user',
  grandlyon_password: 'secret',
  stops: '1234@T1:Tram at home',
  velov_stations: '10063:Work',
  park_and_ride: 'PR1:Commute',
  max_departures: 2,
});

const realFetch = globalThis.fetch;

/**
 * Route every outgoing request to an in-memory payload, keyed by a substring
 * of the URL. Requests to an unmapped URL fail the test loudly.
 * @param {Record<string, unknown>} routes
 */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    const match = Object.keys(routes).find((fragment) => href.includes(fragment));
    if (!match) {
      throw new Error(`Unexpected request: ${href}`);
    }
    const payload = routes[match];
    // A bare number stands for a status code with no body: that is how a
    // retired dataset answers.
    const status = typeof payload === 'number' ? payload : 200;
    // `headers` is not decoration: the Data Grand Lyon client reads the
    // Location header to follow the platform's redirects itself, so a stub
    // without headers is not a Response.
    return {
      ok: status < 400,
      status,
      headers: new Headers(),
      json: async () => payload,
    };
  };
  return calls;
}

beforeEach(() => {
  clearPollSchedule();
  clearTclCache();
  clearVelovCache();
  clearLayerResolution();
  // The states published in the previous test are remembered as sent, and a
  // test that publishes the same values again would see nothing published.
  clearStateCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('one device is published per configured entry', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, CONFIG);

  assert.equal(devices.length, 3);
  assert.deepEqual(
    devices.map((device) => device.name),
    ['Tram at home', 'Work', 'Commute'],
  );
});

test('an empty configuration publishes no device', () => {
  const gladys = createFakeGladys();
  assert.deepEqual(buildDiscoveredDevices(gladys, normalizeConfig()), []);
});

test('each device is published with a poll frequency the Gladys scheduler accepts', () => {
  // The core validates `poll_frequency` against DEVICE_POLL_FREQUENCIES (in
  // milliseconds, one minute at the slowest) and answers 400 for the WHOLE
  // batch otherwise: publishing "45" here is what left the Discovery screen
  // empty while the logs read "Publishing 3 device(s)".
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    ...CONFIG,
    departures_poll_frequency: 45,
    velov_poll_frequency: 90,
    park_and_ride_poll_frequency: 600,
  });
  const [stop, velov, parking] = buildDiscoveredDevices(gladys, config);

  assert.equal(stop.poll_frequency, 30_000);
  assert.equal(velov.poll_frequency, 60_000);
  assert.equal(parking.poll_frequency, 60_000);
  for (const device of [stop, velov, parking]) {
    assert.ok(
      GLADYS_POLL_FREQUENCIES_MS.includes(device.poll_frequency),
      `${device.name} publishes a frequency Gladys would reject`,
    );
  }
});

test('every device is published with should_poll, the flag that schedules it', () => {
  // The core inserts a device in its poll scheduler when `should_poll` is
  // true, and reads the flag from this very payload (the Discovery screen
  // posts it as is to POST /device). Publishing `poll_frequency` alone stores
  // a frequency nothing acts upon: that is the "device added, features stay
  // empty forever" report — no tick, no state, and no error anywhere.
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, CONFIG);

  assert.equal(devices.length, 3);
  for (const device of devices) {
    assert.equal(device.should_poll, true, `${device.name} would never be polled`);
  }
});

test('the internal refresh loop reads the devices the user created', async () => {
  // The devices created before `should_poll` was published are scheduled by
  // nobody, and nothing in the integration can flip the flag on them: the
  // container ticks on its own so they fill in after an update, instead of
  // having to be deleted and added again.
  const gladys = createFakeGladys();
  const calls = stubFetch({
    tclparcrelaistr: {
      values: [{ id: 'PR1', nom: 'Gorge de Loup', capacite: 400, nb_tot_place_dispo: 100 }],
    },
    tclparcrelaisst: { values: [{ id: 'PR1', nom: 'Gorge de Loup', capacite: 400 }] },
  });

  const config = normalizeConfig({
    ...CONFIG,
    stops: '',
    velov_stations: '',
    park_and_ride: 'PR1',
  });
  const [device] = buildDiscoveredDevices(gladys, config);
  gladys.devices = [{ external_id: device.external_id }];

  await refreshCreatedDevices(gladys, config);

  assert.ok(calls.length > 0, 'the created device is read from the platform');
  assert.ok(gladys.published.length > 0, 'the created device gets its states');
});

test('the internal refresh loop reads nothing for a device nobody created', async () => {
  // A watched entry the user never added in the Discovery screen has no
  // device, and its states would be dropped by the core: reading its feed
  // would spend a request on an account-protected platform for nothing.
  const gladys = createFakeGladys();
  const calls = stubFetch({
    tclparcrelaistr: { values: [] },
    tclparcrelaisst: { values: [] },
  });

  await refreshCreatedDevices(gladys, CONFIG);

  assert.equal(calls.length, 0);
  assert.equal(gladys.published.length, 0);
});

test('one failing device does not stop the refresh of the others', async () => {
  // Two feeds, one down: the loop must still publish the station it can read.
  const gladys = createFakeGladys();
  stubFetch({
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
    station_status: {
      data: {
        stations: [
          { station_id: '10063', num_bikes_available: 5, num_docks_available: 15, is_renting: 1 },
        ],
      },
    },
    tclparcrelais: 500,
  });

  const config = normalizeConfig({ ...CONFIG, stops: '' });
  const devices = buildDiscoveredDevices(gladys, config);
  gladys.devices = devices.map((device) => ({ external_id: device.external_id }));

  await refreshCreatedDevices(gladys, config);

  const velovStates = gladys.published.filter((state) =>
    state.featureExternalId.startsWith('velov-station:'),
  );
  assert.ok(velovStates.length > 0, 'the readable station is published despite the failing P+R');
});

test('the internal ticker runs at the fastest tick Gladys itself would use', () => {
  // Ticking faster reads nothing sooner (dueForRead gates on the configured
  // interval) and ticking slower makes the fastest device miss its interval.
  assert.equal(refreshTickMs(normalizeConfig({ departures_poll_frequency: 30 })), 30_000);
  assert.equal(refreshTickMs(normalizeConfig()), 60_000);
});

test('every published feature carries the min/max the core stores as NOT NULL', () => {
  // `t_device_feature.min` and `.max` cannot be null: a feature published
  // without them makes the core answer 422 for the WHOLE batch, and the device
  // never shows up. The text features used to omit them, because a range means
  // nothing for a string — "Next departure line" is what the 422 named.
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, CONFIG);

  const features = devices.flatMap((device) => device.features);
  assert.ok(features.length > 0);
  for (const feature of features) {
    assert.ok(
      Number.isFinite(feature.min) && Number.isFinite(feature.max),
      `feature "${feature.name}" would be rejected: min=${feature.min}, max=${feature.max}`,
    );
    assert.ok(feature.min <= feature.max, `feature "${feature.name}" has an inverted range`);
  }
});

test('the ticks arriving inside the configured interval do not reach the feed', async () => {
  // Gladys cannot tick slower than a minute, so a 5-minute refresh is enforced
  // here: four ticks out of five must return without touching the network.
  const gladys = createFakeGladys();
  const calls = stubFetch({
    tclparcrelaistr: {
      values: [{ id: 'PR1', nom: 'Gorge de Loup', capacite: 400, nb_tot_place_dispo: 100 }],
    },
    tclparcrelaisst: { values: [{ id: 'PR1', nom: 'Gorge de Loup', capacite: 400 }] },
  });

  const config = normalizeConfig({
    ...CONFIG,
    stops: '',
    velov_stations: '',
    park_and_ride: 'PR1',
    park_and_ride_poll_frequency: 300,
  });
  const [device] = buildDiscoveredDevices(gladys, config);

  await pollDevice(gladys, device, config);
  const afterFirstTick = calls.length;
  assert.ok(afterFirstTick > 0, 'the first tick reads the platform');

  // The next minute-tick is inside the 5-minute interval: nothing is read, and
  // nothing is published either.
  gladys.published.length = 0;
  await pollDevice(gladys, device, config);
  assert.equal(calls.length, afterFirstTick, 'a tick inside the interval reads nothing');
  assert.equal(gladys.published.length, 0);
});

test('a device that is no longer configured is polled without erroring', async () => {
  const gladys = createFakeGladys();
  await pollDevice(gladys, { external_id: 'ext:test:gone' }, CONFIG);
});

test('a stop exposes max_departures countdowns plus their labels and a summary', () => {
  const gladys = createFakeGladys();
  const [stop] = buildDiscoveredDevices(gladys, CONFIG);

  // 2 departures x (countdown + label) + 1 summary
  assert.equal(stop.features.length, 5);
  const countdowns = stop.features.filter((feature) => feature.unit === 'minutes');
  assert.equal(countdowns.length, 2);
  for (const feature of stop.features) {
    assert.equal(feature.read_only, true, 'TCL data is read-only');
  }
});

test('watching the same stop with two line filters yields two devices', () => {
  const gladys = createFakeGladys();
  const config = normalizeConfig({ stops: '1234@T1, 1234@C3' });
  const devices = buildDiscoveredDevices(gladys, config);

  assert.equal(devices.length, 2);
  assert.notEqual(devices[0].external_id, devices[1].external_id);
});

test('onPoll is routed to the blueprint owning the device', () => {
  const gladys = createFakeGladys();
  const [, velov] = buildDiscoveredDevices(gladys, CONFIG);

  const blueprint = findBlueprintByDevice(gladys, velov, CONFIG);
  assert.equal(blueprint.type, 'velov-station');
  assert.equal(
    findBlueprintByDevice(gladys, { external_id: 'unknown:device' }, CONFIG),
    undefined,
    'a device that is no longer configured has no owner',
  );
});

test('polling a stop publishes the countdowns, the labels and the summary', async () => {
  const gladys = createFakeGladys();
  const inFourMinutes = new Date(Date.now() + 4 * 60_000).toISOString();
  stubFetch({
    tclpassagearret: {
      values: [
        { ligne: 'T1', direction: 'IUT Feyssine', heurepassage: inFourMinutes, type: 'E' },
        { ligne: 'T1', direction: 'IUT Feyssine', delaipassage: '12 min', type: 'T' },
        { ligne: 'C3', direction: 'Vaulx', delaipassage: '2 min', type: 'E' },
      ],
    },
  });

  const [device] = buildDiscoveredDevices(gladys, CONFIG);
  await findBlueprintByDevice(gladys, device, CONFIG).onPoll(gladys, CONFIG);

  const states = Object.fromEntries(
    gladys.published.map((entry) => [entry.featureExternalId, entry.state ?? entry.text]),
  );
  const prefix = device.external_id;

  // The C3 departure is filtered out by the "@T1" line filter, so the two
  // remaining T1 runs are published in order.
  assert.equal(states[`${prefix}:departure_1`], 4);
  assert.equal(states[`${prefix}:departure_1_details`], 'T1 → IUT Feyssine');
  assert.equal(states[`${prefix}:departure_2`], 12);
  assert.equal(states[`${prefix}:departure_2_details`], '~T1 → IUT Feyssine');
  assert.match(states[`${prefix}:departures`], /^T1 → IUT Feyssine 4 min · /);
});

test('a second poll publishes nothing when nothing moved', async () => {
  // Gladys writes down every state it is given, so a value republished
  // unchanged every 30 seconds is a row in its database and nothing on the
  // screen. Only the departures that moved are sent (see stateCache.js).
  const gladys = createFakeGladys();
  stubFetch({
    tclpassagearret: {
      values: [{ ligne: 'T1', direction: 'IUT Feyssine', delaipassage: '7 min', type: 'E' }],
    },
  });

  const [device] = buildDiscoveredDevices(gladys, CONFIG);
  const blueprint = findBlueprintByDevice(gladys, device, CONFIG);
  await blueprint.onPoll(gladys, CONFIG);
  const firstPoll = gladys.published.length;
  assert.ok(firstPoll > 0, 'the first poll publishes everything');

  await blueprint.onPoll(gladys, CONFIG);
  assert.equal(gladys.published.length, firstPoll, 'an unchanged board is not published again');

  // A departure that moved is published, and only it: the second countdown,
  // the labels and the summary have not changed.
  stubFetch({
    tclpassagearret: {
      values: [{ ligne: 'T1', direction: 'IUT Feyssine', delaipassage: '6 min', type: 'E' }],
    },
  });
  await blueprint.onPoll(gladys, CONFIG);
  const published = gladys.published.slice(firstPoll);
  assert.deepEqual(
    published.map((entry) => entry.featureExternalId),
    [`${device.external_id}:departures`, `${device.external_id}:departure_1`],
  );
});

test('a stop with no upcoming departure publishes the sentinel, not a stale value', async () => {
  const gladys = createFakeGladys();
  stubFetch({ tclpassagearret: { values: [] } });

  const [device] = buildDiscoveredDevices(gladys, CONFIG);
  await findBlueprintByDevice(gladys, device, CONFIG).onPoll(gladys, CONFIG);

  const states = Object.fromEntries(
    gladys.published.map((entry) => [entry.featureExternalId, entry.state ?? entry.text]),
  );
  assert.equal(states[`${device.external_id}:departure_1`], 999);
  assert.equal(states[`${device.external_id}:departure_1_details`], '');
  assert.equal(states[`${device.external_id}:departures`], 'No upcoming departure');
});

test('polling a Vélo’v station publishes bikes, docks and occupancy', async () => {
  const gladys = createFakeGladys();
  stubFetch({
    'gbfs.json': {
      data: {
        feeds: [
          { name: 'station_information', url: 'https://feed.test/station_information.json' },
          { name: 'station_status', url: 'https://feed.test/station_status.json' },
        ],
      },
    },
    station_information: {
      data: { stations: [{ station_id: '10063', name: 'Hôtel de Ville', capacity: 20 }] },
    },
    station_status: {
      data: {
        stations: [
          {
            station_id: '10063',
            num_bikes_available: 5,
            num_docks_available: 15,
            vehicle_types_available: [{ vehicle_type_id: 'ebike', count: 2 }],
          },
        ],
      },
    },
  });

  const [, device] = buildDiscoveredDevices(gladys, CONFIG);
  await findBlueprintByDevice(gladys, device, CONFIG).onPoll(gladys, CONFIG);

  const states = Object.fromEntries(
    gladys.published.map((entry) => [entry.featureExternalId, entry.state ?? entry.text]),
  );
  const prefix = device.external_id;
  assert.equal(states[`${prefix}:bikes_available`], 5);
  assert.equal(states[`${prefix}:electric_bikes_available`], 2);
  assert.equal(states[`${prefix}:docks_available`], 15);
  assert.equal(states[`${prefix}:occupancy`], 25);
  assert.equal(states[`${prefix}:status`], 'OK');
});

test('polling an unknown Vélo’v station fails loudly instead of publishing zeroes', async () => {
  const gladys = createFakeGladys();
  stubFetch({
    'gbfs.json': { data: { feeds: [] } },
    station_information: { data: { stations: [] } },
    station_status: { data: { stations: [] } },
  });

  const [, device] = buildDiscoveredDevices(gladys, CONFIG);
  await assert.rejects(
    () => findBlueprintByDevice(gladys, device, CONFIG).onPoll(gladys, CONFIG),
    /not in the feed/,
  );
  assert.equal(gladys.published.length, 0);
});

test('polling a park & ride publishes free spaces and occupancy', async () => {
  const gladys = createFakeGladys();
  stubFetch({
    tclparcrelais: {
      values: [
        {
          id: 'PR1',
          nom: 'Gorge de Loup',
          capacite: 400,
          nbplacesdispo: 100,
          capacitepmr: 10,
          nbplacesdispopmr: 3,
        },
      ],
    },
  });

  const [, , device] = buildDiscoveredDevices(gladys, CONFIG);
  await findBlueprintByDevice(gladys, device, CONFIG).onPoll(gladys, CONFIG);

  const states = Object.fromEntries(
    gladys.published.map((entry) => [entry.featureExternalId, entry.state]),
  );
  const prefix = device.external_id;
  assert.equal(states[`${prefix}:spaces_available`], 100);
  assert.equal(states[`${prefix}:spaces_available_disabled`], 3);
  assert.equal(states[`${prefix}:occupancy`], 75);
});

test('watching several park & ride facilities costs one request per layer, per cycle', async () => {
  const gladys = createFakeGladys();
  const calls = stubFetch({
    tclparcrelaistr: {
      values: [
        { id: 'PR1', nom: 'Gorge de Loup', capacite: 400, nbplacesdispo: 100 },
        { id: 'PR2', nom: 'Parilly', capacite: 800, nbplacesdispo: 40 },
      ],
    },
    tclparcrelaisst: {
      values: [
        { id: 'PR1', nom: 'Gorge de Loup', capacite: 400 },
        { id: 'PR2', nom: 'Parilly', capacite: 800 },
      ],
    },
  });

  const config = normalizeConfig({
    ...CONFIG,
    stops: '',
    velov_stations: '',
    park_and_ride: 'PR1, PR2',
  });
  const devices = buildDiscoveredDevices(gladys, config);
  await Promise.all(
    devices.map((device) => findBlueprintByDevice(gladys, device, config).onPoll(gladys, config)),
  );

  assert.equal(devices.length, 2);
  assert.equal(
    calls.length,
    2,
    'the two layers are downloaded once each and shared by every facility',
  );
});

test('a park & ride id is matched whatever its case', async () => {
  // The real layer keys its facilities on upper-case codes ("SOI", "BON"): a
  // user pasting one back in lower case means the same car park.
  const gladys = createFakeGladys();
  stubFetch({
    tclparcrelais: {
      values: [{ id: 'SOI', nom: 'Vaulx en Velin La Soie', capacite: 460, nb_tot_place_dispo: 87 }],
    },
  });

  const config = normalizeConfig({
    ...CONFIG,
    stops: '',
    velov_stations: '',
    park_and_ride: 'soi',
  });
  const [device] = buildDiscoveredDevices(gladys, config);
  await findBlueprintByDevice(gladys, device, config).onPoll(gladys, config);

  const states = Object.fromEntries(
    gladys.published.map((entry) => [entry.featureExternalId, entry.state]),
  );
  assert.equal(states[`${device.external_id}:spaces_available`], 87);
});

test('a park & ride is also findable by its name', async () => {
  const gladys = createFakeGladys();
  stubFetch({
    tclparcrelais: {
      values: [{ id: 'PR1', nom: 'Gorge de Loup', capacite: 400, nbplacesdispo: 100 }],
    },
  });

  const config = normalizeConfig({
    ...CONFIG,
    stops: '',
    velov_stations: '',
    park_and_ride: 'Gorge de Loup',
  });
  const [device] = buildDiscoveredDevices(gladys, config);
  await findBlueprintByDevice(gladys, device, config).onPoll(gladys, config);

  assert.ok(
    gladys.published.some((entry) => entry.featureExternalId.endsWith(':spaces_available')),
  );
});

test('a poll without Data Grand Lyon credentials explains what is missing', async () => {
  const gladys = createFakeGladys();
  const config = normalizeConfig({ stops: '1234' });
  const [device] = buildDiscoveredDevices(gladys, config);

  await assert.rejects(
    () => findBlueprintByDevice(gladys, device, config).onPoll(gladys, config),
    /credentials are missing/,
  );
});

test('departure labels mark timetable estimates with a tilde', () => {
  assert.equal(
    formatDeparture({ line: 'T1', direction: 'IUT Feyssine', realtime: true }),
    'T1 → IUT Feyssine',
  );
  assert.equal(formatDeparture({ line: 'C3', direction: '', realtime: false }), '~C3');
  assert.equal(formatSummary([]), 'No upcoming departure');
  assert.equal(
    formatSummary([{ line: 'T1', direction: 'Vaulx', minutes: 3, realtime: true }]),
    'T1 → Vaulx 3 min',
  );
});

test('Vélo’v status reports the problems, not just OK', () => {
  assert.equal(formatStatus({ installed: false }), 'Out of service');
  assert.equal(
    formatStatus({ installed: true, renting: true, returning: true, bikes: 4, docks: 6 }),
    'OK',
  );
  assert.equal(
    formatStatus({ installed: true, renting: true, returning: true, bikes: 0, docks: 20 }),
    'no bike available',
  );
  assert.equal(
    formatStatus({ installed: true, renting: false, returning: true, bikes: 4, docks: 0 }),
    'no rental, no free dock',
  );
});

test('occupancy is derived from the capacity, and skipped when unknown', () => {
  assert.equal(velovOccupancy({ bikes: 5, docks: 15, capacity: 20 }), 25);
  // No declared capacity: bikes + docks is a usable stand-in.
  assert.equal(velovOccupancy({ bikes: 5, docks: 5 }), 50);
  assert.equal(velovOccupancy({ bikes: 5 }), null);

  assert.equal(parkingOccupancy({ capacity: 400, available: 100 }), 75);
  assert.equal(parkingOccupancy({ capacity: 400, available: 0 }), 100);
  // The operator sometimes publishes more free spaces than the capacity.
  assert.equal(parkingOccupancy({ capacity: 400, available: 450 }), 0);
  assert.equal(parkingOccupancy({ available: 100 }), null);
});

test('the account test reports a retired dataset without condemning the account', async () => {
  const gladys = createFakeGladys();
  stubFetch({
    // The catalogue knows nothing about a park & ride dataset anymore.
    '/ws/rdata/all.json': { results: [{ table_schema: 'tcl_sytral', table_name: 'tclarret' }] },
    tclparcrelais: 404,
    tclpassagearret: { values: [{ id: '1234' }] },
    tclarret: { values: [{ id: '1234', nom: 'Bellecour' }] },
  });

  const message = await ACTIONS.test_grandlyon(gladys, { fields: {}, config: CONFIG });

  // The point of the button is the first line: the credentials are good. A
  // dataset the Métropole retired is a separate, smaller piece of news.
  assert.match(message.en, /accepted your account/);
  assert.match(message.en, /✔ Next departures/);
  assert.match(message.en, /✖ Park & ride/);
  assert.match(message.fr, /accepté votre compte/);
  assert.match(message.fr, /✖ Parcs relais/);
});

test('a retired dataset is reported with what the platform publishes instead', async () => {
  const gladys = createFakeGladys();
  stubFetch({
    // The catalogue knows the dataset under a name the integration does not:
    // that name is the whole content of a useful bug report, so it must reach
    // the user instead of a bare "please report it".
    '/ws/rdata/all.json': {
      results: [
        { table_schema: 'tcl_sytral', table_name: 'tclarret' },
        { table_schema: 'tcl_sytral', table_name: 'tclparcrelaisxx' },
      ],
    },
    tclparcrelais: 404,
    tclpassagearret: { values: [{ id: '1234' }] },
    tclarret: { values: [{ id: '1234', nom: 'Bellecour' }] },
  });

  const message = await ACTIONS.test_grandlyon(gladys, { fields: {}, config: CONFIG });

  assert.match(message.en, /✖ Park & ride.*tcl_sytral\.tclparcrelaisxx/);
  assert.match(message.fr, /✖ Parcs relais.*tcl_sytral\.tclparcrelaisxx/);
});

test('the stop search shows where each line goes, not just the stop name', async () => {
  // An id and a name are not a choice: the network gives the two sides of the
  // same street two ids under one name, and the terminus is what says which of
  // them is the platform going the right way.
  const gladys = createFakeGladys();
  stubFetch({
    tclpassagearret: {
      values: [
        { id: '1001', ligne: 'A', direction: 'Vaulx-en-Velin La Soie', type: 'E' },
        { id: '1001', ligne: 'A', direction: 'Vaulx-en-Velin La Soie', type: 'E' },
      ],
    },
    tclarret: { values: [{ id: '1001', nom: 'Bellecour', desserte: 'A,D' }] },
  });

  const message = await ACTIONS.search_stops(gladys, {
    fields: { query: 'Bellecour' },
    config: CONFIG,
  });

  assert.match(message.en, /1001 — Bellecour \(A → Vaulx-en-Velin La Soie\)/);
  assert.match(message.fr, /1001 — Bellecour \(A → Vaulx-en-Velin La Soie\)/);
});

test('a stop the search cannot get a direction for still shows its lines', async () => {
  const gladys = createFakeGladys();
  stubFetch({
    // Nothing is running at that stop: the id the user came for is still the
    // point of the list, and the lines are what is left to recognize it by.
    tclpassagearret: { values: [] },
    tclarret: { values: [{ id: '1001', nom: 'Bellecour', desserte: 'A,D' }] },
  });

  const message = await ACTIONS.search_stops(gladys, {
    fields: { query: 'Bellecour' },
    config: CONFIG,
  });

  assert.match(message.en, /1001 — Bellecour \(A,D\)/);
  assert.match(message.en, /no departure right now/);
  assert.match(message.fr, /aucun passage à venir/);
});

test('the account test still names the password trap when the account is refused', async () => {
  const gladys = createFakeGladys();
  stubFetch({ 'all.json': 401 });

  const message = await ACTIONS.test_grandlyon(gladys, { fields: {}, config: CONFIG });

  assert.match(message.en, /onegeo-login/);
  assert.match(message.fr, /GrandLyon Connect/);
});
