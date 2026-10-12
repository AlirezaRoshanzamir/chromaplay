import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline } from './timeline.js';
import { parseNotation } from './notation.js';
import { createScoreTiming } from './score-timing.js';

const notes = [{ startBeat: 0, endBeat: 8 }];

test('both clips determine the timeline, preserving independent offsets in seconds', () => {
  const timeline = createTimeline({ notes, bpm: 120, noteOffset: 2, backgroundOffset: -3, backgroundDuration: 10 });
  assert.equal(timeline.noteStartSeconds, 2);
  assert.equal(timeline.noteEndSeconds, 6);
  assert.equal(timeline.backgroundStartSeconds, -3);
  assert.equal(timeline.backgroundEndSeconds, 7);
  assert.equal(timeline.startSeconds, 0);
  assert.equal(timeline.endSeconds, 7);
  assert.equal(timeline.durationSeconds, 7);
  assert.equal(timeline.startBeat, 0);
  assert.equal(timeline.endBeat, 14);
  assert.equal(timeline.noteStartBeat, 4);
  assert.equal(timeline.noteEndBeat, 12);
});

test('the longer clip supplies the ending and initial positive delays remain on the timeline', () => {
  const timeline = createTimeline({ notes, bpm: 60, noteOffset: 4, backgroundOffset: 2, backgroundDuration: 3 });
  assert.equal(timeline.startSeconds, 0);
  assert.equal(timeline.endSeconds, 12);
  assert.equal(timeline.durationSeconds, 12);
});

test('clips entirely before zero produce an empty playable range', () => {
  const timeline = createTimeline({ notes, bpm: 120, noteOffset: -10, backgroundOffset: -8, backgroundDuration: 1 });
  assert.equal(timeline.startSeconds, 0);
  assert.equal(timeline.endSeconds, 0);
  assert.equal(timeline.durationSeconds, 0);
  assert.equal(timeline.startBeat, 0);
  assert.equal(timeline.endBeat, 0);
});

test('a backing track alone is playable and offsets on absent clips do not extend it', () => {
  const timeline = createTimeline({ notes: [], bpm: 120, noteOffset: -600, backgroundOffset: 3, backgroundDuration: 5 });
  assert.equal(timeline.hasNotes, false);
  assert.equal(timeline.hasBackground, true);
  assert.equal(timeline.startSeconds, 0);
  assert.equal(timeline.endSeconds, 8);
  assert.equal(timeline.durationBeats, 16);
  const notesOnly = createTimeline({ notes, bpm: 120, backgroundOffset: -600 });
  assert.equal(notesOnly.startSeconds, 0);
  assert.equal(notesOnly.endSeconds, 4);
});

test('tempo changes score duration and beat conversion without changing offsets in seconds', () => {
  const slow = createTimeline({ notes, bpm: 60, noteOffset: -2, backgroundOffset: 1, backgroundDuration: 4 });
  const fast = createTimeline({ notes, bpm: 120, noteOffset: -2, backgroundOffset: 1, backgroundDuration: 4 });
  assert.equal(slow.noteStartSeconds, fast.noteStartSeconds);
  assert.equal(slow.backgroundStartSeconds, fast.backgroundStartSeconds);
  assert.equal(slow.noteEndSeconds, 6);
  assert.equal(fast.noteEndSeconds, 2);
  assert.equal(slow.endSeconds, 6);
  assert.equal(fast.endSeconds, 5);
});

test('empty timelines stay at zero and invalid tempo is rejected', () => {
  const empty = createTimeline({ notes: [], bpm: 120, noteOffset: -4, backgroundOffset: 7 });
  assert.equal(empty.startBeat, 0);
  assert.equal(empty.endBeat, 0);
  assert.equal(empty.durationSeconds, 0);
  assert.equal(empty.hasNotes, false);
  assert.equal(empty.hasBackground, false);
  assert.throws(() => createTimeline({ bpm: 0 }), /Tempo/);
});

test('enabled metronome uses the longer source duration and its independent offset can extend playback', () => {
  const timeline = createTimeline({ notes, bpm: 120, noteOffset: -1, backgroundOffset: 2, backgroundDuration: 10, metronome: true, metronomeOffset: 4 });
  assert.equal(timeline.hasMetronome, true);
  assert.equal(timeline.metronomeDuration, 10);
  assert.equal(timeline.metronomeStartSeconds, 4);
  assert.equal(timeline.metronomeEndSeconds, 14);
  assert.equal(timeline.metronomeStartBeat, 8);
  assert.equal(timeline.metronomeEndBeat, 28);
  assert.equal(timeline.endSeconds, 14);
  const disabled = createTimeline({ notes, bpm: 120, metronome: false, metronomeOffset: 100 });
  assert.equal(disabled.hasMetronome, false);
  assert.equal(disabled.endSeconds, 4);
});

test('negative metronome offsets retain their grid origin while playback starts at zero', () => {
  const timeline = createTimeline({ notes: [], bpm: 120, backgroundOffset: -3, backgroundDuration: 10, metronome: true, metronomeOffset: -1 });
  assert.equal(timeline.metronomeStartBeat, -2);
  assert.equal(timeline.metronomeEndBeat, 18);
  assert.equal(timeline.startSeconds, 0);
  assert.equal(timeline.endSeconds, 9);
  const empty = createTimeline({ metronome: true, metronomeOffset: 10 });
  assert.equal(empty.hasMetronome, false);
  assert.equal(empty.durationSeconds, 0);
});

test('score timing changes determine duration while all clip offsets stay in source seconds', () => {
  const parsed = parseNotation('TEMPO 60 TSIG 4/4 1w TEMPO 120 2w TSIG 3/8 TEMPO 30 3h');
  const timing = createScoreTiming(parsed);
  const timeline = createTimeline({ notes: parsed.notes, bpm: parsed.tempo, timing, noteOffset: -2,
    backgroundDuration: 12, backgroundOffset: 1, metronome: true, metronomeOffset: 2 });
  assert.equal(timeline.timing, timing);
  assert.equal(timeline.scoreBeats, 10);
  assert.equal(timeline.scoreDuration, 10);
  assert.equal(timeline.noteEndSeconds, 8);
  assert.equal(timeline.backgroundEndSeconds, 13);
  assert.equal(timeline.metronomeEndSeconds, 14);
  assert.equal(timeline.startSeconds, 0);
  assert.equal(timeline.endSeconds, 14);
});

test('variable tempo timelines keep transport beats relative to the initial tempo', () => {
  const parsed = parseNotation('TEMPO 120 1h TEMPO 60 2h');
  const timing = createScoreTiming(parsed);
  const timeline = createTimeline({ notes: parsed.notes, bpm: parsed.tempo, timing, noteOffset: 1 });
  assert.equal(timeline.scoreBeats, 4);
  assert.equal(timeline.scoreDuration, 3);
  assert.equal(timeline.noteStartBeat, 2);
  assert.equal(timeline.noteEndBeat, 8);
  assert.equal(timeline.durationBeats, 8);
  assert.equal(createTimeline({ notes: parsed.notes, bpm: parsed.tempo, timing, noteOffset: -4 }).endSeconds, 0);
});
