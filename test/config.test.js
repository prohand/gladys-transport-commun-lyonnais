// -----------------------------------------------------------------------------
// Configuration parsing: defaults, type coercion, poll frequency clamping and
// the mini-syntax of the three watch lists.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  hasGrandLyonCredentials,
  normalizeConfig,
  normalizePollFrequency,
  parseSimpleEntry,
  parseStopEntry,
} from '../src/config.js';

test('an empty config falls back to the defaults', () => {
  const config = normalizeConfig();
  assert.equal(config.departures_poll_frequency, DEFAULT_CONFIG.departures_poll_frequency);
  assert.equal(config.velov_poll_frequency, DEFAULT_CONFIG.velov_poll_frequency);
  assert.equal(config.park_and_ride_poll_frequency, DEFAULT_CONFIG.park_and_ride_poll_frequency);
  assert.deepEqual(config.watched, { stops: [], velovStations: [], parkAndRide: [] });
});

test('poll frequencies arriving as strings are coerced and clamped', () => {
  const config = normalizeConfig({
    departures_poll_frequency: '45',
    velov_poll_frequency: '5', // below the floor
    park_and_ride_poll_frequency: '99999', // above the ceiling
  });
  assert.equal(config.departures_poll_frequency, 45);
  assert.equal(config.velov_poll_frequency, 30);
  assert.equal(config.park_and_ride_poll_frequency, 3600);
});

test('an unusable poll frequency falls back to its default', () => {
  assert.equal(normalizePollFrequency('', 120), 120);
  assert.equal(normalizePollFrequency('not a number', 120), 120);
  assert.equal(normalizePollFrequency(-5, 120), 120);
  assert.equal(normalizePollFrequency(null, 120), 120);
});

test('a stop entry parses its id, line filter and custom name', () => {
  assert.deepEqual(parseStopEntry('1234'), { id: '1234', lines: [], name: null });
  assert.deepEqual(parseStopEntry('1234@T1'), { id: '1234', lines: ['T1'], name: null });
  assert.deepEqual(parseStopEntry(' 1234 @ c3 | c13 '), {
    id: '1234',
    lines: ['C3', 'C13'],
    name: null,
  });
  assert.deepEqual(parseStopEntry('1234@T1:Tram at home'), {
    id: '1234',
    lines: ['T1'],
    name: 'Tram at home',
  });
  assert.equal(parseStopEntry('@T1'), null, 'an entry without an id is dropped');
});

test('a Vélo’v / park & ride entry parses its id and custom name', () => {
  assert.deepEqual(parseSimpleEntry('10063'), { id: '10063', name: null });
  assert.deepEqual(parseSimpleEntry('Hotel de Ville:Work'), {
    id: 'Hotel de Ville',
    name: 'Work',
  });
  assert.equal(parseSimpleEntry('   '), null);
});

test('watch lists accept commas, semicolons and newlines', () => {
  const config = normalizeConfig({
    stops: '1234, 5678@T1\n4321;9999',
    velov_stations: '10063,\n10064',
    park_and_ride: 'Gorge de Loup',
  });
  assert.deepEqual(
    config.watched.stops.map((stop) => stop.id),
    ['1234', '5678', '4321', '9999'],
  );
  assert.equal(config.watched.velovStations.length, 2);
  assert.equal(config.watched.parkAndRide.length, 1);
});

test('the number of departures per stop stays within the manifest bounds', () => {
  assert.equal(normalizeConfig({ max_departures: '4' }).max_departures, 4);
  assert.equal(normalizeConfig({ max_departures: 0 }).max_departures, 1);
  assert.equal(normalizeConfig({ max_departures: 42 }).max_departures, 5);
});

test('the Data Grand Lyon base URL loses its trailing slashes', () => {
  const config = normalizeConfig({ grandlyon_base_url: 'https://example.test/ws/rdata//' });
  assert.equal(config.grandlyon_base_url, 'https://example.test/ws/rdata');
});

test('credentials are only considered set when both fields are filled', () => {
  assert.equal(hasGrandLyonCredentials(normalizeConfig()), false);
  assert.equal(hasGrandLyonCredentials(normalizeConfig({ grandlyon_username: 'me' })), false);
  assert.equal(
    hasGrandLyonCredentials(
      normalizeConfig({ grandlyon_username: ' me ', grandlyon_password: 'x' }),
    ),
    true,
  );
});
