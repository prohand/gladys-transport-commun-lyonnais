// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys >= 5.1).
//
// Every content is checked against the SDK's own validator — the same checks
// the core applies — so a card that passes here is rendered exactly as sent:
// nothing dropped by the content budget, no field truncated or ignored.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';
import { normalizeConfig } from '../src/config.js';
import { buildDiscoveredDevices } from '../src/devices/index.js';
import { clearTclCache } from '../src/api/tcl.js';
import { clearVelovCache } from '../src/api/velov.js';
import { clearLayerResolution } from '../src/api/grandlyon.js';
import {
  departuresContent,
  parkAndRideContent,
  velovStationContent,
  WIDGETS,
} from '../src/widgets/index.js';

const CONFIG = normalizeConfig({
  grandlyon_username: 'user',
  grandlyon_password: 'secret',
  stops: '1234:Bellecour',
  velov_stations: '10063:Bellecour',
  park_and_ride: 'PR1:Gorge de Loup',
});

beforeEach(() => {
  clearTclCache();
  clearVelovCache();
  clearLayerResolution();
});

afterEach(() => {
  restoreFetch();
});

/**
 * The created devices, with their features, as the SDK lists them: what the
 * charts check before drawing a curve.
 */
function createdDevices(gladys) {
  return buildDiscoveredDevices(gladys, CONFIG).map((device) => ({
    external_id: device.external_id,
    name: device.name,
    features: device.features.map((feature) => ({ external_id: feature.external_id })),
  }));
}

const textsOf = (content) =>
  content.components.filter((component) => component.type === 'text').map((c) => c.text);

test('a departure board fits the widget vocabulary and budget', () => {
  const content = departuresContent('Bellecour', [
    { line: 'T1', direction: 'IUT Feyssine', minutes: 0, realtime: true },
    { line: 'C3', direction: 'Vaulx', minutes: 7, realtime: false },
    ...Array.from({ length: 12 }, (_, index) => ({
      line: 'T1',
      direction: 'Debourg',
      minutes: 10 + index,
      realtime: true,
    })),
  ]);
  assert.deepEqual(validateWidgetContent(content), []);
  const [tile] = content.components.filter((component) => component.type === 'value');
  assert.equal(tile.value, 0);
  assert.equal(tile.label, 'T1 → IUT Feyssine');
});

test('an empty departure board says so', () => {
  const content = departuresContent('Bellecour', []);
  assert.deepEqual(validateWidgetContent(content), []);
  assert.deepEqual(textsOf(content)[1], {
    en: 'No upcoming departure.',
    fr: 'Aucun passage à venir.',
  });
});

test('a Vélo’v card fits the widget vocabulary and budget', () => {
  const content = velovStationContent(
    'Bellecour',
    {
      bikes: 0,
      electricBikes: 0,
      docks: 20,
      capacity: 20,
      installed: true,
      renting: true,
      returning: true,
    },
    ['a:bikes_available', 'a:docks_available'],
  );
  assert.deepEqual(validateWidgetContent(content), []);
  const status = content.components.find((component) => component.type === 'status');
  assert.deepEqual(status.items[0].value, { en: 'no bike', fr: 'aucun vélo' });
});

test('a park & ride card fits the widget vocabulary and budget', () => {
  const content = parkAndRideContent(
    'Gorge de Loup',
    { available: 30, capacity: 400, availableDisabled: 2, live: true },
    ['a:spaces_available'],
  );
  assert.deepEqual(validateWidgetContent(content), []);
  const status = content.components.find((component) => component.type === 'status');
  assert.deepEqual(status.items[0].value, { en: 'Almost full', fr: 'Presque complet' });
});

test('a park & ride nobody counts live shows its capacity, and no empty curve', () => {
  const content = parkAndRideContent('Gorge de Loup', { capacity: 400, live: false }, [
    'a:spaces_available',
  ]);
  assert.deepEqual(validateWidgetContent(content), []);
  assert.ok(!content.components.some((component) => component.type === 'chart'));
  const status = content.components.find((component) => component.type === 'status');
  assert.deepEqual(status.items[0].value, { en: 'No live count', fr: 'Pas de comptage en direct' });
});

test('the departures widget reads the stop it is bound to', async () => {
  const gladys = createFakeGladys();
  gladys.devices = createdDevices(gladys);
  stubFetch({
    tclpassagearret: {
      values: [{ ligne: 'T1', direction: 'IUT Feyssine', delaipassage: '4 min', type: 'E' }],
    },
  });

  const content = await WIDGETS.departures(gladys, {
    settings: { stop: gladys.devices[0].external_id },
    config: CONFIG,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(textsOf(content)[0], 'Bellecour');
  assert.equal(content.components.find((component) => component.type === 'value').value, 4);
});

test('the Vélo’v widget draws the day of the features the device carries', async () => {
  const gladys = createFakeGladys();
  gladys.devices = createdDevices(gladys);
  stubFetch({
    'gbfs.json': {
      data: {
        feeds: [
          { name: 'station_information', url: 'https://feed.test/station_information.json' },
          { name: 'station_status', url: 'https://feed.test/station_status.json' },
        ],
      },
    },
    station_information: {
      data: { stations: [{ station_id: '10063', name: 'Bellecour', capacity: 20 }] },
    },
    station_status: {
      data: {
        stations: [{ station_id: '10063', num_bikes_available: 5, num_docks_available: 15 }],
      },
    },
  });

  const device = gladys.devices[1];
  const content = await WIDGETS.velov_station(gladys, {
    settings: { station: device.external_id },
    config: CONFIG,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const chart = content.components.find((component) => component.type === 'chart');
  assert.deepEqual(chart.device_features, [
    `${device.external_id}:bikes_available`,
    `${device.external_id}:docks_available`,
  ]);
});

test('the park & ride widget reads the facility it is bound to', async () => {
  const gladys = createFakeGladys();
  gladys.devices = createdDevices(gladys);
  stubFetch({
    tclparcrelaistr: {
      values: [{ id: 'PR1', nom: 'Gorge de Loup', capacite: 400, nb_tot_place_dispo: 100 }],
    },
    tclparcrelaisst: { values: [{ id: 'PR1', nom: 'Gorge de Loup', capacite: 400 }] },
  });

  const content = await WIDGETS.park_and_ride(gladys, {
    settings: { facility: gladys.devices[2].external_id },
    config: CONFIG,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const gauge = content.components.find((component) => component.type === 'gauge');
  assert.equal(gauge.value, 75);
});

test('a widget bound to a device of another kind explains itself instead of failing', async () => {
  const gladys = createFakeGladys();
  gladys.devices = createdDevices(gladys);

  const content = await WIDGETS.departures(gladys, {
    settings: { stop: gladys.devices[2].external_id },
    config: CONFIG,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.deepEqual(textsOf(content), [
    {
      en: 'This device is a park & ride: choose a transit stop.',
      fr: 'Cet appareil est un parc relais : choisissez un arrêt.',
    },
  ]);
});

test('a widget with no device chosen asks for one', async () => {
  const content = await WIDGETS.velov_station(createFakeGladys(), {
    settings: {},
    config: CONFIG,
  });
  assert.deepEqual(textsOf(content), [
    {
      en: "Choose a Vélo'v station in the settings.",
      fr: 'Choisissez une station Vélo’v dans les réglages.',
    },
  ]);
});

test('a feed that is down renders as a card saying so', async () => {
  const gladys = createFakeGladys();
  gladys.devices = createdDevices(gladys);
  globalThis.fetch = async () => {
    throw new Error('network down');
  };

  const content = await WIDGETS.velov_station(gladys, {
    settings: { station: gladys.devices[1].external_id },
    config: CONFIG,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.match(textsOf(content)[0].en, /could not be read right now/);
});
