// -----------------------------------------------------------------------------
// A throwaway HTTP server, so the Data Grand Lyon client can be tested for
// real — redirects, status codes, query parameters and all — without touching
// the network. Shared by the client and the TCL tests, which need the exact
// same fixture: a local origin standing in for the platform, with credentials
// the requests are expected to carry.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { normalizeConfig } from '../../src/config.js';

export const USERNAME = 'me@example.com';
export const PASSWORD = 'platform-password';
export const BASIC = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;

/**
 * Start a one-off HTTP server and return it with its base URL.
 * @param {http.RequestListener} handler
 */
export async function startServer(handler) {
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
export function configFor(baseUrl) {
  return normalizeConfig({
    grandlyon_base_url: baseUrl,
    grandlyon_username: USERNAME,
    grandlyon_password: PASSWORD,
  });
}

/** Answer a request with a JSON payload. */
export function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
