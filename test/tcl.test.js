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

/**
 * A platform serving the stop directory, counting what is asked of it.
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

    if (!url.pathname.startsWith('/ws/rdata/tcl_sytral.tclarret_2_0_0/')) {
      res.writeHead(404);
      res.end();
      return;
    }

    // The web service applies `field`/`value` as an exact match.
    const field = url.searchParams.get('field');
    const value = url.searchParams.get('value');
    const values = field ? STOPS.filter((stop) => stop[field] === value) : STOPS;
    sendJson(res, { nb_results: values.length, values });
  });
  server.asked = asked;
  return server;
}

test('an exact stop name is answered by the platform, without downloading the directory', async (t) => {
  clearLayerResolution();
  clearTclCache();
  const platform = await startStopsServer();
  t.after(platform.close);

  const results = await searchStops(configFor(`${platform.baseUrl}/ws/rdata`), 'Bellecour');

  assert.deepEqual(results, [{ id: '1001', name: 'Bellecour', lines: 'A,D,C3' }]);
  assert.ok(
    platform.asked.every((url) => url.searchParams.get('field') === 'nom'),
    'a name typed in full must never cost a whole-directory download',
  );
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
    platform.asked.filter((url) => url.searchParams.get('field') === null).length;
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

  assert.deepEqual(results, [{ id: '1001', name: 'Bellecour', lines: 'A,D,C3' }]);
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
