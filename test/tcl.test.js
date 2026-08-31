// -----------------------------------------------------------------------------
// The TCL reads on top of the Data Grand Lyon client.
//
// What is pinned here is the cost of each read, not just its result: the stop
// directory has no server-side search, so a naive implementation downloads
// several megabytes per keystroke and ends in a timeout — which is exactly the
// bug these tests exist to keep fixed. They therefore count requests as much
// as they check payloads.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearLayerResolution } from '../src/api/grandlyon.js';
import {
  checkDatasets,
  clearTclCache,
  fetchDepartures,
  findParkAndRide,
  fetchParkAndRideFacilities,
  listParkAndRideFacilities,
  mergeParkAndRide,
  searchStops,
  belongsToStop,
  normalizeText,
} from '../src/api/tcl.js';
import { configFor, sendJson, startServer } from './helpers/localServer.js';

// One record per stop of the (very small) fake network.
const STOPS = [
  { id: '1001', nom: 'Bellecour', desserte: 'A,D,C3' },
  { id: '1002', nom: 'Gare de Vénissieux', desserte: 'D,T4' },
  { id: '1003', nom: 'Bellecour Le Viste', desserte: 'C3' },
];

// The upcoming passages of that network, which is where a stop search reads
// the direction from: the directory says "Bellecour" twice and only a terminus
// tells the two apart. Stop 1003 has none — the night case.
const PASSAGES = [
  { id: '1001', ligne: 'A', direction: 'Vaulx-en-Velin La Soie', type: 'E' },
  { id: '1001', ligne: 'A', direction: 'Vaulx-en-Velin La Soie', type: 'E' },
  { id: '1001', ligne: 'A', direction: 'Perrache', type: 'E' },
  { id: '1002', ligne: 'T4', direction: 'La Doua Gaston Berger', type: 'E' },
];

/**
 * A platform serving the stop directory and the departures, counting what is
 * asked of it.
 * @param {(url: URL) => object | undefined} [override] per-test special cases
 */
async function startStopsServer(override) {
  const asked = [];
  const server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    asked.push(url);

    const custom = override?.(url);
    if (custom) {
      sendJson(res, custom);
      return;
    }

    // The web service applies `field`/`value` as an exact match.
    const field = url.searchParams.get('field');
    const value = url.searchParams.get('value');

    if (url.pathname.startsWith('/ws/rdata/tcl_sytral.tclpassagearret_2_0_0/')) {
      const values = field ? PASSAGES.filter((passage) => passage[field] === value) : PASSAGES;
      sendJson(res, { nb_results: values.length, values });
      return;
    }

    if (!url.pathname.startsWith('/ws/rdata/tcl_sytral.tclarret_2_0_0/')) {
      res.writeHead(404);
      res.end();
      return;
    }

    const values = field ? STOPS.filter((stop) => stop[field] === value) : STOPS;
    sendJson(res, { nb_results: values.length, values });
  });
  server.asked = asked;
  return server;
}

/** The stop directory requests, i.e. the ones that are not about departures. */
const directoryReads = (platform) =>
  platform.asked.filter((url) => url.pathname.includes('tclarret'));

test('an exact stop name is answered by the platform, without downloading the directory', async (t) => {
  clearLayerResolution();
  clearTclCache();
  const platform = await startStopsServer();
  t.after(platform.close);

  const results = await searchStops(configFor(`${platform.baseUrl}/ws/rdata`), 'Bellecour');

  assert.deepEqual(results, [
    {
      id: '1001',
      name: 'Bellecour',
      lines: 'A,D,C3',
      direction: '',
      // Sorted, and each line/terminus pair only once however many runs are
      // upcoming: the search shows where the stop goes, not its timetable.
      directions: [
        { line: 'A', direction: 'Perrache' },
        { line: 'A', direction: 'Vaulx-en-Velin La Soie' },
      ],
    },
  ]);
  assert.ok(
    directoryReads(platform).every((url) => url.searchParams.get('field') === 'nom'),
    'a name typed in full must never cost a whole-directory download',
  );
});

test('a stop with no upcoming passage is still listed, without a direction', async (t) => {
  clearLayerResolution();
  clearTclCache();
  const platform = await startStopsServer();
  t.after(platform.close);

  const results = await searchStops(
    configFor(`${platform.baseUrl}/ws/rdata`),
    'Bellecour Le Viste',
  );

  // Nothing is running: the id the user came for must still be there, and the
  // lines of the directory are what is left to recognize the stop by.
  assert.deepEqual(results[0].directions, []);
  assert.equal(results[0].lines, 'C3');
});

test('a search survives departures it cannot read', async (t) => {
  clearLayerResolution();
  clearTclCache();
  // The account can read the directory but not the departures (a retired
  // layer, a timeout): the directions are a bonus, never a reason to answer
  // "no stop matches".
  const platform = await startStopsServer((url) =>
    url.pathname.includes('passagearret') ? { error: 'nope' } : undefined,
  );
  t.after(platform.close);

  const results = await searchStops(configFor(`${platform.baseUrl}/ws/rdata`), 'Bellecour');

  assert.equal(results.length, 1);
  assert.equal(results[0].id, '1001');
  assert.deepEqual(results[0].directions, []);
});

test('a partial name falls back on the directory, and pays for it once', async (t) => {
  clearLayerResolution();
  clearTclCache();
  const platform = await startStopsServer();
  t.after(platform.close);
  const config = configFor(`${platform.baseUrl}/ws/rdata`);

  const results = await searchStops(config, 'belle');

  assert.deepEqual(
    results.map((stop) => stop.id),
    ['1001', '1003'],
  );

  const downloads = () =>
    directoryReads(platform).filter((url) => url.searchParams.get('field') === null).length;
  assert.equal(downloads(), 1);

  // The directory changes twice a year: a second search must not download it
  // again, which is what made the search action time out.
  await searchStops(config, 'viste');
  assert.equal(downloads(), 1, 'the directory is cached between two searches');
});

test('a search ignores accents, because nobody types them', async (t) => {
  clearLayerResolution();
  clearTclCache();
  const platform = await startStopsServer();
  t.after(platform.close);

  const results = await searchStops(configFor(`${platform.baseUrl}/ws/rdata`), 'venissieux');

  assert.deepEqual(
    results.map((stop) => stop.name),
    ['Gare de Vénissieux'],
  );
  assert.equal(normalizeText('Gare de Vénissieux'), 'gare de venissieux');
});

test('an exact-name lookup the platform refuses to filter is not mistaken for a match', async (t) => {
  clearLayerResolution();
  clearTclCache();
  // A layer where `field`/`value` is ignored answers with an arbitrary page of
  // the directory: those records are not results.
  const platform = await startStopsServer((url) =>
    url.searchParams.get('field') ? { values: STOPS } : undefined,
  );
  t.after(platform.close);

  const results = await searchStops(configFor(`${platform.baseUrl}/ws/rdata`), 'Bellecour');

  assert.deepEqual(
    results.map((stop) => stop.id),
    ['1001'],
  );
});

test('departures are kept for the stop that was asked for', async (t) => {
  clearLayerResolution();
  clearTclCache();
  const now = new Date('2026-08-23T10:00:00Z');
  const { baseUrl, close } = await startServer((req, res) => {
    if (!req.url.startsWith('/ws/rdata/tcl_sytral.tclpassagearret_2_0_0/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    // A service that ignores the filter answers about the whole network.
    sendJson(res, {
      values: [
        { id: '1001', ligne: 'T1', direction: 'IUT', heurepassage: '2026-08-23T10:04:00Z' },
        { id: '9999', ligne: 'C3', direction: 'Vaulx', heurepassage: '2026-08-23T10:01:00Z' },
      ],
    });
  });
  t.after(close);

  const departures = await fetchDepartures(
    configFor(`${baseUrl}/ws/rdata`),
    { id: '1001', lines: [] },
    now,
  );

  assert.deepEqual(
    departures.map((departure) => departure.line),
    ['T1'],
  );
  assert.equal(belongsToStop({ ligne: 'T1' }, '1001'), true, 'a filtered answer carries no id');
});

test('a departure is matched on any of the columns naming its stop', () => {
  // The departures layer carries both a passage id and a stop id. Reading only
  // the first column that is present threw away every record of a stop whose
  // id lives in `idtarret`, and the device polled forever without ever showing
  // a departure.
  assert.equal(belongsToStop({ id: '99887766', idtarret: '2080' }, '2080'), true);
  assert.equal(belongsToStop({ id: '2080' }, '2080'), true);
  assert.equal(belongsToStop({ id: '99887766', idtarret: '2079' }, '2080'), false);
});

test('the account test reports each dataset instead of failing on the first', async (t) => {
  clearLayerResolution();
  clearTclCache();
  const { baseUrl, close } = await startServer((req, res) => {
    if (req.url.startsWith('/ws/rdata/all.json')) {
      sendJson(res, { results: [{ table_schema: 'tcl_sytral', table_name: 'tclarret_2_0_0' }] });
      return;
    }
    if (req.url.includes('parcrelais')) {
      // The dataset of the day the platform retires: it must not make the
      // whole account look broken.
      res.writeHead(404);
      res.end();
      return;
    }
    sendJson(res, { values: [{ id: '1001' }] });
  });
  t.after(close);

  const datasets = await checkDatasets(configFor(`${baseUrl}/ws/rdata`));

  assert.deepEqual(
    datasets.map((dataset) => [dataset.key, dataset.ok]),
    [
      ['departures', true],
      ['stops', true],
      ['park_and_ride', false],
    ],
  );
  assert.equal(datasets[0].layer, 'tcl_sytral.tclpassagearret_2_0_0');
  assert.equal(datasets[2].error.status, 404);
});

test('a refused account is reported as such, not as three missing datasets', async (t) => {
  clearLayerResolution();
  clearTclCache();
  const { baseUrl, close } = await startServer((req, res) => {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="rdata"' });
    res.end();
  });
  t.after(close);

  await assert.rejects(checkDatasets(configFor(`${baseUrl}/ws/rdata`)), (err) => {
    assert.equal(err.status, 401);
    assert.match(err.userMessage.fr, /onegeo-login/);
    return true;
  });
});

// The park & ride dataset as SYTRAL publishes it: an inventory of every
// facility (static) and, next to it, the live count of the ones that are
// actually equipped to count. "Laurent Bonnevay" is in the first and not in the
// second, which is the whole point of the fixture.
const PARK_AND_RIDE_STATIC = [
  { id: 'GOR', nom: 'Gorge de Loup', capacite: 655, place_handi: 19 },
  { id: 'BONN', nom: 'Laurent Bonnevay', capacite: 287, place_handi: 7 },
];
const PARK_AND_RIDE_REALTIME = [
  { id: 'GOR', nom: 'Gorge de Loup', capacite: 655, nb_tot_place_dispo: 120 },
];

/**
 * A platform serving the two park & ride layers, counting what is asked of it.
 * @param {{ realtimeStatus?: number, staticStatus?: number }} [failures]
 */
async function startParkAndRideServer({ realtimeStatus, staticStatus } = {}) {
  const asked = [];
  const server = await startServer((req, res) => {
    asked.push(req.url);
    const isRealtime = req.url.includes('tclparcrelaistr');
    const isStatic = req.url.includes('tclparcrelaisst');
    const status = isRealtime ? realtimeStatus : isStatic ? staticStatus : 404;
    if (status) {
      res.writeHead(status);
      res.end();
      return;
    }
    if (!isRealtime && !isStatic) {
      res.writeHead(404);
      res.end();
      return;
    }
    const values = isRealtime ? PARK_AND_RIDE_REALTIME : PARK_AND_RIDE_STATIC;
    sendJson(res, { nb_results: values.length, values });
  });
  server.asked = asked;
  return server;
}

test('the park & ride list holds every facility, not only the counted ones', async (t) => {
  // The bug: the integration read the real-time layer only, so a facility
  // SYTRAL does not count live was missing from the list the configuration
  // screen offers — and could not be watched at all.
  clearLayerResolution();
  clearTclCache();
  const { baseUrl, close, asked } = await startParkAndRideServer();
  t.after(close);

  const facilities = await listParkAndRideFacilities(configFor(`${baseUrl}/ws/rdata`));

  assert.deepEqual(
    facilities.map((facility) => facility.id),
    ['GOR', 'BONN'],
    'both layers are merged, sorted by name',
  );
  const [gorge, bonnevay] = facilities;
  // The live count comes from the real-time layer...
  assert.equal(gorge.available, 120);
  assert.equal(gorge.capacity, 655);
  // ...and the facility it does not count keeps its inventory, with no
  // invented availability.
  assert.equal(bonnevay.capacity, 287);
  assert.equal(bonnevay.available, undefined);
  assert.equal(bonnevay.capacityDisabled, 7);
  assert.equal(asked.length, 2, 'one request per layer');
});

test('a park & ride is watchable by the id or the name of either layer', async (t) => {
  clearLayerResolution();
  clearTclCache();
  const { baseUrl, close } = await startParkAndRideServer();
  t.after(close);

  const facilities = await fetchParkAndRideFacilities(configFor(`${baseUrl}/ws/rdata`));

  assert.equal(findParkAndRide(facilities, 'BONN').name, 'Laurent Bonnevay');
  assert.equal(findParkAndRide(facilities, 'bonn').name, 'Laurent Bonnevay');
  assert.equal(findParkAndRide(facilities, 'laurent bonnevay').capacity, 287);
});

test('one unreadable park & ride layer degrades the list instead of emptying it', async (t) => {
  // A retired or momentarily broken real-time layer must still leave the
  // facilities listed: capacity without a live count beats nothing at all.
  clearLayerResolution();
  clearTclCache();
  const { baseUrl, close } = await startParkAndRideServer({ realtimeStatus: 500 });
  t.after(close);

  const facilities = await listParkAndRideFacilities(configFor(`${baseUrl}/ws/rdata`));

  assert.deepEqual(
    facilities.map((facility) => facility.id),
    ['GOR', 'BONN'],
  );
  assert.equal(facilities[0].available, undefined);
});

test('a park & ride read that fails on both layers is an error, not an empty list', async (t) => {
  clearLayerResolution();
  clearTclCache();
  const { baseUrl, close } = await startParkAndRideServer({
    realtimeStatus: 500,
    staticStatus: 500,
  });
  t.after(close);

  await assert.rejects(listParkAndRideFacilities(configFor(`${baseUrl}/ws/rdata`)), /HTTP 500/);
});

test('merging two records of the same facility never erases a known value', () => {
  const statique = {
    id: 'GOR',
    name: 'Gorge de Loup',
    capacity: 655,
    capacityDisabled: 19,
    available: undefined,
  };
  const realtime = { id: 'GOR', name: 'P+R', capacity: undefined, available: 120 };

  const merged = mergeParkAndRide(statique, realtime);
  assert.equal(merged.available, 120, 'the live count is what the real-time layer adds');
  assert.equal(merged.capacity, 655, 'a column the real-time layer omits is kept');
  assert.equal(merged.name, 'Gorge de Loup', 'the placeholder name never wins over a real one');
  assert.deepEqual(mergeParkAndRide(undefined, realtime), realtime);
});
