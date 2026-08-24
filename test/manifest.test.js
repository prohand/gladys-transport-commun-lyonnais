// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ACTIONS } from '../src/devices/index.js';
import { DEFAULT_CONFIG, GLADYS_POLL_FREQUENCIES_MS, gladysPollFrequency } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.equal(
      typeof ACTIONS[action.key],
      'function',
      `manifest action "${action.key}" has no handler`,
    );
  }
});

test('every registered handler is declared in the manifest', () => {
  const declared = new Set((manifest.actions ?? []).map((action) => action.key));
  for (const key of Object.keys(ACTIONS)) {
    assert.ok(declared.has(key), `handler "${key}" is not declared in the manifest`);
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('the published poll frequencies are values the Gladys scheduler accepts', () => {
  // The core validates `poll_frequency` against DEVICE_POLL_FREQUENCIES and
  // rejects the WHOLE discovery batch with a 400 otherwise — which is how a
  // frequency published in seconds ended up as an empty Discovery screen.
  for (const seconds of [30, 45, 60, 120, 300, 3600]) {
    assert.ok(
      GLADYS_POLL_FREQUENCIES_MS.includes(gladysPollFrequency(seconds)),
      `${seconds}s must map to a poll frequency Gladys knows`,
    );
  }
  assert.equal(gladysPollFrequency(30), 30_000);
  assert.equal(gladysPollFrequency(60), 60_000);
  // Above a minute, Gladys has nothing slower: the extra ticks are dropped by
  // src/devices/pollSchedule.js instead.
  assert.equal(gladysPollFrequency(300), 60_000);
});

test('every poll frequency is configurable and bounded', () => {
  const pollFields = manifest.config_schema.filter((field) => field.key.endsWith('poll_frequency'));
  // One per data source: departures, Vélo'v, park & ride.
  assert.equal(pollFields.length, 3);
  for (const field of pollFields) {
    assert.equal(field.type, 'number', `${field.key} must be a number field`);
    assert.equal(field.min, 30, `${field.key} must not allow hammering the open data platforms`);
    assert.equal(field.max, 3600, `${field.key} must stay in the documented range`);
    assert.ok(
      Number.isFinite(DEFAULT_CONFIG[field.key]),
      `DEFAULT_CONFIG.${field.key} must be a number`,
    );
  }
});

// The controlled vocabulary of the integration catalog
// (`INTEGRATION_CATALOG_CATEGORIES` in the Gladys core, mirrored by the store
// indexer). It is NOT open: a key outside this list is dropped with a warning
// when the manifest is indexed, which leaves the integration filed under
// nothing at all. "transport" — the obvious word for this integration — is one
// of those non-existent keys, and `environment` is the shelf that carries the
// open-data daily-life feeds (air quality, fuel prices, water restrictions).
const INTEGRATION_CATALOG_CATEGORIES = [
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
];

test('every declared category exists in the Gladys catalog vocabulary', () => {
  for (const category of manifest.categories) {
    assert.ok(
      INTEGRATION_CATALOG_CATEGORIES.includes(category),
      `category "${category}" is not part of the Gladys catalog vocabulary`,
    );
  }
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((field) => field.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the config the code manipulates.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the credentials field is a secret field', () => {
  const password = manifest.config_schema.find((field) => field.key === 'grandlyon_password');
  assert.equal(password.type, 'secret', 'the Data Grand Lyon password must never be plain text');
});

// The store validator rejects any other type, and only accepts `placeholder`
// on the three free-text-ish types. A placeholder is displayed to the user, so
// the validator wants it translated like every other user-visible string: a
// bare string is rejected.
const ALLOWED_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'select',
  'multi_select',
  'secret',
  'oauth2',
  'account_link',
  'section',
];
const PLACEHOLDER_TYPES = ['string', 'number', 'secret'];

test('every field type is accepted by the store validator', () => {
  const fields = [
    ...manifest.config_schema,
    ...(manifest.actions ?? []).flatMap((action) => action.fields ?? []),
  ];
  for (const field of fields) {
    assert.ok(
      ALLOWED_FIELD_TYPES.includes(field.type),
      `field "${field.key}" has an unsupported type "${field.type}"`,
    );
    if (field.placeholder !== undefined) {
      assert.ok(
        PLACEHOLDER_TYPES.includes(field.type),
        `field "${field.key}" cannot declare a placeholder on a "${field.type}" field`,
      );
      assert.equal(
        typeof field.placeholder,
        'object',
        `field "${field.key}" must declare its placeholder as a { en, fr } object`,
      );
    }
  }
});

test('the store description stays within 10-100 characters', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      typeof text === 'string' && text.length >= 10 && text.length <= 100,
      `description.${lang} must be 10-100 characters, got ${text.length}`,
    );
  }
});

test('every label and description is translated in English and French', () => {
  const texts = [];
  for (const field of manifest.config_schema) {
    texts.push(field.label, field.description, field.placeholder);
  }
  for (const action of manifest.actions ?? []) {
    texts.push(action.label);
    for (const field of action.fields ?? []) {
      texts.push(field.label, field.placeholder);
    }
  }
  texts.push(manifest.description);

  for (const text of texts.filter(Boolean)) {
    assert.ok(text.en, `missing English text in ${JSON.stringify(text)}`);
    assert.ok(text.fr, `missing French text in ${JSON.stringify(text)}`);
  }
});
