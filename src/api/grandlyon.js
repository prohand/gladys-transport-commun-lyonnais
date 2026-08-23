// -----------------------------------------------------------------------------
// HTTP client for the Data Grand Lyon open data platform.
//
// TCL real-time data (next departures, park & ride occupancy) is published by
// the Métropole de Lyon on https://data.grandlyon.com. The "rdata" web service
// exposes one JSON endpoint per layer:
//
//   GET <base>/<layer>/all.json?maxfeatures=-1[&field=<attr>&value=<v>]
//   -> { "nb_results": 12, "values": [ { ... }, ... ] }
//
// and one index of everything it serves:
//
//   GET <base>/all.json
//   -> { "results": [ { "table_schema": "tcl_sytral", "table_name": "tclarret" }, ... ] }
//
// That index is what saves the integration when a dataset is renamed: rather
// than failing until someone ships a new hard-coded name, the client looks the
// current name up and keeps using it (see `discoverCandidates`).
//
// Filtering is documented as `field=<attribute>&value=<value>`, or as the
// Django-flavoured `<attribute>__eq=<value>` (also `__gt`, `__gte`, `__lt`,
// `__lte`, `__in`). A JSON `filter` parameter is NOT part of the service: the
// platform silently ignores it, which turns what looks like a one-stop request
// into a download of the whole layer. `equalityParams` below sends both
// documented spellings, and the callers re-check the result client-side.
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

// How long a single request may take. A filtered read answers in well under a
// second; a whole-layer download (the stop directory is several thousand
// records with their geometry) regularly needs more than the fifteen seconds
// that are plenty for everything else, and timing it out at fifteen is exactly
// the "Data Grand Lyon is unreachable (The operation was aborted due to
// timeout)" the search action used to fail with. Hence one budget per kind of
// read instead of one for all three.
const REQUEST_TIMEOUT_MS = 15_000;
export const BULK_TIMEOUT_MS = 60_000;
// Probes exist to answer "does this account work?" quickly, and they run in
// parallel behind a button whose own timeout is counted in seconds: they get
// the shortest budget of the three.
export const PROBE_TIMEOUT_MS = 10_000;

// How long the list of published layers stays reusable. It only changes when
// the platform publishes or retires a dataset, i.e. a few times a year, but it
// is read at the worst possible moment (a poll that just failed), so it is not
// cached forever either.
const CATALOGUE_TTL_MS = 10 * 60_000;

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
 * The base URLs to try for a layer, most likely first.
 *
 * The web service is published under two path namespaces on the download
 * host: the historical `/ws/rdata` one and `/ws/grandlyon`. Which of them
 * serves a given dataset has changed over time, and asking the wrong one
 * yields a 404 that says nothing about the cause. So when the configured base
 * answers 404 we retry the sibling namespace — on the SAME origin, never on
 * another host, so the credentials never travel anywhere the user did not
 * configure.
 *
 * @param {string} baseUrl normalized base URL from the configuration
 * @returns {string[]}
 */
export function candidateBaseUrls(baseUrl) {
  for (const [suffix, sibling] of [
    ['/ws/rdata', '/ws/grandlyon'],
    ['/ws/grandlyon', '/ws/rdata'],
  ]) {
    if (baseUrl.endsWith(suffix)) {
      return [baseUrl, `${baseUrl.slice(0, -suffix.length)}${sibling}`];
    }
  }
  return [baseUrl];
}

/**
 * Which (base URL, layer name) pair actually answered, per candidate list.
 *
 * Probing costs one HTTP round trip per name that no longer exists, and the
 * answer only changes when the platform republishes a dataset: remember it
 * for the lifetime of the process rather than paying it on every poll. The
 * entry is dropped as soon as the pair stops answering, so a rename is picked
 * up without a restart.
 *
 * @type {Map<string, { baseUrl: string, layer: string }>}
 */
const resolvedLayers = new Map();

/**
 * The list of layers the platform publishes, per base URL.
 *
 * Read from `<base>/all.json` the first time a dataset cannot be found under
 * any name we know, then reused: it is a catalogue of every table of the
 * platform, so it is not something to fetch on a whim.
 *
 * @type {Map<string, { expiresAt: number, promise: Promise<string[]> }>}
 */
const publishedLayers = new Map();

/** Forget the resolved layer names (used on config change and by tests). */
export function clearLayerResolution() {
  resolvedLayers.clear();
  publishedLayers.clear();
}

/**
 * The (base URL, layer name) pair a previous call settled on, if any.
 *
 * Exposed so the configuration screen can tell the user which dataset it is
 * actually reading — after a rename, that is the answer to "is it working?".
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string | string[]} layers the same candidate list passed to `fetchLayer`
 * @returns {{ baseUrl: string, layer: string } | undefined}
 */
export function resolvedLayerFor(config, layers) {
  const names = (Array.isArray(layers) ? layers : [layers]).filter(Boolean);
  return resolvedLayers.get(cacheKeyFor(config, names));
}

/**
 * What to tell the user when none of the names we know is published anymore.
 *
 * A 404 here is not the user's fault and no amount of retrying fixes it: the
 * Métropole renames the TCL layers when the network changes (that is what the
 * `_2_0_0` suffixes are), and the integration has to learn the new name. Since
 * the client now reads the platform's own index before giving up, reaching
 * this message means the dataset is not merely renamed but gone (or renamed
 * beyond recognition), so the message also lists the closest names the
 * platform does publish: that is the one piece of information a bug report
 * needs and nobody can guess from the outside.
 *
 * @param {string[]} layers the candidate names that all answered 404
 * @param {string[]} [published] the closest names the platform actually serves
 * @returns {{ en: string, fr: string }}
 */
function layerNotFoundMessage(layers, published = []) {
  const tried = layers.join(', ');
  const closest = published.slice(0, 5).join(', ');
  const hint = closest
    ? {
        en: ` The platform publishes these look-alikes: ${closest}.`,
        fr: ` La plateforme publie ces noms voisins : ${closest}.`,
      }
    : { en: '', fr: '' };
  return {
    en:
      `Data Grand Lyon answered HTTP 404: none of the datasets this integration knows is ` +
      `published anymore (tried: ${tried}). The platform renames its TCL layers when the ` +
      `network changes; look the current name up on https://data.grandlyon.com and report ` +
      `it at https://github.com/prohand/gladys-transport-commun-lyonnais/issues so the ` +
      `integration can follow.${hint.en} Your account is fine — this is not a credentials ` +
      `problem.`,
    fr:
      `Data Grand Lyon a répondu HTTP 404 : aucun des jeux de données connus de ` +
      `l’intégration n’est encore publié (essayés : ${tried}). La plateforme renomme les ` +
      `couches TCL à chaque évolution du réseau ; retrouvez le nom actuel sur ` +
      `https://data.grandlyon.com et signalez-le sur ` +
      `https://github.com/prohand/gladys-transport-commun-lyonnais/issues pour que ` +
      `l’intégration suive.${hint.fr} Votre compte n’est pas en cause : ce n’est pas un ` +
      `problème d’identifiants.`,
  };
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
 * What to tell the user when the request ran out of time.
 *
 * The bare cause ("The operation was aborted due to timeout") reads like a
 * bug in the integration, while it usually means the platform took longer
 * than the budget to serve a whole dataset. Say which read timed out, and say
 * that trying again is worth it — the answer is then cached.
 *
 * @param {string} layer the layer being read
 * @param {number} timeoutMs the budget that expired
 * @returns {{ en: string, fr: string }}
 */
function timedOutMessage(layer, timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000);
  return {
    en:
      `Data Grand Lyon did not answer within ${seconds} s while reading ${layer}. The ` +
      `platform is slow at peak time and this read downloads a whole dataset: try again in ` +
      `a moment — once it succeeds, the answer is kept in memory and the next searches are ` +
      `instant.`,
    fr:
      `Data Grand Lyon n’a pas répondu en ${seconds} s pendant la lecture de ${layer}. La ` +
      `plateforme est lente aux heures de pointe et cette lecture télécharge un jeu de ` +
      `données entier : réessayez dans un instant — une fois la réponse obtenue, elle est ` +
      `gardée en mémoire et les recherches suivantes sont immédiates.`,
  };
}

/**
 * What to tell the user when the request never reached the platform.
 *
 * @param {string} layer the layer being read
 * @param {string} reason the underlying cause, worth keeping: DNS, TLS and
 *   proxy failures all look the same from here otherwise
 * @returns {{ en: string, fr: string }}
 */
function unreachableMessage(layer, reason) {
  return {
    en:
      `Data Grand Lyon could not be reached while reading ${layer} (${reason}). Check that ` +
      `the container has internet access and that the base URL of the web service is ` +
      `correct.`,
    fr:
      `Data Grand Lyon n’a pas pu être contacté pendant la lecture de ${layer} (${reason}). ` +
      `Vérifiez que le conteneur a accès à internet et que l’URL de base du service web est ` +
      `correcte.`,
  };
}

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
 * @param {number} [timeoutMs] budget for each hop of the chain
 * @returns {Promise<Response>} the first non-redirect response
 */
async function getWithBasicAuth(url, credentials, layer, timeoutMs = REQUEST_TIMEOUT_MS) {
  const origin = url.origin;
  let current = url;

  for (let hop = 0; ; hop += 1) {
    let response;
    try {
      response = await fetch(current, {
        headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network error or timeout: never let the raw AbortError bubble up, the
      // caller only needs to know the layer could not be read — and the user
      // needs to know whether waiting helps (timeout) or not (no route to the
      // platform at all).
      const timedOut = err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError';
      throw new GrandLyonError(
        timedOut
          ? `Data Grand Lyon timed out after ${timeoutMs} ms (${layer})`
          : `Data Grand Lyon is unreachable (${err.message})`,
        {
          layer,
          cause: err,
          userMessage: timedOut
            ? timedOutMessage(layer, timeoutMs)
            : unreachableMessage(layer, err.message),
        },
      );
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
 * Query parameters expressing "this attribute equals this value".
 *
 * The service documents two spellings of the same predicate and says nothing
 * about which layers implement which, so both are sent: they cannot disagree
 * (same attribute, same value), and one of them being ignored is the
 * difference between a one-record answer and a download of the whole network.
 * Callers still re-check the records they get back, because a service that
 * ignores BOTH would otherwise silently answer about the wrong stop.
 *
 * @param {string} field attribute name, e.g. 'id'
 * @param {string | number} value value it must equal
 * @returns {Record<string, string>}
 */
export function equalityParams(field, value) {
  return { field, value: String(value), [`${field}__eq`]: String(value) };
}

/**
 * Call one rdata layer and return its `values` array.
 *
 * Several spellings of the same dataset may be passed: the platform versions
 * its layer names (`tcl_sytral.tclarret`, then `tcl_sytral.tclarret_2_0_0`)
 * and retires the previous one, so the caller lists the names it knows,
 * newest first, and this function keeps the one that answers. A 404 is
 * therefore never fatal on its own — and when every known name 404s, the
 * platform's own index is read to find what the dataset is called today,
 * which is the difference between a rename costing one extra request and a
 * rename breaking the integration until someone ships a new name.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string | string[]} layers layer name(s), e.g. 'tcl_sytral.tclarret'
 * @param {{ params?: Record<string, string | number>, maxFeatures?: number, timeoutMs?: number }} [options]
 *   `params` are extra query parameters, typically from `equalityParams`:
 *   filtering server-side is what keeps a per-stop request small instead of
 *   downloading the whole network.
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function fetchLayer(
  config,
  layers,
  { params, maxFeatures = -1, timeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  const names = (Array.isArray(layers) ? layers : [layers]).filter(Boolean);
  // Errors name the layer the caller actually asked for, not the fallback we
  // happened to stop on.
  const primary = names[0];

  if (!hasGrandLyonCredentials(config)) {
    throw new GrandLyonError(
      'Data Grand Lyon credentials are missing: fill them in the integration configuration.',
      {
        layer: primary,
        userMessage: {
          en: 'No Data Grand Lyon credentials: fill in the username and password.',
          fr: 'Identifiants Data Grand Lyon absents : renseignez le nom d’utilisateur et le mot de passe.',
        },
      },
    );
  }

  const credentials = basicCredentials(config);
  const cacheKey = cacheKeyFor(config, names);

  const queue = layerCandidates(config, names, cacheKey);
  const attempted = new Set();
  // Names the platform publishes for this dataset family, read from its index
  // once every name we know has 404ed. `null` means "not looked up yet", which
  // is also what tells the loop it still has something left to try.
  let published = null;

  while (true) {
    const candidate = queue.shift();

    if (!candidate) {
      if (published !== null) {
        break;
      }
      const discovery = await discoverCandidates(config, names, credentials);
      published = discovery.published;
      const extra = discovery.candidates.filter((entry) => !attempted.has(candidateKey(entry)));
      if (extra.length > 0) {
        logger.warn(
          `Every known name of ${primary} answered 404; the platform now publishes ` +
            `${extra.map((entry) => entry.layer).join(', ')}`,
        );
        queue.push(...extra);
      }
      continue;
    }

    if (attempted.has(candidateKey(candidate))) {
      continue;
    }
    attempted.add(candidateKey(candidate));

    const { baseUrl, layer } = candidate;

    const url = new URL(`${baseUrl}/${layer}/all.json`);
    url.searchParams.set('maxfeatures', String(maxFeatures));
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, String(value));
    }

    logger.debug(`GET ${url.toString()}`);

    const response = await getWithBasicAuth(url, credentials, layer, timeoutMs);

    if (response.status === 401 || response.status === 403) {
      throw new GrandLyonError(
        `Data Grand Lyon refused the credentials (HTTP ${response.status})`,
        {
          status: response.status,
          layer,
          userMessage: CREDENTIALS_REFUSED,
        },
      );
    }
    if (response.status === 404) {
      // This spelling is gone (or never existed on this namespace): try the
      // next one rather than reporting a status code the user cannot act on.
      logger.debug(`No layer ${layer} under ${baseUrl}, trying the next candidate`);
      resolvedLayers.delete(cacheKey);
      continue;
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

    resolvedLayers.set(cacheKey, { baseUrl, layer });
    logger.debug(`Layer ${layer} -> ${values.length} record(s)`);
    return values;
  }

  throw new GrandLyonError(
    `Data Grand Lyon answered HTTP 404 for every known name of ${primary} (${names.join(', ')})`,
    {
      status: 404,
      layer: primary,
      userMessage: layerNotFoundMessage(names, published ?? []),
    },
  );
}

/**
 * Every (base URL, layer name) pair worth trying, most likely first.
 *
 * The name varies fastest because a republished dataset is far more common
 * than a moved endpoint; a pair that answered before is hoisted to the front
 * so the steady state costs exactly one request.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string[]} names candidate layer names, newest first
 * @param {string} cacheKey key of the remembered resolution
 * @returns {{ baseUrl: string, layer: string }[]}
 */
function layerCandidates(config, names, cacheKey) {
  const candidates = [];
  for (const baseUrl of candidateBaseUrls(config.grandlyon_base_url)) {
    for (const layer of names) {
      candidates.push({ baseUrl, layer });
    }
  }

  const resolved = resolvedLayers.get(cacheKey);
  if (!resolved) {
    return candidates;
  }
  return [
    resolved,
    ...candidates.filter(
      (candidate) => candidate.baseUrl !== resolved.baseUrl || candidate.layer !== resolved.layer,
    ),
  ];
}

/** Key under which a candidate list remembers the pair that answered. */
function cacheKeyFor(config, names) {
  return `${config.grandlyon_base_url}|${names.join(',')}`;
}

/** Identity of one (base URL, layer) pair, so a candidate is tried once. */
function candidateKey({ baseUrl, layer }) {
  return `${baseUrl}|${layer}`;
}

/** The HTTP Basic value for the configured account. */
function basicCredentials(config) {
  return Buffer.from(`${config.grandlyon_username}:${config.grandlyon_password}`).toString(
    'base64',
  );
}

/**
 * The dataset family a layer name belongs to.
 *
 * The platform expresses a new version of a dataset as a suffix on the table
 * name (`tclarret` -> `tclarret_2_0_0`), so dropping that suffix is what makes
 * "the same dataset, republished" recognizable. The schema is dropped too: it
 * has moved in the past (a layer served under `tcl_sytral` reappearing under
 * `sytral`), and the table name alone is specific enough here.
 *
 * @param {string} name a layer name, with or without its schema
 * @returns {string}
 */
export function layerStem(name) {
  const dot = String(name).indexOf('.');
  const table = dot === -1 ? String(name) : String(name).slice(dot + 1);
  return table.replace(/_\d+(?:_\d+)*$/, '').toLowerCase();
}

/**
 * The published names that are the same dataset as one of `names`, best first.
 *
 * "Best" is the freshest plausible spelling: same schema before another one
 * (the platform keeps its schemas for years), then the highest version suffix,
 * which sorts naturally in reverse lexicographic order (`_2_0_0` before
 * `_1_0_0` before no suffix at all).
 *
 * @param {string[]} names the candidate names the integration knows
 * @param {string[]} published every layer name the platform serves
 * @returns {string[]}
 */
export function matchPublishedLayers(names, published) {
  const stems = new Set(names.map(layerStem));
  const schemas = new Set(
    names.filter((name) => name.includes('.')).map((name) => name.slice(0, name.indexOf('.'))),
  );
  const known = new Set(names);

  return published
    .filter((name) => !known.has(name) && stems.has(layerStem(name)))
    .sort((a, b) => {
      const schemaRank =
        Number(schemas.has(b.slice(0, b.indexOf('.')))) -
        Number(schemas.has(a.slice(0, a.indexOf('.'))));
      return schemaRank !== 0 ? schemaRank : b.localeCompare(a);
    });
}

/**
 * The published names that merely look related, for the error message.
 *
 * When a dataset is retired for good, the useful thing to show is what the
 * platform serves around it — `tclparcrelais` gone but `tclparcrelaispmr`
 * present says something a bare 404 does not. A four-character prefix of the
 * table name is loose enough to catch a renamed dataset and tight enough not
 * to list the whole catalogue.
 *
 * @param {string[]} names the candidate names the integration knows
 * @param {string[]} published every layer name the platform serves
 * @returns {string[]}
 */
export function similarPublishedLayers(names, published) {
  const prefixes = names.map((name) => layerStem(name).slice(0, 4)).filter(Boolean);
  return published
    .filter((name) => prefixes.some((prefix) => layerStem(name).startsWith(prefix)))
    .sort();
}

/**
 * Every layer name published under one base URL.
 *
 * `<base>/all.json` is the index of the web service: one entry per table, with
 * its schema and its name. It is the same endpoint the portal's own dataset
 * pages are built from, so it always knows the current spelling.
 *
 * @param {string} baseUrl
 * @param {string} credentials base64 "user:password"
 * @returns {Promise<string[]>}
 */
function listPublishedLayers(baseUrl, credentials) {
  const cached = publishedLayers.get(baseUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = (async () => {
    const response = await getWithBasicAuth(
      new URL(`${baseUrl}/all.json`),
      credentials,
      'catalogue',
      BULK_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new GrandLyonError(`Data Grand Lyon catalogue answered HTTP ${response.status}`, {
        status: response.status,
        layer: 'catalogue',
      });
    }
    const body = await response.json();
    const results = Array.isArray(body) ? body : (body?.results ?? []);
    if (!Array.isArray(results)) {
      throw new GrandLyonError('Unexpected Data Grand Lyon catalogue payload', {
        layer: 'catalogue',
      });
    }
    return results
      .map((entry) => {
        const schema = pickString(entry, ['table_schema', 'schema']);
        const table = pickString(entry, ['table_name', 'name']);
        if (!table) {
          return '';
        }
        return schema ? `${schema}.${table}` : table;
      })
      .filter(Boolean);
  })().catch((err) => {
    // Never cache a failure: the catalogue is read when something is already
    // wrong, and the next attempt must not inherit this one.
    publishedLayers.delete(baseUrl);
    throw err;
  });

  publishedLayers.set(baseUrl, { expiresAt: Date.now() + CATALOGUE_TTL_MS, promise });
  return promise;
}

/**
 * What the platform publishes today for a dataset whose known names all 404ed.
 *
 * Failing to read the catalogue is not worth an error of its own: the caller
 * is already on its way to reporting "this dataset is gone", and an
 * unreachable index only means it will do so without the extra detail.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string[]} names the candidate names the integration knows
 * @param {string} credentials base64 "user:password"
 * @returns {Promise<{ candidates: { baseUrl: string, layer: string }[], published: string[] }>}
 */
async function discoverCandidates(config, names, credentials) {
  const candidates = [];
  const published = [];

  for (const baseUrl of candidateBaseUrls(config.grandlyon_base_url)) {
    let layers;
    try {
      layers = await listPublishedLayers(baseUrl, credentials);
    } catch (err) {
      logger.debug(`Catalogue unreadable under ${baseUrl}: ${err.message}`);
      continue;
    }

    for (const layer of matchPublishedLayers(names, layers)) {
      candidates.push({ baseUrl, layer });
    }
    published.push(...similarPublishedLayers(names, layers));

    // The dataset is served from one namespace: once found, there is nothing
    // to gain from downloading the other catalogue too.
    if (candidates.length > 0) {
      break;
    }
  }

  return { candidates, published: [...new Set(published)] };
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
