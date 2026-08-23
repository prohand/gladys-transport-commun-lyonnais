// -----------------------------------------------------------------------------
// HTTP client for the Data Grand Lyon open data platform.
//
// TCL real-time data (next departures, park & ride occupancy) is published by
// the Métropole de Lyon on https://data.grandlyon.com. The "rdata" web service
// exposes one JSON endpoint per layer:
//
//   GET <base>/<layer>/all.json?maxfeatures=-1[&filter=<json>]
//   -> { "nb_results": 12, "values": [ { ... }, ... ] }
//
// It is free but account-protected, and the way the account works trips
// everybody up at least once:
//
//   - you sign in on the portal with GrandLyon Connect (the single sign-on
//     shared by every Métropole service, moncompte.grandlyon.com);
//   - the web service does NOT accept that password. It only speaks HTTP
//     Basic, against a password specific to the data platform that you set
//     once on https://data.grandlyon.com/onegeo-login/fr/profile/ — the login
//     being, in general, the email address of the GrandLyon Connect account.
//
// Sending the GrandLyon Connect password here therefore yields a plain 401,
// which is why the message raised below spells the distinction out instead of
// just reporting the status code. It also names the way out of the trap the
// profile page sets: it only offers a "change your password" form, which asks
// for an old password an account created through the single sign-on never
// had. The password is set through the platform's own forgotten-password
// link, reachable once logged out of the portal.
//
// Redirects need care too: the platform moved the web service from
// data.grandlyon.com/fr/datapusher/ws/rdata to download.data.grandlyon.com/ws
// and answers the old URL with a cross-host redirect. `fetch` follows it but
// strips the Authorization header on the way (a deliberate WHATWG rule: no
// credential is ever replayed to another origin), so the request lands
// unauthenticated and comes back 401 with perfectly valid credentials. We
// follow the redirects ourselves and re-attach the header, as long as we stay
// on an https grandlyon.com host.
//
// Node 20+ provides `fetch` natively: no dependency needed.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { hasGrandLyonCredentials } from '../config.js';

const logger = createLogger({ name: 'grandlyon' });

const REQUEST_TIMEOUT_MS = 15_000;

// How many cross-host redirects we are willing to follow ourselves. The
// platform needs one (portal -> download host); anything beyond three is a
// loop, not a move.
const MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Whether we accept to replay the Basic credentials on a redirect target.
 *
 * The rule we are working around exists for a good reason — credentials must
 * not leak to a third party — so we keep it and only relax it where it costs
 * nothing: the origin we were already talking to (`fetch` replays the header
 * there itself), and the platform's own hosts over TLS. A redirect anywhere
 * else is refused rather than followed unauthenticated, because "somewhere
 * else asked for your password" deserves an error, not a silent 401.
 *
 * @param {URL} target the redirect target
 * @param {string} origin origin of the request the user actually configured
 * @returns {boolean}
 */
export function canReplayCredentials(target, origin) {
  if (target.origin === origin) {
    return true;
  }
  return (
    target.protocol === 'https:' &&
    (target.hostname === 'grandlyon.com' || target.hostname.endsWith('.grandlyon.com'))
  );
}

/**
 * What to tell the user when the platform answers 401/403.
 *
 * This is the single most common setup mistake of this integration, so the
 * message names the cause rather than the status code: the web service wants
 * the password defined on the data platform itself, not the GrandLyon Connect
 * password used to sign in on the portal.
 */
const CREDENTIALS_REFUSED = {
  en:
    'Data Grand Lyon refused the credentials. The web service does not accept your ' +
    'GrandLyon Connect password: sign in on the portal, then set a password specific to ' +
    'the data platform on https://data.grandlyon.com/onegeo-login/fr/profile/ and enter ' +
    'it here, with the email address of your account as the username. If that page asks ' +
    'for an old password you never set, log out of the portal first and use its ' +
    '"Mot de passe oublié ?" link.',
  fr:
    'Data Grand Lyon a refusé les identifiants. Le service web n’accepte pas le mot de ' +
    'passe GrandLyon Connect : connectez-vous au portail, définissez un mot de passe ' +
    'propre à la plateforme de données sur https://data.grandlyon.com/onegeo-login/fr/profile/ ' +
    'puis saisissez-le ici, avec l’adresse email de votre compte comme identifiant. Si ' +
    'cette page réclame un ancien mot de passe que vous n’avez jamais défini, ' +
    'déconnectez-vous du portail et utilisez le lien « Mot de passe oublié ? ».',
};

/**
 * Raised when the platform answers something we cannot use. It carries the
 * HTTP status so callers can tell "wrong password" (401) from "the portal is
 * down" (5xx) and surface a helpful message to the user.
 */
export class GrandLyonError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, layer?: string, userMessage?: { en: string, fr: string } }} [details]
   */
  constructor(message, { status, layer, cause, userMessage } = {}) {
    super(message, { cause });
    this.name = 'GrandLyonError';
    this.status = status;
    this.layer = layer;
    // Bilingual explanation displayed as-is in the Gladys configuration screen
    // (see the `test_grandlyon` action). Only set when we have something more
    // useful to say than the raw message.
    this.userMessage = userMessage;
  }
}

/**
 * GET a URL with HTTP Basic credentials, following the platform's redirects
 * ourselves so the Authorization header survives them.
 *
 * `redirect: 'manual'` is what makes this possible: unlike a browser, Node
 * hands back the real 3xx response and its Location header instead of an
 * opaque one.
 *
 * @param {URL} url
 * @param {string} credentials base64 "user:password"
 * @param {string} layer only used to describe errors
 * @returns {Promise<Response>} the first non-redirect response
 */
async function getWithBasicAuth(url, credentials, layer) {
  const origin = url.origin;
  let current = url;

  for (let hop = 0; ; hop += 1) {
    let response;
    try {
      response = await fetch(current, {
        headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error or timeout: never let the raw AbortError bubble up, the
      // caller only needs to know the layer could not be read.
      throw new GrandLyonError(`Data Grand Lyon is unreachable (${err.message})`, {
        layer,
        cause: err,
      });
    }

    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }

    if (hop >= MAX_REDIRECTS) {
      throw new GrandLyonError(`Data Grand Lyon redirects in a loop (${current})`, { layer });
    }

    let target;
    try {
      target = new URL(location, current);
    } catch {
      throw new GrandLyonError(`Data Grand Lyon sent an unusable redirect (${location})`, {
        layer,
      });
    }

    if (!canReplayCredentials(target, origin)) {
      // Somebody is trying to make us hand the credentials to another host:
      // stop here rather than replaying them.
      throw new GrandLyonError(
        `Data Grand Lyon redirects outside of the platform (${target.origin}), credentials not replayed`,
        { layer },
      );
    }

    logger.debug(`Redirected to ${target.toString()}, replaying the credentials`);
    current = target;
  }
}

/**
 * Call one rdata layer and return its `values` array.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string} layer layer name, e.g. 'tcl_sytral.tclpassagearret'
 * @param {{ filter?: Record<string, unknown>, maxFeatures?: number }} [options]
 *   `filter` is sent as the JSON `filter` query parameter supported by rdata,
 *   which is what keeps a per-stop request small instead of downloading the
 *   whole network.
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function fetchLayer(config, layer, { filter, maxFeatures = -1 } = {}) {
  if (!hasGrandLyonCredentials(config)) {
    throw new GrandLyonError(
      'Data Grand Lyon credentials are missing: fill them in the integration configuration.',
      {
        layer,
        userMessage: {
          en: 'No Data Grand Lyon credentials: fill in the username and password.',
          fr: 'Identifiants Data Grand Lyon absents : renseignez le nom d’utilisateur et le mot de passe.',
        },
      },
    );
  }

  const url = new URL(`${config.grandlyon_base_url}/${layer}/all.json`);
  url.searchParams.set('maxfeatures', String(maxFeatures));
  if (filter) {
    url.searchParams.set('filter', JSON.stringify(filter));
  }

  logger.debug(`GET ${url.toString()}`);

  const credentials = Buffer.from(
    `${config.grandlyon_username}:${config.grandlyon_password}`,
  ).toString('base64');

  const response = await getWithBasicAuth(url, credentials, layer);

  if (response.status === 401 || response.status === 403) {
    throw new GrandLyonError(`Data Grand Lyon refused the credentials (HTTP ${response.status})`, {
      status: response.status,
      layer,
      userMessage: CREDENTIALS_REFUSED,
    });
  }
  if (!response.ok) {
    throw new GrandLyonError(`Data Grand Lyon answered HTTP ${response.status}`, {
      status: response.status,
      layer,
    });
  }

  const body = await response.json();
  // The service is consistent on `values`, but a few layers answer a bare
  // array: accept both rather than crashing on a shape detail.
  const values = Array.isArray(body) ? body : (body.values ?? []);
  if (!Array.isArray(values)) {
    throw new GrandLyonError(`Unexpected payload for layer ${layer}`, { layer });
  }

  logger.debug(`Layer ${layer} -> ${values.length} record(s)`);
  return values;
}

/**
 * Read the first defined (non-null, non-empty) value among several candidate
 * keys of a record.
 *
 * Data Grand Lyon renamed a few columns across dataset versions (and the 2025
 * unified TCL network shuffled some more). Rather than pinning one spelling
 * and breaking on the next revision, every parser in this integration reads
 * through this helper.
 *
 * @param {Record<string, unknown>} record
 * @param {string[]} keys candidate column names, most specific first
 * @returns {unknown} the first usable value, or undefined
 */
export function pick(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

/**
 * Same as `pick`, coerced to a finite number (or undefined).
 * @param {Record<string, unknown>} record
 * @param {string[]} keys
 * @returns {number | undefined}
 */
export function pickNumber(record, keys) {
  const value = Number(pick(record, keys));
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Same as `pick`, coerced to a trimmed string (or undefined).
 * @param {Record<string, unknown>} record
 * @param {string[]} keys
 * @returns {string | undefined}
 */
export function pickString(record, keys) {
  const value = pick(record, keys);
  return value === undefined ? undefined : String(value).trim();
}
