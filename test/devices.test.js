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
import { clearPublishReports } from '../src/devices/publish.js';
import { refreshCreatedDevices, refreshTickMs } from '../src/devices/refreshLoop.js';
import { formatDeparture, formatSummary } from '../src/devices/transitStop.js';
import { computeOccupancy as velovOccupancy, formatStatus } from '../src/devices/velovStation.js';
import {
  computeOccupancy as parkingOccupancy,
  formatStatus as parkingStatus,
} from '../src/devices/parkAndRide.js';
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
  // Same for what has already been said about an incomplete device: it is said
  // once per device, and the next test is a new device.
  clearPublishReports();
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

test('a park & ride SYTRAL does not count live still publishes something', async () => {
  // The reported "sur les parcs relais je n'ai pas de valeurs": the live layer
  // only covers part of the network, and a facility that is in the inventory
  // and not in the counts had no state to publish at all — no free spaces, no
  // occupancy, and therefore an empty device, forever, with no error to read.
  // Its capacity is known and "no live count" is an answer.
  const gladys = createFakeGladys();
  stubFetch({
    tclparcrelaistr: {
      values: [{ id: 'GOR', nom: 'Gorge de Loup', capacite: 655, nb_tot_place_dispo: 120 }],
    },
    tclparcrelaisst: {
      values: [
        { id: 'GOR', nom: 'Gorge de Loup', capacite: 655 },
        { id: 'BONN', nom: 'Laurent Bonnevay', capacite: 287 },
      ],
    },
  });

  const config = normalizeConfig({
    ...CONFIG,
    stops: '',
    velov_stations: '',
    park_and_ride: 'BONN',
  });
  const [device] = buildDiscoveredDevices(gladys, config);
  await findBlueprintByDevice(gladys, device, config).onPoll(gladys, config);

  const states = Object.fromEntries(
    gladys.published.map((entry) => [entry.featureExternalId, entry.text ?? entry.state]),
  );
  const prefix = device.external_id;
  assert.equal(states[`${prefix}:capacity`], 287);
  assert.equal(states[`${prefix}:status`], 'No live count (287 spaces)');
  assert.equal(
    states[`${prefix}:spaces_available`],
    undefined,
    'a free-space count nobody publishes is not invented',
  );
});

/**
 * The park & ride of the test above, as Gladys holds it: a facility in the
 * inventory that nobody counts live, so the read produces the capacity and the
 * status and nothing else.
 */
function stubUncountedParkAndRide() {
  return stubFetch({
    tclparcrelaistr: {
      values: [{ id: 'GOR', nom: 'Gorge de Loup', capacite: 655, nb_tot_place_dispo: 120 }],
    },
    tclparcrelaisst: {
      values: [
        { id: 'GOR', nom: 'Gorge de Loup', capacite: 655 },
        { id: 'BONN', nom: 'Laurent Bonnevay', capacite: 287 },
      ],
    },
  });
}

/**
 * The device as a previous version of the integration created it: Gladys keeps
 * the features a device was born with, and re-publishing a discovery never
 * adds one.
 * @param {{ external_id: string }} device
 * @param {string[]} featureKeys
 */
function createdInGladys(device, featureKeys) {
  return {
    external_id: device.external_id,
    name: 'P+R Laurent Bonnevay',
    features: featureKeys.map((key) => ({ external_id: `${device.external_id}:${key}` })),
  };
}

// The feature keys the park & ride device had before it gained its capacity
// and its status.
const PARK_AND_RIDE_FEATURES_BEFORE = [
  'spaces_available',
  'spaces_available_disabled',
  'occupancy',
];

test('a device older than the feature a value belongs to is flagged, not published to in silence', async () => {
  // The second half of "je n'ai toujours aucune valeur": the release that gave
  // the park & ride device a capacity and a status published, for a facility
  // nobody counts live, exactly those two states — to two features the device
  // created by the previous version does not have. Gladys stored nothing, the
  // car park stayed empty, and the only line in the logs was the warning about
  // the thin feed. The container cannot add a feature to an existing device:
  // what it can do is publish what fits, and say what is missing.
  const gladys = createFakeGladys();
  stubUncountedParkAndRide();

  const config = normalizeConfig({
    ...CONFIG,
    stops: '',
    velov_stations: '',
    park_and_ride: 'BONN',
  });
  const [device] = buildDiscoveredDevices(gladys, config);
  gladys.devices = [createdInGladys(device, PARK_AND_RIDE_FEATURES_BEFORE)];

  await findBlueprintByDevice(gladys, device, config).onPoll(gladys, config);

  assert.deepEqual(gladys.published, [], 'nothing is sent to a feature Gladys does not hold');
  assert.equal(gladys.transports.length, 1, 'the device itself carries the reason, in the UI');
  const [flag] = gladys.transports;
  assert.equal(flag.external_id, device.external_id);
  assert.equal(flag.degraded, true);
  assert.match(flag.message.en, /capacity/);
  assert.match(flag.message.en, /status/);
  assert.match(flag.message.fr, /Découverte/);
});

test('the values an outdated device could not store are published as soon as it is updated', async () => {
  // The state cache is a belief about what Gladys holds, and a state that
  // never reached it must not feed that belief: pressing "Update" in the
  // Discovery screen has to fill the new features in on the very next read,
  // not a quarter of an hour later.
  const gladys = createFakeGladys();
  stubUncountedParkAndRide();

  const config = normalizeConfig({
    ...CONFIG,
    stops: '',
    velov_stations: '',
    park_and_ride: 'BONN',
  });
  const [device] = buildDiscoveredDevices(gladys, config);
  const blueprint = findBlueprintByDevice(gladys, device, config);
  gladys.devices = [createdInGladys(device, PARK_AND_RIDE_FEATURES_BEFORE)];
  await blueprint.onPoll(gladys, config);

  // The user presses "Update": the device now carries every feature.
  gladys.devices = [
    createdInGladys(device, [...PARK_AND_RIDE_FEATURES_BEFORE, 'capacity', 'status']),
  ];
  clearTclCache();
  await blueprint.onPoll(gladys, config);

  const states = Object.fromEntries(
    gladys.published.map((entry) => [entry.featureExternalId, entry.text ?? entry.state]),
  );
  const prefix = device.external_id;
  assert.equal(states[`${prefix}:capacity`], 287);
  assert.equal(states[`${prefix}:status`], 'No live count (287 spaces)');
  // And the badge is cleared: the device is nominal again.
  assert.equal(gladys.transports.length, 2);
  assert.equal(gladys.transports[1].degraded, undefined);
});

test('a device missing one feature still records the values it does have', async () => {
  // Dropping the whole batch over one unknown feature would turn a device that
  // is merely out of date into a device that publishes nothing at all.
  const gladys = createFakeGladys();
  stubFetch({
    tclparcrelais: {
      values: [{ id: 'PR1', nom: 'Gorge de Loup', capacite: 400, nb_tot_place_dispo: 100 }],
    },
  });

  const [, , device] = buildDiscoveredDevices(gladys, CONFIG);
  gladys.devices = [createdInGladys(device, PARK_AND_RIDE_FEATURES_BEFORE)];
  await findBlueprintByDevice(gladys, device, CONFIG).onPoll(gladys, CONFIG);

  const states = Object.fromEntries(
    gladys.published.map((entry) => [entry.featureExternalId, entry.text ?? entry.state]),
  );
  const prefix = device.external_id;
  assert.equal(states[`${prefix}:spaces_available`], 100);
  assert.equal(states[`${prefix}:occupancy`], 75);
  assert.equal(states[`${prefix}:capacity`], undefined, 'the missing feature is the only casualty');
});

test('a device whose features Gladys does not detail is published to as before', async () => {
  // The filter above is a belief about what the created device can store, and
  // a device listed without usable feature ids says nothing at all: treating
  // that as "stores nothing" would make this module the cause of the silence
  // it exists to prevent.
  const gladys = createFakeGladys();
  stubFetch({
    tclparcrelais: {
      values: [{ id: 'PR1', nom: 'Gorge de Loup', capacite: 400, nb_tot_place_dispo: 100 }],
    },
  });

  const [, , device] = buildDiscoveredDevices(gladys, CONFIG);
  gladys.devices = [{ external_id: device.external_id, name: 'Commute', features: [{}] }];
  await findBlueprintByDevice(gladys, device, CONFIG).onPoll(gladys, CONFIG);

  const states = Object.fromEntries(
    gladys.published.map((entry) => [entry.featureExternalId, entry.text ?? entry.state]),
  );
  assert.equal(states[`${device.external_id}:capacity`], 400);
  assert.deepEqual(gladys.transports, [], 'and nothing is flagged on a guess');
});

test('a park & ride publishes its status and capacity next to its free spaces', async () => {
  const gladys = createFakeGladys();
  stubFetch({
    tclparcrelais: {
      values: [{ id: 'PR1', nom: 'Gorge de Loup', capacite: 400, nb_tot_place_dispo: 100 }],
    },
  });

  const [, , device] = buildDiscoveredDevices(gladys, CONFIG);
  await findBlueprintByDevice(gladys, device, CONFIG).onPoll(gladys, CONFIG);

  const states = Object.fromEntries(
    gladys.published.map((entry) => [entry.featureExternalId, entry.text ?? entry.state]),
  );
  const prefix = device.external_id;
  assert.equal(states[`${prefix}:capacity`], 400);
  assert.equal(states[`${prefix}:status`], '100/400 free');
});

test('a free-space count published under an unknown column name is still read', async () => {
  // The columns of this dataset have moved once already (`nbplacesdispo` ->
  // `nb_tot_place_dispo`) and a count nobody can read is not an error: it is
  // a device that publishes nothing, silently. The column NAME is the
  // fallback, and the bicycle shelter next to it must not be read as the car
  // park's own count.
  const gladys = createFakeGladys();
  stubFetch({
    tclparcrelais: {
      values: [
        {
          id: 'PR1',
          nom: 'Gorge de Loup',
          nb_places_voiture: 400,
          nb_places_libres_voiture: 100,
          nb_places_libres_velo: 12,
        },
      ],
    },
  });

  const [, , device] = buildDiscoveredDevices(gladys, CONFIG);
  await findBlueprintByDevice(gladys, device, CONFIG).onPoll(gladys, CONFIG);

  const states = Object.fromEntries(
    gladys.published.map((entry) => [entry.featureExternalId, entry.text ?? entry.state]),
  );
  const prefix = device.external_id;
  assert.equal(states[`${prefix}:spaces_available`], 100);
  assert.equal(states[`${prefix}:capacity`], 400);
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

test('a park & ride status says what the facility has, or that nobody counts it', () => {
  assert.equal(parkingStatus({ capacity: 655, available: 120 }), '120/655 free');
  assert.equal(parkingStatus({ capacity: 655, available: 0 }), 'Full');
  assert.equal(parkingStatus({ available: 120 }), '120 free');
  assert.equal(parkingStatus({ capacity: 287, live: false }), 'No live count (287 spaces)');
  assert.equal(parkingStatus({}), 'No live count');
  // The facility IS counted by the platform and the count could not be read:
  // that is a bug to report, not the open data being what it is, and the two
  // are indistinguishable from three empty gauges.
  assert.equal(parkingStatus({ capacity: 287, live: true }), 'Live count unreadable (287 spaces)');
});

test('a park & ride the live layer holds without a usable count says so on the device', async () => {
  const gladys = createFakeGladys();
  stubFetch({
    tclparcrelaistr: {
      // -1 is the platform saying "unknown": the facility is counted, the
      // count is not publishable.
      values: [{ id: 'BONN', nom: 'Laurent Bonnevay', capacite: 287, nb_tot_place_dispo: -1 }],
    },
    tclparcrelaisst: { values: [{ id: 'BONN', nom: 'Laurent Bonnevay', capacite: 287 }] },
  });

  const config = normalizeConfig({
    ...CONFIG,
    stops: '',
    velov_stations: '',
    park_and_ride: 'BONN',
  });
  const [device] = buildDiscoveredDevices(gladys, config);
  await findBlueprintByDevice(gladys, device, config).onPoll(gladys, config);

  const states = Object.fromEntries(
    gladys.published.map((entry) => [entry.featureExternalId, entry.text ?? entry.state]),
  );
  assert.equal(states[`${device.external_id}:status`], 'Live count unreadable (287 spaces)');
  assert.equal(states[`${device.external_id}:capacity`], 287);
});

test('the park & ride list tells the two kinds of missing count apart', async () => {
  // Answering "no live count" to both is what leaves somebody staring at three
  // empty gauges with no way of knowing whether there is anything to fix.
  const gladys = createFakeGladys();
  stubFetch({
    tclparcrelaistr: {
      values: [
        { id: 'GOR', nom: 'Gorge de Loup', capacite: 655, nb_tot_place_dispo: 120 },
        { id: 'BONN', nom: 'Laurent Bonnevay', capacite: 287, nb_tot_place_dispo: -1 },
      ],
    },
    tclparcrelaisst: {
      values: [
        { id: 'GOR', nom: 'Gorge de Loup', capacite: 655 },
        { id: 'BONN', nom: 'Laurent Bonnevay', capacite: 287 },
        { id: 'IRYV', nom: 'Irigny-Yvours', capacite: 287 },
      ],
    },
  });

  const message = await ACTIONS.list_park_and_ride(gladys, { fields: {}, config: CONFIG });

  assert.match(message.en, /GOR — Gorge de Loup \(120\/655 free\)/);
  assert.match(message.en, /absent from the real-time layer[\s\S]*IRYV/);
  assert.match(message.en, /could not read: BONN/);
  assert.match(message.fr, /absents de la couche temps réel[\s\S]*IRYV/);
  assert.match(message.fr, /n’a pas su lire : BONN/);
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
