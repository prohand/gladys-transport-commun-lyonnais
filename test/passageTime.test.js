// -----------------------------------------------------------------------------
// Reading a passage time in Lyon's time zone, whatever the container's.
//
// The departures layer declares `heurepassage` as a timestamp without a time
// zone, and the container runs in UTC: read with `new Date`, a tram due in 5
// minutes was announced in 125. The process is pinned to UTC here — the
// container's own setting — so the test fails the way production did.
// -----------------------------------------------------------------------------

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutesUntilPassage, parsePassageTime } from '../src/api/tcl.js';

test('a passage time without an offset is Lyon wall-clock time (summer)', () => {
  // 14:00 in Lyon on 8 October = 12:00 UTC.
  const now = new Date('2026-10-08T12:00:00Z');
  assert.equal(minutesUntilPassage({ heurepassage: '2026-10-08 14:05:00' }, now), 5);
  assert.equal(minutesUntilPassage({ heurepassage: '2026-10-08T14:05:00' }, now), 5);
  assert.equal(minutesUntilPassage({ heurepassage: '2026-10-08T14:05' }, now), 5);
});

test('a passage time without an offset is Lyon wall-clock time (winter)', () => {
  const now = new Date('2026-12-08T13:00:00Z'); // 14:00 in Lyon, UTC+1
  assert.equal(minutesUntilPassage({ heurepassage: '2026-12-08 14:05:00' }, now), 5);
});

test('a passage time with its own offset is read as it says', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  assert.equal(minutesUntilPassage({ heurepassage: '2026-10-08T12:05:00Z' }, now), 5);
  assert.equal(minutesUntilPassage({ heurepassage: '2026-10-08T12:05:00.000z' }, now), 5);
  assert.equal(minutesUntilPassage({ heurepassage: '2026-10-08T14:05:00+02:00' }, now), 5);
  assert.equal(minutesUntilPassage({ heurepassage: '2026-10-08 14:05:00+0200' }, now), 5);
  assert.equal(minutesUntilPassage({ heurepassage: '2026-10-08T13:05:00+01' }, now), 5);
  assert.equal(minutesUntilPassage({ heurepassage: '2026-10-08T07:05:00-05:00' }, now), 5);
});

test('the reading does not depend on the time zone of the process', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const now = new Date('2026-10-08T12:00:00Z');
    assert.equal(minutesUntilPassage({ heurepassage: '2026-10-08 14:05:00' }, now), 5);
  } finally {
    process.env.TZ = previous;
  }
});

test('the autumn change: the repeated hour is the one nearest to now', () => {
  // 25 October 2026, 03:00 CEST -> 02:00 CET: 02:30 happens at 00:30Z and at
  // 01:30Z.
  assert.equal(
    parsePassageTime('2026-10-25 02:30:00', new Date('2026-10-25T00:25:00Z')).toISOString(),
    '2026-10-25T00:30:00.000Z',
  );
  assert.equal(
    parsePassageTime('2026-10-25 02:30:00', new Date('2026-10-25T01:25:00Z')).toISOString(),
    '2026-10-25T01:30:00.000Z',
  );
  // Either side of the change, the offset is the one of that moment.
  assert.equal(parsePassageTime('2026-10-25 01:59:00').toISOString(), '2026-10-24T23:59:00.000Z');
  assert.equal(parsePassageTime('2026-10-25 03:01:00').toISOString(), '2026-10-25T02:01:00.000Z');
});

test('the spring change: a time in the missing hour is still a time', () => {
  // 29 March 2026, 02:00 CET -> 03:00 CEST: 02:30 never happens.
  assert.equal(parsePassageTime('2026-03-29 02:30:00').toISOString(), '2026-03-29T01:30:00.000Z');
  assert.equal(parsePassageTime('2026-03-29 01:59:00').toISOString(), '2026-03-29T00:59:00.000Z');
  assert.equal(parsePassageTime('2026-03-29 03:00:00').toISOString(), '2026-03-29T01:00:00.000Z');
  // A countdown across the change counts real minutes: 01:55 CET to 03:05 CEST.
  assert.equal(
    minutesUntilPassage({ heurepassage: '2026-03-29 03:05:00' }, new Date('2026-03-29T00:55:00Z')),
    10,
  );
});

test('an unreadable passage time falls back on the label', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  assert.equal(parsePassageTime('not a time'), null);
  assert.equal(minutesUntilPassage({ heurepassage: 'n/a', delaipassage: '4 min' }, now), 4);
});
