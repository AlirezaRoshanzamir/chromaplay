import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudioPeaks, alignAudioPeaks, buildNotePeaks, buildMetronomePeaks, clampViewport, timeToRatio, ratioToTime, formatTimelineTime, WaveformTimeline } from './waveform.js';

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

function makeDisplay() {
  const calls = [];
  const ctx = new Proxy({}, { get: (target, key) => target[key] || ((...args) => calls.push([key, ...args])) });
  const control = () => ({ style: {}, attrs: {}, listeners: new Map(),
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    removeEventListener(type) { this.listeners.delete(type); },
  });
  const canvases = new Map(['#waveform-ruler', '#track-waveform', '#notes-waveform', '#metronome-waveform'].map(id => [id, {
    ...control(),
    width: 400, height: 80, style: {}, attrs: {}, listeners: new Map(),
    getContext() { return ctx; },
    getBoundingClientRect() { return { width: 400, height: 80, left: 0 }; },
    focus() {}, setPointerCapture(id) { this.captured = id; },
    hasPointerCapture(id) { return this.captured === id; }, releasePointerCapture() { this.captured = null; },
  }]));
  const controls = new Map(['zoom-in', 'zoom-out', 'zoom-fit', 'zoom-value', 'pan', 'view-range'].map(name => [`#waveform-${name}`, control()]));
  const root = { querySelector: id => canvases.get(id) || controls.get(id), ownerDocument: { createElement: () => ({ getContext: () => ctx }) } };
  const seeks = [];
  const display = new WaveformTimeline(root, { onSeek: seconds => seeks.push(seconds) });
  return { display, seeks, calls, canvases, controls };
}

test('playhead-only updates reuse all four cached canvases and leave sample data untouched', () => {
  const { display, seeks, calls, canvases } = makeDisplay();
  const buffer = audioBuffer([new Float32Array([0.5, -0.5, 0.3, -0.3])], 1);
  display.setData({ timeline: { startSeconds: 0, endSeconds: 4, noteStartSeconds: 0, backgroundStartSeconds: -2,
    metronomeStartSeconds: 1, metronomeEndSeconds: 4, hasMetronome: true }, backgroundBuffer: buffer, notes: [note(0, 2)], metronome: true });
  const reads = buffer.reads;
  const fills = calls.filter(call => call[0] === 'fillText').length;
  display.setPosition(1);
  display.setPosition(2);
  assert.equal(buffer.reads, reads);
  assert.equal(calls.filter(call => call[0] === 'fillText').length, fills, 'static ruler and waveforms are not rebuilt');
  for (const canvas of canvases.values()) assert.equal(canvas.attrs['aria-valuenow'], '2');
  const ruler = canvases.get('#waveform-ruler');
  ruler.listeners.get('keydown')({ key: 'Home', preventDefault() {} });
  assert.deepEqual(seeks, [0]);
  display.destroy();
  assert.equal(ruler.listeners.size, 0);
});

test('metronome peaks follow their own offset, eighth-note meter and accented pulse envelope', () => {
  const data = { timeline: { startSeconds: 0, endSeconds: 5, noteStartSeconds: 3, backgroundStartSeconds: 0,
    metronomeStartSeconds: 1, metronomeEndSeconds: 5, hasMetronome: true }, bpm: 60, numerator: 6, denominator: 8, metronome: true };
  const peaks = buildMetronomePeaks(data, 500);
  assert.ok(peaks.maxs.slice(0, 100).every(value => value === 0));
  close(peaks.maxs[100], 0.28 * 0.65);
  close(peaks.maxs[150], 0.20 * 0.65);
  close(peaks.maxs[400], 0.28 * 0.65);
  assert.ok(peaks.maxs[101] < peaks.maxs[100], 'the attack decays after 2 ms');
  assert.equal(peaks.maxs[108], 0, 'a click ends after 70 ms');
  const cropped = buildMetronomePeaks({ ...data, timeline: { ...data.timeline, metronomeEndSeconds: 4.001 } }, 500);
  close(cropped.maxs[400], 0.14 * 0.65);
  assert.equal(cropped.maxs[401], 0);
  assert.ok(buildMetronomePeaks({ ...data, metronome: false }, 500).maxs.every(value => value === 0));
});

test('negative metronome prefixes are skipped at time zero without replaying earlier clicks', () => {
  const peaks = buildMetronomePeaks({ timeline: { startSeconds: 0, endSeconds: 1,
    metronomeStartSeconds: -0.03, metronomeEndSeconds: 0.97, hasMetronome: true }, bpm: 60, numerator: 4, denominator: 8, metronome: true }, 1000);
  assert.ok(peaks.maxs.slice(0, 470).every(value => value === 0));
  close(peaks.maxs[472], 0.20 * 0.65);
  assert.ok(peaks.maxs.slice(970).every(value => value === 0));
  const overview = buildMetronomePeaks({ timeline: { startSeconds: 0, endSeconds: 100000,
    metronomeStartSeconds: 0, metronomeEndSeconds: 100000 }, bpm: 300, numerator: 32, denominator: 16, metronome: true }, 20000);
  assert.equal(overview.maxs.length, 1500);
  assert.ok(overview.maxs.every(value => Math.abs(value - 0.28 * 0.65) < 1e-6));
});

test('viewport bounds clamp zoom, pan, empty timelines and negative runtime prefixes', () => {
  assert.deepEqual(clampViewport({ startSeconds: 0, endSeconds: 100 }, 4, 90), { zoom: 4, startSeconds: 75, endSeconds: 100, durationSeconds: 25 });
  assert.equal(clampViewport({ startSeconds: 0, endSeconds: 100 }, 100, -10).zoom, 32);
  assert.equal(clampViewport({ startSeconds: 0, endSeconds: 100 }, 0, 50).zoom, 1);
  assert.deepEqual(clampViewport({ startSeconds: -20, endSeconds: 0 }, 4, -20), { zoom: 1, startSeconds: 0, endSeconds: 0, durationSeconds: 0 });
  assert.equal(clampViewport({ startSeconds: -20, endSeconds: 100 }, 2, -10).startSeconds, 0);
});

test('zoom and pan controls keep all lanes aligned and pointer seeking uses the visible window', () => {
  const { display, controls, canvases, seeks } = makeDisplay();
  display.setData({ timeline: { startSeconds: 0, endSeconds: 100 }, notes: [note(0, 100)] });
  assert.equal(controls.get('#waveform-zoom-out').disabled, true);
  assert.equal(controls.get('#waveform-pan').disabled, true);
  assert.equal(controls.get('#waveform-pan').hidden, true);
  display.setPosition(40);
  controls.get('#waveform-zoom-in').listeners.get('click')();
  assert.deepEqual(display.view, { zoom: 2, startSeconds: 20, endSeconds: 70, durationSeconds: 50 });
  assert.equal(controls.get('#waveform-zoom-value').textContent, '2x');
  assert.equal(controls.get('#waveform-pan').disabled, false);
  assert.equal(controls.get('#waveform-pan').hidden, false);
  assert.equal(controls.get('#waveform-view-range').textContent, '0:20.0 - 1:10.0');
  const pan = controls.get('#waveform-pan');
  pan.value = '40'; pan.listeners.get('input')();
  assert.equal(display.view.startSeconds, 40);
  const canvas = canvases.get('#metronome-waveform');
  canvas.listeners.get('pointerdown')({ button: 0, pointerId: 1, clientX: 200, preventDefault() {} });
  assert.equal(seeks.at(-1), 65);
  canvas.listeners.get('pointerup')({ pointerId: 1 });
  for (const lane of canvases.values()) assert.equal(lane.attrs['aria-valuenow'], '65');
  display.setZoom(32);
  assert.equal(controls.get('#waveform-zoom-in').disabled, true);
  controls.get('#waveform-zoom-fit').listeners.get('click')();
  assert.deepEqual(display.view, { zoom: 1, startSeconds: 0, endSeconds: 100, durationSeconds: 100 });
  assert.equal(controls.get('#waveform-zoom-fit').disabled, true);
  assert.equal(controls.get('#waveform-pan').hidden, true);
  display.destroy();
  assert.equal(controls.get('#waveform-zoom-in').listeners.size, 0);
});

test('zoomed playback follows only on request, while seeks and resized timelines keep the view valid', () => {
  const { display, canvases } = makeDisplay();
  display.setData({ timeline: { startSeconds: 0, endSeconds: 100 } });
  display.setZoom(4);
  display.setPosition(60);
  assert.equal(display.view.startSeconds, 0, 'paused position updates do not pan');
  display.setPosition(60, { follow: true });
  assert.equal(display.view.startSeconds, 57.5);
  const ruler = canvases.get('#waveform-ruler');
  ruler.listeners.get('keydown')({ key: 'End', preventDefault() {} });
  assert.equal(display.position, 100);
  assert.equal(display.view.endSeconds, 100);
  ruler.listeners.get('keydown')({ key: 'Home', preventDefault() {} });
  assert.equal(display.position, 0);
  assert.equal(display.view.startSeconds, 0);
  display.panTo(70);
  display.setData({ timeline: { startSeconds: 0, endSeconds: 20 } });
  assert.deepEqual(display.view, { zoom: 4, startSeconds: 15, endSeconds: 20, durationSeconds: 5 });
  display.setPosition(-10, { follow: true });
  assert.equal(display.position, 0);
  assert.equal(display.view.startSeconds, 0);
  display.destroy();
});
