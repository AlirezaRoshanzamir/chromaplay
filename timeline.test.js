import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline } from './timeline.js';

const notes = [{ startBeat: 0, endBeat: 8 }];

test('both clips determine the timeline, preserving independent offsets in seconds', () => {
  const timeline = createTimeline({ notes, bpm: 120, noteOffset: 2, backgroundOffset: -3, backgroundDuration: 10 });
  assert.equal(timeline.noteStartSeconds, 2);
  assert.equal(timeline.noteEndSeconds, 6);
  assert.equal(timeline.backgroundStartSeconds, -3);
  assert.equal(timeline.backgroundEndSeconds, 7);
  assert.equal(timeline.startSeconds, -3);
  assert.equal(timeline.endSeconds, 7);
  assert.equal(timeline.durationSeconds, 10);
  assert.equal(timeline.startBeat, -6);
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

test('a timeline can finish before zero when all clips do', () => {
  const timeline = createTimeline({ notes, bpm: 120, noteOffset: -10, backgroundOffset: -8, backgroundDuration: 1 });
  assert.equal(timeline.startSeconds, -10);
  assert.equal(timeline.endSeconds, -6);
  assert.equal(timeline.durationSeconds, 4);
  assert.equal(timeline.startBeat, -20);
  assert.equal(timeline.endBeat, -12);
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
