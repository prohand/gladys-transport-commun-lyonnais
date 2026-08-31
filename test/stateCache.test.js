// -----------------------------------------------------------------------------
// State de-duplication.
//
// What is pinned here is a storage cost, not a behaviour the user can see:
// Gladys writes down every state it is given, and this integration polls fast
// on purpose, so republishing a value that did not move is a row in the
// database for nothing. The other half of the contract matters just as much —
// the cache must never be the reason a device stays empty — hence the
// republication after a while and after a reset.
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { changedStates, clearStateCache } from '../src/devices/stateCache.js';

const FEATURE = 'ext:tcl:device:feature';

beforeEach(clearStateCache);

test('the first publication of a value always goes through', () => {
  assert.deepEqual(changedStates([{ device_feature_external_id: FEATURE, state: 4 }]), [
    { device_feature_external_id: FEATURE, state: 4 },
  ]);
});

test('a value that did not move is not published again', () => {
  changedStates([{ device_feature_external_id: FEATURE, state: 4 }]);

  assert.deepEqual(changedStates([{ device_feature_external_id: FEATURE, state: 4 }]), []);
  assert.deepEqual(changedStates([{ device_feature_external_id: FEATURE, state: 3 }]), [
    { device_feature_external_id: FEATURE, state: 3 },
  ]);
});

test('only the features that moved are kept out of a batch', () => {
  const board = (minutes) => [
    { device_feature_external_id: `${FEATURE}:1`, state: minutes },
    { device_feature_external_id: `${FEATURE}:2`, state: 12 },
    { device_feature_external_id: `${FEATURE}:label`, text: 'T1 → IUT Feyssine' },
  ];
  changedStates(board(4));

  assert.deepEqual(
    changedStates(board(3)).map((state) => state.device_feature_external_id),
    [`${FEATURE}:1`],
  );
});

test('a text going back to empty is a change, not an absence', () => {
  // The label of a departure that is gone is published as '', and Gladys must
  // hear about it: a stale "T1 → IUT Feyssine" reads as a tram that is coming.
  changedStates([{ device_feature_external_id: FEATURE, text: 'T1 → IUT Feyssine' }]);

  assert.deepEqual(changedStates([{ device_feature_external_id: FEATURE, text: '' }]), [
    { device_feature_external_id: FEATURE, text: '' },
  ]);
});

test('an unchanged value is published again after a while', () => {
  // The cache is a belief about what Gladys holds, and a device the user
  // deleted and re-created makes it wrong: that device starts with no value at
  // all, and nothing tells the container about it. The periodic republication
  // is what keeps it from staying empty.
  const start = Date.UTC(2026, 7, 31, 8, 0, 0);
  changedStates([{ device_feature_external_id: FEATURE, state: 100 }], start);

  assert.deepEqual(
    changedStates([{ device_feature_external_id: FEATURE, state: 100 }], start + 10 * 60_000),
    [],
  );
  assert.deepEqual(
    changedStates([{ device_feature_external_id: FEATURE, state: 100 }], start + 16 * 60_000),
    [{ device_feature_external_id: FEATURE, state: 100 }],
  );
});

test('a reset republishes everything, whatever was sent before', () => {
  changedStates([{ device_feature_external_id: FEATURE, state: 100 }]);
  clearStateCache();

  assert.deepEqual(changedStates([{ device_feature_external_id: FEATURE, state: 100 }]), [
    { device_feature_external_id: FEATURE, state: 100 },
  ]);
});
