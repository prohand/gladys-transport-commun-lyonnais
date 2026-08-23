// -----------------------------------------------------------------------------
// Device catalog: discovery payloads, onPoll dispatch and published states.
//
// The upstream feeds are stubbed at the `fetch` level, so these tests cover
// the real code path (HTTP client included) without touching the network.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { normalizeConfig } from '../src/config.js';
import { buildDiscoveredDevices, findBlueprintByDevice } from '../src/devices/index.js';
import { formatDeparture, formatSummary } from '../src/devices/transitStop.js';
import { computeOccupancy as velovOccupancy, formatStatus } from '../src/devices/velovStation.js';
import { computeOccupancy as parkingOccupancy } from '../src/devices/parkAndRide.js';
import { clearTclCache } from '../src/api/tcl.js';
import { clearVelovCache } from '../src/api/velov.js';

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
    return { ok: true, status: 200, json: async () => routes[match] };
  };
  return calls;
}

beforeEach(() => {
  clearTclCache();
  clearVelovCache();
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

test('each device carries the poll frequency of its data source', () => {
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    ...CONFIG,
    departures_poll_frequency: 45,
    velov_poll_frequency: 90,
    park_and_ride_poll_frequency: 600,
  });
  const [stop, velov, parking] = buildDiscoveredDevices(gladys, config);

  assert.equal(stop.poll_frequency, 45);
  assert.equal(velov.poll_frequency, 90);
  assert.equal(parking.poll_frequency, 600);
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

test('watching several park & ride facilities costs a single request per cycle', async () => {
  const gladys = createFakeGladys();
  const calls = stubFetch({
    tclparcrelais: {
      values: [
        { id: 'PR1', nom: 'Gorge de Loup', capacite: 400, nbplacesdispo: 100 },
        { id: 'PR2', nom: 'Parilly', capacite: 800, nbplacesdispo: 40 },
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
  assert.equal(calls.length, 1, 'the layer is downloaded once and shared');
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
