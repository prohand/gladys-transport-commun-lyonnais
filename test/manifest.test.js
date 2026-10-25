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
import {
  DEPARTURE_THRESHOLDS,
  PARK_AND_RIDE_EVENTS,
  SCENE_TRIGGERS,
  VELOV_EVENTS,
} from '../src/scenes/triggers.js';
import { LANGUAGES } from '../src/i18n.js';
import { SCENE_ACTIONS } from '../src/scenes/actions.js';
import { WIDGETS } from '../src/widgets/index.js';

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
// nothing at all. `transport` — the obvious shelf for this integration — only
// joined the list in 2026-10 (with `vehicles`, `servers` and `leisure`); until
// then the integration sat in `environment`, for want of better.
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
  'transport',
  'vehicles',
  'servers',
  'leisure',
];

/**
 * The minimum version of the `gladys_version` range, as numbers.
 *
 * @returns {[number, number, number]}
 */
function gladysFloor() {
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  return [Number(minVersion[1]), Number(minVersion[2]), Number(minVersion[3])];
}

/**
 * Whether the `gladys_version` floor is at least `major.minor.0`.
 *
 * @param {number} major
 * @param {number} minor
 * @returns {boolean}
 */
function floorAtLeast(major, minor) {
  const [floorMajor, floorMinor] = gladysFloor();
  return floorMajor > major || (floorMajor === major && floorMinor >= minor);
}

test('every declared category exists in the Gladys catalog vocabulary', () => {
  for (const category of manifest.categories) {
    assert.ok(
      INTEGRATION_CATALOG_CATEGORIES.includes(category),
      `category "${category}" is not part of the Gladys catalog vocabulary`,
    );
  }
  assert.equal(new Set(manifest.categories).size, manifest.categories.length);
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(
    floorAtLeast(4, 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

// --- Search keywords and countries (Gladys >= 5.3.0) -------------------------
//
// `keywords` only feed the catalog search (never displayed), `countries` hides
// the integration from the browse views of an instance located elsewhere. Both
// are unknown to a core older than 5.3.0, which rejects the whole manifest over
// an unknown field: the floor moves with them.

test('keywords are 1-10 unique terms of 2-30 characters', () => {
  const { keywords } = manifest;
  assert.ok(Array.isArray(keywords) && keywords.length >= 1 && keywords.length <= 10);
  const normalized = keywords.map((keyword) => {
    assert.equal(typeof keyword, 'string');
    const trimmed = keyword.trim();
    assert.ok(trimmed.length >= 2 && trimmed.length <= 30, `keyword "${keyword}" length`);
    return trimmed.toLowerCase();
  });
  assert.equal(new Set(normalized).size, normalized.length, 'keywords must be unique');
});

test('countries are unique upper-case ISO 3166-1 alpha-2 codes: France only', () => {
  const { countries } = manifest;
  assert.ok(Array.isArray(countries) && countries.length >= 1 && countries.length <= 20);
  for (const country of countries) {
    assert.match(country, /^[A-Z]{2}$/);
  }
  assert.equal(new Set(countries).size, countries.length);
  // The TCL network, Vélo'v and the Data Grand Lyon feeds only exist in Lyon.
  assert.deepEqual(countries, ['FR']);
});

test('keywords, countries and music require Gladys >= 5.3.0', () => {
  const declared = ['keywords', 'countries', 'music'].filter((field) => field in manifest);
  if (declared.length === 0) return;
  assert.ok(
    floorAtLeast(5, 3),
    `${declared.join(', ')} requires gladys_version >= 5.3.0, got "${manifest.gladys_version}"`,
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
    ...capabilityFields(),
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
        `field "${field.key}" must declare its placeholder as a { en, fr, de, es } object`,
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

// Gladys shows a multi-language object in the reader's language — its UI
// speaks English, French, German and Spanish — and falls back on English for
// any other. Every user-visible text of the manifest therefore carries the
// four of them, and nothing else: a key that is not a two-letter language is
// rejected by the store schema.
test('every user-visible text is translated in English, French, German and Spanish', () => {
  const texts = [];
  (function collect(node) {
    if (Array.isArray(node)) {
      node.forEach(collect);
    } else if (node && typeof node === 'object') {
      if (typeof node.en === 'string') {
        texts.push(node);
        return;
      }
      Object.values(node).forEach(collect);
    }
  })(manifest);

  // Sanity check that the walk does find the texts: the catalog description,
  // every label, description, placeholder and option label.
  assert.ok(texts.includes(manifest.description));
  assert.ok(texts.length > 100, `only ${texts.length} texts found`);
  for (const text of texts) {
    assert.deepEqual(
      Object.keys(text),
      [...LANGUAGES],
      `${JSON.stringify(text)} must carry exactly ${LANGUAGES.join(', ')}, in that order`,
    );
    for (const language of LANGUAGES) {
      assert.ok(
        typeof text[language] === 'string' && text[language].trim().length > 0,
        `missing ${language} text in ${JSON.stringify(text)}`,
      );
    }
  }
});

test('the section texts stay within the store bounds in every language', () => {
  for (const section of manifest.config_schema.filter((field) => field.type === 'section')) {
    for (const [language, text] of Object.entries(section.description ?? {})) {
      assert.ok(
        text.length <= 1000,
        `section "${section.key}" description.${language} must be at most 1000 characters`,
      );
    }
  }
});

// --- Widgets, scene triggers and scene actions (Gladys >= 5.1.0) -------------
//
// The three capability fields of the manifest. The store validator refuses
// them below Gladys 5.1.0 (an older core rejects any unknown manifest field),
// bounds their counts and labels, and the scene editor and the dashboard can
// only call what the code registers: a declaration without a handler is a card
// that fails, a handler without a declaration is dead code.

/** Every widget, scene trigger and scene action the manifest declares. */
function capabilityDeclarations() {
  return [
    ...(manifest.widgets ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ];
}

/** Every form field of those declarations (widget settings included). */
function capabilityFields() {
  return capabilityDeclarations().flatMap((declaration) => [
    ...(declaration.fields ?? []),
    ...(declaration.settings ?? []),
  ]);
}

// `requestWidgetRefresh` and the widget action keys share this pattern in the
// SDK; the scene keys follow the config_schema key rule.
const CAPABILITY_KEY = /^[a-z0-9_]{2,32}$/;
const SCALAR_TYPES = ['string', 'number', 'boolean'];

test('widgets and scene declarations require Gladys >= 5.1.0', () => {
  assert.ok(
    floorAtLeast(5, 1),
    `widgets and scene declarations require gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

test('the capability declarations stay within the store bounds', () => {
  assert.ok(manifest.widgets.length >= 1 && manifest.widgets.length <= 5);
  assert.ok(manifest.scene_triggers.length >= 1 && manifest.scene_triggers.length <= 20);
  assert.ok(manifest.scene_actions.length >= 1 && manifest.scene_actions.length <= 20);

  for (const declaration of capabilityDeclarations()) {
    assert.match(declaration.key, CAPABILITY_KEY, `"${declaration.key}" is not a valid key`);
    for (const [lang, text] of Object.entries(declaration.label)) {
      assert.ok(
        text.length >= 3 && text.length <= 30,
        `"${declaration.key}" label.${lang} must be 3-30 characters, got ${text.length}`,
      );
    }
    for (const [lang, text] of Object.entries(declaration.description ?? {})) {
      assert.ok(
        text.length <= 100,
        `"${declaration.key}" description.${lang} must be at most 100 characters, got ${text.length}`,
      );
    }
    assert.ok((declaration.fields ?? []).length <= 10, `"${declaration.key}" has too many fields`);
    assert.ok(
      (declaration.settings ?? []).length <= 10,
      `"${declaration.key}" has too many settings`,
    );
    for (const entry of [...(declaration.variables ?? []), ...(declaration.outputs ?? [])]) {
      assert.ok(
        SCALAR_TYPES.includes(entry.type),
        `"${declaration.key}.${entry.key}" must be a string, a number or a boolean`,
      );
    }
    assert.ok((declaration.variables ?? []).length <= 20);
    assert.ok((declaration.outputs ?? []).length <= 20);
  }
  for (const action of manifest.scene_actions) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
  }
});

test('widget settings never hold a secret', () => {
  // The settings live in the dashboard JSON, which every user of a shared
  // dashboard can read: the store refuses these types there.
  for (const widget of manifest.widgets) {
    for (const setting of widget.settings ?? []) {
      assert.ok(
        !['secret', 'oauth2', 'account_link'].includes(setting.type),
        `widget "${widget.key}" cannot declare a "${setting.type}" setting`,
      );
    }
  }
});

test('every declared widget has a handler, and vice versa', () => {
  assert.deepEqual(
    manifest.widgets.map((widget) => widget.key).sort(),
    Object.keys(WIDGETS).sort(),
  );
});

test('every declared scene action has a handler, and vice versa', () => {
  assert.deepEqual(
    manifest.scene_actions.map((action) => action.key).sort(),
    Object.keys(SCENE_ACTIONS).sort(),
  );
});

test('every declared scene trigger is fired by the code, and vice versa', () => {
  assert.deepEqual(
    manifest.scene_triggers.map((trigger) => trigger.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
});

test('the trigger options are the values the code sends', () => {
  // The core compares them for equality: an option the code never sends is a
  // scene that never runs, and the reverse an event no scene can filter on.
  const optionsOf = (triggerKey, fieldKey) =>
    manifest.scene_triggers
      .find((trigger) => trigger.key === triggerKey)
      .fields.find((field) => field.key === fieldKey)
      .options.map((option) => option.value);

  assert.deepEqual(
    optionsOf(SCENE_TRIGGERS.DEPARTURE_APPROACHING, 'threshold'),
    DEPARTURE_THRESHOLDS.map(String),
  );
  assert.deepEqual(
    optionsOf(SCENE_TRIGGERS.VELOV_STATION_CHANGED, 'event'),
    Object.values(VELOV_EVENTS),
  );
  assert.deepEqual(
    optionsOf(SCENE_TRIGGERS.PARK_AND_RIDE_CHANGED, 'event'),
    Object.values(PARK_AND_RIDE_EVENTS),
  );
});

test('every device field of a scene or a widget lists the integration devices', () => {
  // The code resolves these values as device external_ids: a static select
  // there would hand it something it cannot look up.
  for (const field of capabilityFields()) {
    if (['stop', 'station', 'facility'].includes(field.key)) {
      assert.equal(field.type, 'select');
      assert.equal(field.source, 'devices', `"${field.key}" must list the created devices`);
    }
  }
});
