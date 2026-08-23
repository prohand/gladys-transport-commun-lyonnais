// -----------------------------------------------------------------------------
// Parsing of the upstream payloads.
//
// These are the parts that break when an open data platform renames a column
// or bumps a feed version, so they are tested against the real-world shapes
// (and their known variants) rather than through the network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pick, pickNumber, pickString } from '../src/api/grandlyon.js';
import { minutesUntilPassage, normalizePassage, normalizeParkAndRide } from '../src/api/tcl.js';
import {
  normalizeStationInformation,
  normalizeStationStatus,
  readGbfsName,
} from '../src/api/velov.js';

test('pick reads the first usable candidate key', () => {
  const record = { a: '', b: null, c: 'value', d: 'other' };
  assert.equal(pick(record, ['a', 'b', 'c', 'd']), 'value');
  assert.equal(pick(record, ['missing']), undefined);
  assert.equal(pickNumber({ n: '42' }, ['n']), 42);
  assert.equal(pickNumber({ n: 'abc' }, ['n']), undefined);
  assert.equal(pickString({ s: '  x  ' }, ['s']), 'x');
});

test('a departure timestamp wins over the display label', () => {
  const now = new Date('2026-08-23T10:00:00Z');
  const minutes = minutesUntilPassage(
    { heurepassage: '2026-08-23T10:07:00Z', delaipassage: '99 min' },
    now,
  );
  assert.equal(minutes, 7);
});

test('a departure in the past is reported as 0 minute, never negative', () => {
  const now = new Date('2026-08-23T10:00:00Z');
  assert.equal(minutesUntilPassage({ heurepassage: '2026-08-23T09:58:00Z' }, now), 0);
});

test('the display label is parsed when no timestamp is sent', () => {
  const now = new Date('2026-08-23T10:00:00Z');
  assert.equal(minutesUntilPassage({ delaipassage: '3 min' }, now), 3);
  assert.equal(minutesUntilPassage({ delaipassage: 'Proche' }, now), 0);
  assert.equal(minutesUntilPassage({ delaipassage: "A l'approche" }, now), 0);
  assert.equal(minutesUntilPassage({}, now), null, 'an unreadable record yields null');
});

test('a passage keeps its line, direction and real-time flag', () => {
  const now = new Date('2026-08-23T10:00:00Z');
  const estimated = normalizePassage(
    { ligne: 'T1', direction: 'IUT Feyssine', heurepassage: '2026-08-23T10:04:00Z', type: 'E' },
    now,
  );
  assert.deepEqual(estimated, {
    line: 'T1',
    direction: 'IUT Feyssine',
    minutes: 4,
    realtime: true,
  });

  const theoretical = normalizePassage({ ligne: 'C3', delaipassage: '10 min', type: 'T' }, now);
  assert.equal(theoretical.realtime, false, 'a timetable estimate is not real-time');
});

test('a park & ride record is read through its column aliases', () => {
  const legacy = normalizeParkAndRide({
    id: 'PR1',
    nom: 'Gorge de Loup',
    capacite: 400,
    nbplacesdispo: 120,
    capacitepmr: 10,
    nbplacesdispopmr: 4,
  });
  assert.deepEqual(legacy, {
    id: 'PR1',
    name: 'Gorge de Loup',
    capacity: 400,
    available: 120,
    capacityDisabled: 10,
    availableDisabled: 4,
  });

  const renamed = normalizeParkAndRide({
    code: 'PR2',
    libelle: 'Parilly',
    nb_tot: 800,
    nb_dispo: 0,
  });
  assert.equal(renamed.id, 'PR2');
  assert.equal(renamed.name, 'Parilly');
  assert.equal(renamed.capacity, 800);
  assert.equal(renamed.available, 0, 'a full car park publishes 0, not undefined');
});

test('a GBFS name is read in both the v2 and v3 shapes', () => {
  assert.equal(readGbfsName('Hotel de Ville'), 'Hotel de Ville');
  assert.equal(
    readGbfsName([
      { text: 'Hôtel de Ville', language: 'fr' },
      { text: 'City Hall', language: 'en' },
    ]),
    'Hôtel de Ville',
  );
  assert.equal(readGbfsName(undefined), '');
});

test('station information keeps the id, name and capacity', () => {
  const station = normalizeStationInformation({
    station_id: '10063',
    name: [{ text: 'Hôtel de Ville', language: 'fr' }],
    capacity: 20,
    lat: 45.767,
    lon: 4.836,
  });
  assert.equal(station.id, '10063');
  assert.equal(station.name, 'Hôtel de Ville');
  assert.equal(station.capacity, 20);
});

test('station status reads the v2 counters', () => {
  const status = normalizeStationStatus({
    station_id: '10063',
    num_bikes_available: 7,
    num_docks_available: 13,
    is_renting: 1,
    is_returning: 1,
    is_installed: 1,
  });
  assert.equal(status.bikes, 7);
  assert.equal(status.docks, 13);
  assert.equal(status.renting, true);
  assert.equal(status.electricBikes, undefined, 'v2 does not detail the fleet');
});

test('station status reads the v3 counters and the electric fleet', () => {
  const status = normalizeStationStatus({
    station_id: '10063',
    num_vehicles_available: 9,
    num_docks_available: 11,
    vehicle_types_available: [
      { vehicle_type_id: 'bike', count: 6 },
      { vehicle_type_id: 'ebike', count: 3 },
    ],
  });
  assert.equal(status.bikes, 9);
  assert.equal(status.docks, 11);
  assert.equal(status.electricBikes, 3);
  assert.equal(status.renting, true, 'GBFS omits the flags when everything is nominal');
});

test('a station out of service is reported as such', () => {
  const status = normalizeStationStatus({
    station_id: '10063',
    num_bikes_available: 0,
    num_docks_available: 0,
    is_installed: false,
    is_renting: false,
    is_returning: false,
  });
  assert.equal(status.installed, false);
  assert.equal(status.renting, false);
  assert.equal(status.returning, false);
});
