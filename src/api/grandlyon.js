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
// It is free but account-protected: the user creates an account on the portal
// and the request carries HTTP Basic credentials. Those two fields are what
// the `grandlyon_username` / `grandlyon_password` config keys hold.
//
// Node 20+ provides `fetch` natively: no dependency needed.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { hasGrandLyonCredentials } from '../config.js';

const logger = createLogger({ name: 'grandlyon' });

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Raised when the platform answers something we cannot use. It carries the
 * HTTP status so callers can tell "wrong password" (401) from "the portal is
 * down" (5xx) and surface a helpful message to the user.
 */
export class GrandLyonError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, layer?: string }} [details]
   */
  constructor(message, { status, layer, cause } = {}) {
    super(message, { cause });
    this.name = 'GrandLyonError';
    this.status = status;
    this.layer = layer;
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
      { layer },
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

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json' },
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

  if (response.status === 401 || response.status === 403) {
    throw new GrandLyonError(
      'Data Grand Lyon refused the credentials (HTTP ' + response.status + ')',
      {
        status: response.status,
        layer,
      },
    );
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
