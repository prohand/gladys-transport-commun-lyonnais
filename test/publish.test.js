// -----------------------------------------------------------------------------
// State de-duplication.
//
// What is pinned here is a storage cost, not a behaviour the user can see:
// Gladys writes down every state it is given, and this integration polls fast
// on purpose, so republishing a value that did not move is a row in the
// database for nothing. The other half of the contract matters just as much —
// the de-duplication must never be the reason a device stays empty — hence the
// republication after a while, after a reset, and after a refused batch.
//
// The comparison itself is the SDK's (`publishChangedStates`, reproduced by the
// fake); these tests pin what src/devices/publish.js asks of it.
// -----------------------------------------------------------------------------

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { publishDeviceStates, REPUBLISH_AFTER_MS } from '../src/devices/publish.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const DEVICE = 'ext:tcl:device';
const FEATURE = `${DEVICE}:feature`;

afterEach((t) => t.mock.timers.reset());

/** What a read of the device made Gladys record, in order. */
function sent(gladys) {
  return gladys.published.map(({ featureExternalId, state, text }) =>
    text === undefined ? [featureExternalId, state] : [featureExternalId, text],
  );
}

test('the first publication of a value always goes through', async () => {
  const gladys = createFakeGladys();
  await publishDeviceStates(gladys, DEVICE, [{ device_feature_external_id: FEATURE, state: 4 }]);

  assert.deepEqual(sent(gladys), [[FEATURE, 4]]);
});

test('a value that did not move is not published again', async () => {
  const gladys = createFakeGladys();
  await publishDeviceStates(gladys, DEVICE, [{ device_feature_external_id: FEATURE, state: 4 }]);
  await publishDeviceStates(gladys, DEVICE, [{ device_feature_external_id: FEATURE, state: 4 }]);
  await publishDeviceStates(gladys, DEVICE, [{ device_feature_external_id: FEATURE, state: 3 }]);

  assert.deepEqual(sent(gladys), [
    [FEATURE, 4],
    [FEATURE, 3],
  ]);
});

test('only the features that moved are kept out of a batch', async () => {
  const gladys = createFakeGladys();
  const board = (minutes) => [
    { device_feature_external_id: `${FEATURE}:1`, state: minutes },
    { device_feature_external_id: `${FEATURE}:2`, state: 12 },
    { device_feature_external_id: `${FEATURE}:label`, text: 'T1 → IUT Feyssine' },
  ];
  await publishDeviceStates(gladys, DEVICE, board(4));
  gladys.published.length = 0;
  await publishDeviceStates(gladys, DEVICE, board(3));

  assert.deepEqual(sent(gladys), [[`${FEATURE}:1`, 3]]);
});

test('a text going back to empty is a change, not an absence', async () => {
  // The label of a departure that is gone is published as '', and Gladys must
  // hear about it: a stale "T1 → IUT Feyssine" reads as a tram that is coming.
  const gladys = createFakeGladys();
  await publishDeviceStates(gladys, DEVICE, [
    { device_feature_external_id: FEATURE, text: 'T1 → IUT Feyssine' },
  ]);
  await publishDeviceStates(gladys, DEVICE, [{ device_feature_external_id: FEATURE, text: '' }]);

  assert.deepEqual(sent(gladys).at(-1), [FEATURE, '']);
});

test('an unchanged value is published again after a while', async (t) => {
  // The memory is a belief about what Gladys holds, and a device the user
  // deleted and re-created makes it wrong: that device starts with no value at
  // all. The periodic republication is what keeps it from staying empty.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 7, 31, 8, 0, 0) });
  const gladys = createFakeGladys();
  const read = () =>
    publishDeviceStates(gladys, DEVICE, [{ device_feature_external_id: FEATURE, state: 100 }]);
  await read();

  t.mock.timers.tick(10 * 60_000);
  await read();
  assert.equal(gladys.published.length, 1);

  t.mock.timers.tick(6 * 60_000);
  await read();
  assert.equal(gladys.published.length, 2);
  assert.equal(REPUBLISH_AFTER_MS, 15 * 60_000);
});

test('a reset republishes everything, whatever was sent before', async () => {
  // What index.js does on every connection and configuration change.
  const gladys = createFakeGladys();
  await publishDeviceStates(gladys, DEVICE, [{ device_feature_external_id: FEATURE, state: 100 }]);
  gladys.forgetPublishedStates();
  await publishDeviceStates(gladys, DEVICE, [{ device_feature_external_id: FEATURE, state: 100 }]);

  assert.equal(gladys.published.length, 2);
});

test('a batch Gladys refused is sent again by the next read', async () => {
  // A car park full all afternoon does not move: taken for delivered, its
  // value would wait fifteen minutes.
  const gladys = createFakeGladys();
  const publishStates = gladys.publishStates;
  gladys.publishStates = async () => {
    throw new Error('429 Too Many Requests');
  };
  await assert.rejects(
    publishDeviceStates(gladys, DEVICE, [{ device_feature_external_id: FEATURE, state: 0 }]),
  );
  gladys.publishStates = publishStates;
  await publishDeviceStates(gladys, DEVICE, [{ device_feature_external_id: FEATURE, state: 0 }]);

  assert.deepEqual(sent(gladys), [[FEATURE, 0]]);
});
