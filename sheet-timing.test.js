import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetBeatMap } from './sheet-timing.js';

const point = (playbackBeat, sourceBeat) => ({ playbackBeat, sourceBeat });
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);

test('a missing beat map preserves unmodified DSL score timing', () => {
  for (const points of [undefined, null, []]) {
    const timing = createSheetBeatMap(points);
    for (const beat of [-1, 0, 0.25, 4, 100]) {
      assert.equal(timing.sourceBeatAt(beat), beat);
      assert.equal(timing.displayBeatAt(beat), beat);
    }
  }
});

test('rounded imported note durations map continuously back to their original beats', () => {
  // Each triplet third rounds to a dotted sixteenth in the playback DSL.
  const timing = createSheetBeatMap([point(0, 0), point(3 / 8, 1 / 3), point(6 / 8, 2 / 3), point(9 / 8, 1)]);
  closeTo(timing.sourceBeatAt(3 / 16), 1 / 6);
  closeTo(timing.sourceBeatAt(3 / 8), 1 / 3);
  closeTo(timing.sourceBeatAt(9 / 16), 0.5);
  closeTo(timing.sourceBeatAt(6 / 8), 2 / 3);
  closeTo(timing.sourceBeatAt(15 / 16), 5 / 6);
  closeTo(timing.sourceBeatAt(9 / 8), 1);
});

test('duplicate playback boundaries approach the first source point and then jump to the last', () => {
  const timing = createSheetBeatMap([point(0, 0), point(2, 2), point(2, 3), point(2, 4), point(4, 6)]);
  closeTo(timing.sourceBeatAt(1.9), 1.9);
  assert.equal(timing.sourceBeatAt(2), 4);
  closeTo(timing.sourceBeatAt(2.1), 4.1);
  assert.equal(timing.sourceBeatAt(3), 5);
  assert.equal(timing.sourceBeatAt(5), 7);
});

test('endpoint extrapolation keeps pre-score and after-score positions outside the score', () => {
  const timing = createSheetBeatMap([point(0, 0), point(2, 1), point(4, 5)]);
  assert.equal(timing.sourceBeatAt(-1), -0.5);
  assert.equal(timing.sourceBeatAt(5), 7);
  const flat = createSheetBeatMap([point(0, 0), point(1, 0), point(2, 3), point(3, 3)]);
  assert.equal(flat.sourceBeatAt(-1), -1);
  assert.equal(flat.sourceBeatAt(4), 4);
  const single = createSheetBeatMap([point(0, 2)]);
  assert.equal(single.sourceBeatAt(-1), 1);
  assert.equal(single.sourceBeatAt(2), 4);
});

test('longer other parts shift engraved measures without stretching notes in the selected part', () => {
  const timing = createSheetBeatMap(
    [point(0, 0), point(2, 2), point(4, 4), point(6, 6)],
    [0, 2, 4],
    [0, 4, 8],
  );
  assert.equal(timing.displayBeatAt(1.5), 1.5);
  assert.equal(timing.displayBeatAt(2), 4);
  assert.equal(timing.displayBeatAt(3), 5);
  assert.equal(timing.displayBeatAt(4), 8);
  assert.equal(timing.displayBeatAt(5), 9);
  assert.equal(timing.displayBeatAt(-1), -1);
  assert.equal(timing.displayBeatAt(7), 11);
});

test('measure offsets are applied after rhythm conversion and choose the next measure at boundaries', () => {
  const timing = createSheetBeatMap([point(0, 0), point(3, 2), point(6, 4)], [0, 2, 2, 3], [0, 4, 6, 8]);
  assert.equal(timing.sourceBeatAt(3), 2);
  assert.equal(timing.displayBeatAt(1.5), 1);
  assert.equal(timing.displayBeatAt(3), 6);
  assert.equal(timing.displayBeatAt(3.75), 6.5);
  assert.equal(timing.displayBeatAt(4.5), 8);
  assert.equal(timing.displayBeatAt(6), 9);
  // Seeking backwards is independent of any previous lookup.
  assert.equal(timing.displayBeatAt(0), 0);
});

test('malformed entries are skipped without changing paired measure indexes or the caller data', () => {
  const points = [point(4, 6), null, point(NaN, 2), point(2, Infinity), point(0, 0), point(2, 2)];
  const timing = createSheetBeatMap(points, [0, NaN, 2, 4], [0, 100, 5, Infinity]);
  assert.equal(timing.sourceBeatAt(1), 1);
  assert.equal(timing.sourceBeatAt(3), 4);
  assert.equal(timing.displayBeatAt(2), 5);
  assert.equal(points[0].playbackBeat, 4);
  points[4].sourceBeat = 999;
  assert.equal(timing.sourceBeatAt(0), 0);
  for (const beat of [NaN, Infinity, -Infinity, undefined]) {
    assert.ok(Number.isNaN(timing.sourceBeatAt(beat)));
    assert.ok(Number.isNaN(timing.displayBeatAt(beat)));
  }
});
