// -----------------------------------------------------------------------------
// `fetch` stand-in shared by the suites that exercise the real HTTP clients.
//
// Every outgoing request is routed to an in-memory payload, keyed by a
// substring of the URL, so the tests cover the real code path (HTTP client
// included) without touching the network. Requests to an unmapped URL fail the
// test loudly.
// -----------------------------------------------------------------------------

const realFetch = globalThis.fetch;

/**
 * Replace `fetch` with the routes given, and return the list of the URLs it
 * was called with.
 * @param {Record<string, unknown>} routes
 * @returns {string[]}
 */
export function stubFetch(routes) {
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

/** Put the real `fetch` back (afterEach). */
export function restoreFetch() {
  globalThis.fetch = realFetch;
}
