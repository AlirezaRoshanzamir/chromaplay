import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotation } from './notation.js';
import { createScoreTiming } from './score-timing.js';

const timingFor = source => {
  const parsed = parseNotation(source);
  assert.deepEqual(parsed.errors, []);
  return createScoreTiming(parsed);
};
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);

test('the default timing map preserves quarter-note seconds and extends outside the score', () => {
  const timing = createScoreTiming();
  assert.deepEqual(timing.tempoSegments, [{ beat: 0, seconds: 0, tempo: 60 }]);
  assert.deepEqual(timing.meterSegments, [{ beat: 0, numerator: 4, denominator: 4, bar: 1 }]);
  assert.equal(timing.totalBars, 0);
  for (const position of [-10, -0.25, 0, 1, 40]) {
    assert.equal(timing.beatToSeconds(position), position);
    assert.equal(timing.secondsToBeat(position), position);
  }
  assert.deepEqual(timing.settingsAtBeat(20), { tempo: 60, numerator: 4, denominator: 4 });
});

test('tempo segments integrate changes and invert exactly across boundaries and long tails', () => {
  const timing = timingFor('TEMPO 60 1h TEMPO 120 -1h TEMPO 90 2w');
  assert.deepEqual(timing.tempoSegments, [
    { beat: 0, seconds: 0, tempo: 60 },
    { beat: 2, seconds: 2, tempo: 120 },
    { beat: 4, seconds: 3, tempo: 90 },
  ]);
  closeTo(timing.beatToSeconds(8), 3 + 8 / 3);
  closeTo(timing.beatToSeconds(40), 27);
  assert.equal(timing.beatToSeconds(-3), -3);
  for (const beat of [-3, 0, 1.999, 2, 2.001, 3.999, 4, 4.001, 8, 1e7]) {
    closeTo(timing.secondsToBeat(timing.beatToSeconds(beat)), beat);
  }
  assert.equal(timing.settingsAtBeat(1.999).tempo, 60);
  assert.equal(timing.settingsAtBeat(2).tempo, 120);
  assert.equal(timing.settingsAtBeat(4).tempo, 90);
});

test('repeated directives at one beat use the final setting without duplicate segments', () => {
  const timing = timingFor('TEMPO 60 TEMP 90 TSIG 3/4 TSIG 6/8 1q TEMPO 120 TEMP 180 TSIG 2/4 TSIG 5/8 2q');
  assert.deepEqual(timing.tempoSegments, [
    { beat: 0, seconds: 0, tempo: 90 },
    { beat: 1, seconds: 2 / 3, tempo: 180 },
  ]);
  assert.deepEqual(timing.meterSegments, [
    { beat: 0, numerator: 6, denominator: 8, bar: 1 },
    { beat: 1, numerator: 5, denominator: 8, bar: 2 },
  ]);
  assert.deepEqual(timing.settingsAtBeat(0), { tempo: 90, numerator: 6, denominator: 8 });
  assert.deepEqual(timing.settingsAtBeat(1), { tempo: 180, numerator: 5, denominator: 8 });
});

test('signature changes begin a new bar after either a full or partial bar', () => {
  const timing = timingFor('1w TSIG 6/8 2h TSIG 2/4 3w');
  assert.deepEqual(timing.meterSegments, [
    { beat: 0, numerator: 4, denominator: 4, bar: 1 },
    { beat: 4, numerator: 6, denominator: 8, bar: 2 },
    { beat: 6, numerator: 2, denominator: 4, bar: 3 },
  ]);
  assert.deepEqual([0, 3.999, 4, 5.999, 6, 8, 10, 12].map(timing.barAtBeat), [1, 1, 2, 2, 3, 4, 5, 6]);
  assert.equal(timing.totalBars, 4);
  assert.deepEqual(timing.barsBetween(0, 10), [{ beat: 0, bar: 1 }, { beat: 4, bar: 2 }, { beat: 6, bar: 3 }, { beat: 8, bar: 4 }]);
  assert.deepEqual(timing.barsBetween(4.01, 8), [{ beat: 6, bar: 3 }]);
});

test('a repeated signature starts a new measure while a tempo change does not', () => {
  const timing = timingFor('1q TEMPO 120 2q TSIG 4/4 3w');
  assert.equal(timing.barAtBeat(1), 1);
  assert.equal(timing.barAtBeat(2), 2);
  assert.equal(timing.totalBars, 2);
  assert.deepEqual(timing.pulsesBetween(0, 3.5), [
    { seconds: 0, beat: 0, accent: true },
    { seconds: 1, beat: 1, accent: false },
    { seconds: 1.5, beat: 2, accent: true },
    { seconds: 2, beat: 3, accent: false },
    { seconds: 2.5, beat: 4, accent: false },
    { seconds: 3, beat: 5, accent: false },
  ]);
});

test('metronome pulses follow changing denominator, partial bar phase, and tempo', () => {
  const timing = timingFor('TSIG 3/4 1e TEMPO 120 2q TSIG 6/8 3w');
  assert.deepEqual(timing.pulsesBetween(0, 2), [
    { seconds: 0, beat: 0, accent: true },
    { seconds: 0.75, beat: 1, accent: false },
    { seconds: 1, beat: 1.5, accent: true },
    { seconds: 1.25, beat: 2, accent: false },
    { seconds: 1.5, beat: 2.5, accent: false },
    { seconds: 1.75, beat: 3, accent: false },
  ]);
  assert.deepEqual(timing.pulsesBetween(2.5, 2.75), [{ seconds: 2.5, beat: 4.5, accent: true }]);
});

test('pulse windows are start-inclusive, end-exclusive, and do not repeat boundary clicks', () => {
  const timing = timingFor('TEMPO 90 TSIG 6/8 1w TEMPO 120 2w');
  const split = timing.beatToSeconds(4);
  const first = timing.pulsesBetween(0, split);
  const second = timing.pulsesBetween(split, 5);
  assert.ok(first.every(pulse => pulse.seconds < split));
  assert.equal(second[0].seconds, split);
  assert.equal(second[0].beat, 4);
  assert.deepEqual([...first, ...second], timing.pulsesBetween(0, 5));
  assert.deepEqual(timing.pulsesBetween(-5, 0.1), [{ seconds: 0, beat: 0, accent: true }]);
  assert.deepEqual(timing.pulsesBetween(-5, 0), []);
  assert.deepEqual(timing.pulsesBetween(1, 1), []);
  const simple = createScoreTiming();
  assert.deepEqual(simple.pulsesBetween(1 + 1e-10, 2), []);
  assert.deepEqual(simple.pulsesBetween(0, 1e-10), [{ seconds: 0, beat: 0, accent: true }]);
  assert.deepEqual(simple.barsBetween(4 + 1e-10, 8), []);
  assert.equal(simple.barAtBeat(4 - 1e-10), 1);
});

test('meters and clicks continue after score end for longer backing tracks', () => {
  const timing = timingFor('1q TEMPO 120 TSIG 2/8 2q');
  assert.deepEqual(timing.pulsesBetween(10, 10.6), [
    { seconds: 10, beat: 19, accent: true },
    { seconds: 10.25, beat: 19.5, accent: false },
    { seconds: 10.5, beat: 20, accent: true },
  ]);
  assert.deepEqual(timing.barsBetween(19, 21), [{ beat: 19, bar: 20 }, { beat: 20, bar: 21 }]);
});

test('totalBars excludes an empty final signature and counts partial final measures once', () => {
  assert.equal(timingFor('1w TSIG 6/8').totalBars, 1);
  assert.equal(timingFor('1q TSIG 6/8').totalBars, 1);
  assert.equal(timingFor('1w TSIG 6/8 2s').totalBars, 2);
  assert.equal(timingFor('TSIG 6/8').totalBars, 0);
});

test('late windows only return nearby marks even far beyond a long score', () => {
  const timing = timingFor('1w TEMPO 120 TSIG 4/16 2w');
  const pulses = timing.pulsesBetween(1e9, 1e9 + 0.5);
  assert.equal(pulses.length, 4);
  assert.ok(pulses.every(pulse => pulse.seconds >= 1e9 && pulse.seconds < 1e9 + 0.5));
  assert.equal(timing.barsBetween(1e9, 1e9 + 2).length, 2);
});

test('invalid directives do not affect valid timing maps', () => {
  const parsed = parseNotation('TEMPO 120 1q TEMPO wrong TSIG 4/3 2q');
  const timing = createScoreTiming(parsed);
  assert.equal(timing.tempoSegments.length, 1);
  assert.equal(timing.meterSegments.length, 1);
  assert.equal(timing.beatToSeconds(2), 1);
});
