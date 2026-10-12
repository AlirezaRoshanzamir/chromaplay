import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudioPeaks, alignAudioPeaks, buildNotePeaks, timeToRatio, ratioToTime, formatTimelineTime, WaveformTimeline } from './waveform.js';

function audioBuffer(channels, sampleRate = 1000) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    duration: channels[0].length / sampleRate,
    sampleRate,
    reads: 0,
    getChannelData(index) { this.reads += 1; return channels[index]; },
  };
}

const note = (startBeat, endBeat, midi = 60) => ({ startBeat, endBeat, midi, isRest: midi === null });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('PCM peaks scan every frame and preserve both channels instead of cancelling opposite phases', () => {
  const buffer = audioBuffer([new Float32Array([0, 0.9, 0.1, -0.2, 0.2, -0.8, 0.1, 0]),
    new Float32Array([0, -0.9, -0.1, 0.2, -0.2, 0.8, -0.1, 0])], 4);
  const profile = buildAudioPeaks(buffer, 2);
  close(profile.mins[0], -0.9);
  close(profile.maxs[0], 0.9);
  close(profile.mins[1], -0.8);
  close(profile.maxs[1], 0.8);
  assert.equal(profile.duration, 2);
  assert.equal(buffer.reads, 2);
  const dc = buildAudioPeaks(audioBuffer([new Float32Array([0.2, 0.4])]), 1);
  close(dc.mins[0], 0.2);
  close(dc.maxs[0], 0.4);
});

test('backing peaks keep leading and trailing silence on a shared axis with negative offsets', () => {
  const profile = buildAudioPeaks(audioBuffer([new Float32Array([0.5, -0.5, 1, -1])], 2), 2);
  const timeline = { startSeconds: -2, endSeconds: 4 };
  const shifted = alignAudioPeaks(profile, timeline, -1, 6);
  assert.deepEqual([...shifted.maxs], [0, 0.5, 1, 0, 0, 0]);
  assert.deepEqual([...shifted.mins], [0, -0.5, -1, 0, 0, 0]);
  const delayed = alignAudioPeaks(profile, timeline, 2, 6);
  assert.deepEqual([...delayed.maxs], [0, 0, 0, 0, 0.5, 1]);
});

test('note peaks follow tempo and independent note offset while rests remain silent', () => {
  const timeline = { startSeconds: -2, endSeconds: 4, noteStartSeconds: -1 };
  const peaks = buildNotePeaks({ timeline, notes: [note(0, 2), note(2, 4, null), note(4, 6)], bpm: 120 }, 6);
  [0, 0.18, 0, 0.18, 0, 0].forEach((expected, index) => close(peaks.maxs[index], expected));
  const shifted = buildNotePeaks({ timeline: { ...timeline, noteStartSeconds: 1 }, notes: [note(0, 2)], bpm: 120 }, 6);
  [0, 0, 0, 0.18, 0, 0].forEach((expected, index) => close(shifted.maxs[index], expected));
});

test('sampled note preview uses PCM amplitude, pitch-dependent sample position and sustain loops', () => {
  const pcm = new Float32Array(4000);
  for (let frame = 0; frame < pcm.length; frame += 1) {
    const amplitude = frame < 500 ? 0.1 : frame < 1000 ? 0.3 : frame < 2000 ? 0.6 : 1;
    pcm[frame] = (frame % 2 ? -1 : 1) * amplitude;
  }
  const buffer = audioBuffer([pcm]);
  const instrumentData = { buffer, samples: [{ midi: 60, start: 0, loopStart: 1, loopEnd: 2 }] };
  const data = { timeline: { startSeconds: 0, endSeconds: 8, noteStartSeconds: 0 }, notes: [note(0, 8)], bpm: 60, instrument: 'fluid', instrumentData };
  const base = buildNotePeaks(data, 80);
  close(base.maxs[1], 0.08);
  close(base.maxs[6], 0.24);
  close(base.maxs[15], 0.48);
  close(base.maxs[55], 0.48);
  assert.ok(Math.max(...base.maxs) < 0.49, 'the following sprite must not play after the sustain loop');
  const octave = buildNotePeaks({ ...data, notes: [note(0, 8, 72)] }, 80);
  close(octave.maxs[6], 0.48, 'octave-up notes reach the sustain recording twice as quickly');
  assert.equal(buffer.reads, 1, 'sample PCM is scanned only once across repeated preview builds');
});

test('short note previews retain attack and release and missing samples do not invent a waveform', () => {
  const timeline = { startSeconds: 0, endSeconds: 1, noteStartSeconds: 0 };
  const peaks = buildNotePeaks({ timeline, notes: [note(0, 1)], bpm: 60 }, 1000);
  assert.ok(peaks.maxs[0] < peaks.maxs[10]);
  assert.ok(peaks.maxs[999] < peaks.maxs[960]);
  const unavailable = buildNotePeaks({ timeline, notes: [note(0, 1)], instrument: 'vcsl' }, 10);
  assert.deepEqual([...unavailable.maxs], new Array(10).fill(0));
  assert.deepEqual([...buildNotePeaks({ timeline, notes: [note(0, 1, null)] }, 10).maxs], new Array(10).fill(0));
});

test('shared-axis seeking maps negative time, clamps boundaries and handles an empty timeline', () => {
  const timeline = { startSeconds: -10, endSeconds: 30 };
  assert.equal(timeToRatio(0, timeline), 0.25);
  assert.equal(ratioToTime(0.25, timeline), 0);
  assert.equal(ratioToTime(-1, timeline), -10);
  assert.equal(ratioToTime(2, timeline), 30);
  assert.equal(timeToRatio(10, { startSeconds: 3, endSeconds: 3 }), 0);
  assert.equal(ratioToTime(0.5, { startSeconds: 3, endSeconds: 3 }), 3);
  assert.equal(formatTimelineTime(-61.2, true), '-1:01.2');
  assert.equal(formatTimelineTime(59.999, true), '1:00.0');
});

test('playhead-only updates reuse cached canvases and leave sample data untouched', () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (target, key) => target[key] || ((...args) => calls.push([key, ...args])) });
  const canvases = new Map(['#waveform-ruler', '#track-waveform', '#notes-waveform'].map(id => [id, {
    width: 400, height: 80, style: {}, attrs: {}, listeners: new Map(),
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    removeEventListener(type) { this.listeners.delete(type); },
    getContext() { return ctx; },
    getBoundingClientRect() { return { width: 400, height: 80, left: 0 }; },
  }]));
  const root = { querySelector: id => canvases.get(id), ownerDocument: { createElement: () => ({ getContext: () => ctx }) } };
  const buffer = audioBuffer([new Float32Array([0.5, -0.5, 0.3, -0.3])], 1);
  const seeks = [];
  const display = new WaveformTimeline(root, { onSeek: seconds => seeks.push(seconds) });
  display.setData({ timeline: { startSeconds: -2, endSeconds: 4, noteStartSeconds: 0, backgroundStartSeconds: -2 }, backgroundBuffer: buffer, notes: [note(0, 2)] });
  const reads = buffer.reads;
  const fills = calls.filter(call => call[0] === 'fillText').length;
  display.setPosition(1);
  display.setPosition(2);
  assert.equal(buffer.reads, reads);
  assert.equal(calls.filter(call => call[0] === 'fillText').length, fills, 'static ruler and waveforms are not rebuilt');
  for (const canvas of canvases.values()) assert.equal(canvas.attrs['aria-valuenow'], '2');
  const ruler = canvases.get('#waveform-ruler');
  ruler.listeners.get('keydown')({ key: 'Home', preventDefault() {} });
  assert.deepEqual(seeks, [-2]);
  display.destroy();
  assert.equal(ruler.listeners.size, 0);
});
