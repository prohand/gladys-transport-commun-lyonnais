// -----------------------------------------------------------------------------
// The Data Grand Lyon HTTP client.
//
// Two behaviours are worth pinning down here, because both showed up as the
// same symptom in the wild — a 401 with credentials that work in a browser:
//
//   1. the platform redirects the retired portal endpoint to the download
//      host, and `fetch` strips the Authorization header across hosts, so the
//      client has to follow the redirect itself;
//   2. a refused account must produce an explanation the user can act on (the
//      web service wants the data platform password, not the GrandLyon
//      Connect one), not a bare status code.
//
// The third symptom covered here is the HTTP 404 an otherwise valid account
// gets once the platform republishes a dataset under a new name: the client
// walks the names it knows before giving up, and gives up with an explanation
// rather than a status code.
//
// The tests run against a local HTTP server: no network access needed.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateBaseUrls,
  canReplayCredentials,
  clearLayerResolution,
  equalityParams,
  fetchLayer,
  GrandLyonError,
  layerStem,
  matchPublishedLayers,
  resolvedLayerFor,
} from '../src/api/grandlyon.js';
import { normalizeConfig } from '../src/config.js';
import { BASIC, configFor, sendJson, startServer } from './helpers/localServer.js';

test('credentials survive a redirect, which fetch alone would drop', async (t) => {
  const seen = [];
  const { baseUrl, close } = await startServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization ?? null });
    if (req.url.startsWith('/ws/rdata/')) {
      // What the platform does with the retired endpoint: move the caller.
      res.writeHead(302, { location: '/moved/all.json' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ nb_results: 1, values: [{ id: 'P+R Gorge de Loup' }] }));
  });
  t.after(close);

  const values = await fetchLayer(configFor(`${baseUrl}/ws/rdata`), 'tcl_sytral.tclparcrelais');

  assert.deepEqual(values, [{ id: 'P+R Gorge de Loup' }]);
  assert.equal(seen.length, 2, 'the redirect must be followed');
  assert.equal(seen[1].authorization, BASIC, 'the redirected request must still be authenticated');
});

test('a redirect off the platform is refused instead of replaying the credentials', async (t) => {
  const elsewhere = await startServer((req, res) => {
    elsewhere.requests.push(req.headers.authorization ?? null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"values":[]}');
  });
  elsewhere.requests = [];
  t.after(elsewhere.close);

  const platform = await startServer((req, res) => {
    res.writeHead(302, { location: `${elsewhere.baseUrl}/all.json` });
    res.end();
  });
  t.after(platform.close);

  await assert.rejects(
    fetchLayer(configFor(`${platform.baseUrl}/ws/rdata`), 'tcl_sytral.tclparcrelais'),
    (err) => {
      assert.ok(err instanceof GrandLyonError);
      assert.match(err.message, /outside of the platform/);
      return true;
    },
  );
  assert.deepEqual(elsewhere.requests, [], 'the other host must never see the request');
});

test('an endless redirect chain gives up instead of looping', async (t) => {
  let hops = 0;
  const { baseUrl, close } = await startServer((req, res) => {
    hops += 1;
    res.writeHead(302, { location: `/hop-${hops}` });
    res.end();
  });
  t.after(close);

  await assert.rejects(
    fetchLayer(configFor(`${baseUrl}/ws/rdata`), 'tcl_sytral.tclparcrelais'),
    /redirects in a loop/,
  );
  assert.ok(hops <= 4, `at most one request per allowed hop, got ${hops}`);
});

test('a refused account explains which password the web service wants', async (t) => {
  const { baseUrl, close } = await startServer((req, res) => {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="rdata"' });
    res.end();
  });
  t.after(close);

  await assert.rejects(
    fetchLayer(configFor(`${baseUrl}/ws/rdata`), 'tcl_sytral.tclparcrelais'),
    (err) => {
      assert.ok(err instanceof GrandLyonError);
      assert.equal(err.status, 401);
      // The user reads `userMessage`, so this is where the fix must be spelled
      // out: the platform password, not the GrandLyon Connect one.
      assert.match(err.userMessage.en, /onegeo-login/);
      assert.match(err.userMessage.en, /GrandLyon Connect/);
      assert.match(err.userMessage.fr, /onegeo-login/);
      assert.match(err.userMessage.fr, /GrandLyon Connect/);
      return true;
    },
  );
});

test('missing credentials fail before any request is made', async () => {
  await assert.rejects(
    fetchLayer(normalizeConfig(), 'tcl_sytral.tclparcrelais'),
    /credentials are missing/,
  );
});

test('a retired layer name falls back to the current one', async (t) => {
  clearLayerResolution();
  const asked = [];
  const { baseUrl, close } = await startServer((req, res) => {
    asked.push(req.url);
    if (!req.url.includes('_2_0_0')) {
      // What the platform does with a dataset it has republished: the old
      // name is simply not there anymore.
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ nb_results: 1, values: [{ id: 'P+R Gorge de Loup' }] }));
  });
  t.after(close);

  const config = configFor(`${baseUrl}/ws/rdata`);
  const values = await fetchLayer(config, [
    'tcl_sytral.tclparcrelais',
    'tcl_sytral.tclparcrelais_2_0_0',
  ]);

  assert.deepEqual(values, [{ id: 'P+R Gorge de Loup' }]);
  assert.equal(asked.length, 2, 'the retired name is tried first, then the current one');

  // The name that answered is remembered: the next poll must not pay for the
  // dead one again.
  asked.length = 0;
  await fetchLayer(config, ['tcl_sytral.tclparcrelais', 'tcl_sytral.tclparcrelais_2_0_0']);
  assert.equal(asked.length, 1, 'the resolved layer is reused');
  assert.match(asked[0], /_2_0_0/);
});

test('a 404 on one namespace is retried on its sibling, on the same origin', async (t) => {
  clearLayerResolution();
  const asked = [];
  const { baseUrl, close } = await startServer((req, res) => {
    asked.push(req.url);
    if (req.url.startsWith('/ws/rdata/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ values: [{ id: '1234' }] }));
  });
  t.after(close);

  const values = await fetchLayer(configFor(`${baseUrl}/ws/rdata`), 'tcl_sytral.tclparcrelais');

  assert.deepEqual(values, [{ id: '1234' }]);
  assert.ok(
    asked.some((url) => url.startsWith('/ws/grandlyon/')),
    'the other path namespace of the same host must be tried',
  );
});

test('the sibling namespace is only ever looked for on the configured origin', () => {
  assert.deepEqual(candidateBaseUrls('https://download.data.grandlyon.com/ws/rdata'), [
    'https://download.data.grandlyon.com/ws/rdata',
    'https://download.data.grandlyon.com/ws/grandlyon',
  ]);
  assert.deepEqual(candidateBaseUrls('https://download.data.grandlyon.com/ws/grandlyon'), [
    'https://download.data.grandlyon.com/ws/grandlyon',
    'https://download.data.grandlyon.com/ws/rdata',
  ]);
  assert.deepEqual(
    candidateBaseUrls('https://example.test/api'),
    ['https://example.test/api'],
    'an unrecognized base URL is used as-is, never guessed at',
  );
});

test('a dataset that no longer exists explains itself instead of reporting 404', async (t) => {
  clearLayerResolution();
  const { baseUrl, close } = await startServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  t.after(close);

  await assert.rejects(
    fetchLayer(configFor(`${baseUrl}/ws/rdata`), [
      'tcl_sytral.tclparcrelais_2_0_0',
      'tcl_sytral.tclparcrelais',
    ]),
    (err) => {
      assert.ok(err instanceof GrandLyonError);
      assert.equal(err.status, 404);
      // The names that were tried belong in the message: they are what the
      // user (or a bug report) needs to look up on the portal.
      assert.match(err.userMessage.en, /tcl_sytral\.tclparcrelais_2_0_0/);
      assert.match(err.userMessage.en, /tcl_sytral\.tclparcrelais/);
      assert.match(err.userMessage.fr, /tcl_sytral\.tclparcrelais/);
      // And it must not send the user hunting for a password that works.
      assert.match(err.userMessage.en, /not a credentials problem/);
      assert.match(err.userMessage.fr, /identifiants/);
      return true;
    },
  );
});

test('a refused account is reported even when other layer names remain', async (t) => {
  clearLayerResolution();
  let requests = 0;
  const { baseUrl, close } = await startServer((req, res) => {
    requests += 1;
    res.writeHead(401, { 'www-authenticate': 'Basic realm="rdata"' });
    res.end();
  });
  t.after(close);

  await assert.rejects(
    fetchLayer(configFor(`${baseUrl}/ws/rdata`), ['first.layer', 'second.layer']),
    (err) => {
      assert.equal(err.status, 401);
      return true;
    },
  );
  assert.equal(requests, 1, 'a wrong password is not worth probing every name for');
});

test('credentials are only replayed on the same origin or on the platform', () => {
  const origin = 'https://download.data.grandlyon.com';
  assert.equal(canReplayCredentials(new URL(`${origin}/ws/rdata`), origin), true);
  assert.equal(
    canReplayCredentials(new URL('https://data.grandlyon.com/ws/rdata'), origin),
    true,
    'the platform moves the service between its own hosts',
  );
  assert.equal(
    canReplayCredentials(new URL('http://download.data.grandlyon.com/ws'), origin),
    false,
    'never downgrade the credentials to plain HTTP',
  );
  assert.equal(
    canReplayCredentials(new URL('https://grandlyon.com.example.test/ws'), origin),
    false,
    'a look-alike hostname is not the platform',
  );
});

test('a renamed dataset is found in the platform catalogue instead of failing', async (t) => {
  clearLayerResolution();
  const asked = [];
  const { baseUrl, close } = await startServer((req, res) => {
    asked.push(req.url.split('?')[0]);
    // The index of the web service: this is where the current name lives.
    if (req.url.startsWith('/ws/rdata/all.json')) {
      sendJson(res, {
        results: [
          { table_schema: 'tcl_sytral', table_name: 'tclarret_2_0_0' },
          { table_schema: 'tcl_sytral', table_name: 'tclparcrelais_3_0_0' },
          { table_schema: 'abr_arbres_alignement', table_name: 'abrarbre' },
        ],
      });
      return;
    }
    if (req.url.startsWith('/ws/rdata/tcl_sytral.tclparcrelais_3_0_0/')) {
      sendJson(res, { values: [{ id: '1', nom: 'Gorge de Loup' }] });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(close);

  const config = configFor(`${baseUrl}/ws/rdata`);
  const names = ['tcl_sytral.tclparcrelais_2_0_0', 'tcl_sytral.tclparcrelais'];

  const values = await fetchLayer(config, names);

  assert.deepEqual(values, [{ id: '1', nom: 'Gorge de Loup' }]);
  assert.ok(
    asked.includes('/ws/rdata/all.json'),
    'the catalogue is what tells the integration the dataset was renamed',
  );
  assert.equal(resolvedLayerFor(config, names)?.layer, 'tcl_sytral.tclparcrelais_3_0_0');

  // And the discovery is paid once: the next poll goes straight to the name
  // that answered.
  asked.length = 0;
  await fetchLayer(config, names);
  assert.deepEqual(asked, ['/ws/rdata/tcl_sytral.tclparcrelais_3_0_0/all.json']);
});

test('a dataset gone for good names the closest ones the platform publishes', async (t) => {
  clearLayerResolution();
  const { baseUrl, close } = await startServer((req, res) => {
    if (req.url.startsWith('/ws/rdata/all.json')) {
      sendJson(res, {
        results: [
          { table_schema: 'tcl_sytral', table_name: 'tclpassagearret_2_0_0' },
          { table_schema: 'tcl_sytral', table_name: 'tclpointarret' },
        ],
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(close);

  await assert.rejects(
    fetchLayer(configFor(`${baseUrl}/ws/rdata`), [
      'tcl_sytral.tclparcrelais_2_0_0',
      'tcl_sytral.tclparcrelais',
    ]),
    (err) => {
      assert.equal(err.status, 404);
      // Nothing in the catalogue is that dataset, but "here is what does
      // exist" is what a bug report needs.
      assert.match(err.userMessage.en, /tcl_sytral\.tclpassagearret_2_0_0/);
      assert.match(err.userMessage.fr, /tcl_sytral\.tclpointarret/);
      return true;
    },
  );
});

test('a stem matches a republished dataset, whatever its version suffix', () => {
  assert.equal(layerStem('tcl_sytral.tclarret_2_0_0'), 'tclarret');
  assert.equal(layerStem('tcl_sytral.tclarret'), 'tclarret');
  assert.equal(layerStem('tclarret'), 'tclarret');

  const published = [
    'tcl_sytral.tclarret_1_0_0',
    'sytral.tclarret_9_0_0',
    'tcl_sytral.tclarret_3_0_0',
    'tcl_sytral.tclpointarret',
  ];
  assert.deepEqual(matchPublishedLayers(['tcl_sytral.tclarret_2_0_0'], published), [
    // Same schema first, then the highest version: the freshest plausible
    // spelling is tried first.
    'tcl_sytral.tclarret_3_0_0',
    'tcl_sytral.tclarret_1_0_0',
    'sytral.tclarret_9_0_0',
  ]);
});

test('a filtered read sends the two documented spellings of the filter', async (t) => {
  clearLayerResolution();
  let asked = '';
  const { baseUrl, close } = await startServer((req, res) => {
    asked = req.url;
    sendJson(res, { values: [] });
  });
  t.after(close);

  await fetchLayer(configFor(`${baseUrl}/ws/rdata`), 'tcl_sytral.tclpassagearret', {
    params: equalityParams('id', 1234),
  });

  const params = new URL(asked, 'http://localhost').searchParams;
  assert.equal(params.get('field'), 'id');
  assert.equal(params.get('value'), '1234');
  assert.equal(params.get('id__eq'), '1234');
  assert.equal(params.get('maxfeatures'), '-1');
});

test('a request that runs out of time says so, and says retrying is worth it', async (t) => {
  clearLayerResolution();
  const { baseUrl, close } = await startServer(() => {
    // Never answer: this is the platform under load, which is what the search
    // action used to hit.
  });
  t.after(async () => {
    await close();
  });

  await assert.rejects(
    fetchLayer(configFor(`${baseUrl}/ws/rdata`), 'tcl_sytral.tclarret', { timeoutMs: 100 }),
    (err) => {
      assert.ok(err instanceof GrandLyonError);
      assert.match(err.message, /timed out/);
      // The raw cause ("The operation was aborted due to timeout") is what the
      // user used to read, and it says nothing about what to do.
      assert.match(err.userMessage.en, /try again/i);
      assert.match(err.userMessage.fr, /réessayez/i);
      return true;
    },
  );
});
