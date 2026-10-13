// The languages every user-facing message carries, and the helper that builds
// a message assembled from parts in each of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { LANGUAGES, perLanguage } from '../src/i18n.js';
import {
  departuresContent,
  describeVelovStation,
  parkAndRideContent,
  velovStationContent,
} from '../src/widgets/index.js';

/** Every multi-language object found anywhere in a value. */
function multiLanguageTexts(value, found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => multiLanguageTexts(entry, found));
  } else if (value && typeof value === 'object') {
    if (typeof value.en === 'string') {
      found.push(value);
    } else {
      Object.values(value).forEach((entry) => multiLanguageTexts(entry, found));
    }
  }
  return found;
}

test('English comes first, followed by French, German and Spanish', () => {
  assert.deepEqual(LANGUAGES, ['en', 'fr', 'de', 'es']);
});

test('perLanguage builds one text per language, in that order', () => {
  assert.deepEqual(
    perLanguage((language) => `[${language}]`),
    { en: '[en]', fr: '[fr]', de: '[de]', es: '[es]' },
  );
});

test('an assembled widget status is joined in each language', () => {
  const state = describeVelovStation({
    installed: true,
    renting: false,
    returning: true,
    bikes: 0,
    docks: 3,
  });
  assert.deepEqual(state.value, {
    en: 'no rental, no bike',
    fr: 'location impossible, aucun vélo',
    de: 'kein Ausleihen, kein Rad',
    es: 'sin alquiler, ninguna bici',
  });
});

test('every text of the widget cards carries the four languages', () => {
  const contents = [
    departuresContent('Bellecour', []),
    departuresContent('Bellecour', [
      { line: 'T1', direction: 'IUT Feyssine', minutes: 0, realtime: false },
    ]),
    velovStationContent(
      'Bellecour',
      { bikes: 0, electricBikes: 0, docks: 20, installed: true, renting: true, returning: true },
      ['a:bikes_available'],
    ),
    parkAndRideContent('Gorge de Loup', { available: 0, capacity: 400, availableDisabled: 2 }, [
      'a:spaces_available',
    ]),
  ];
  for (const content of contents) {
    assert.deepEqual(validateWidgetContent(content), []);
    const texts = multiLanguageTexts(content.components);
    assert.ok(texts.length > 0);
    for (const text of texts) {
      assert.deepEqual(Object.keys(text), LANGUAGES, JSON.stringify(text));
    }
  }
});
