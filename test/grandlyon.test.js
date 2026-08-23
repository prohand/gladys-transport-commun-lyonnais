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
// The tests run against a local HTTP server: no network access needed.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { canReplayCredentials, fetchLayer, GrandLyonError } from '../src/api/grandlyon.js';
import { normalizeConfig } from '../src/config.js';

/**
 * Start a one-off HTTP server and return it with its base URL.
 * @param {http.RequestListener} handler
 */
async function startServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A config pointing at a local server, with credentials filled in. */
function configFor(baseUrl) {
  return normalizeConfig({
    grandlyon_base_url: baseUrl,
    grandlyon_username: 'me@example.com',
    grandlyon_password: 'platform-password',
  });
}

const BASIC = `Basic ${Buffer.from('me@example.com:platform-password').toString('base64')}`;

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
