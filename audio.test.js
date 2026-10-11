import test from 'node:test';
import assert from 'node:assert/strict';
import { PracticeAudio } from './audio.js';

class FakeParameter {
  constructor() { this.events = []; }
  setValueAtTime(value, time) { this.events.push({ value, time }); }
  linearRampToValueAtTime(value, time) { this.events.push({ value, time }); }
  exponentialRampToValueAtTime(value, time) { this.events.push({ value, time }); }
  setTargetAtTime(value, time) { this.events.push({ value, time }); }
  cancelScheduledValues(time) { this.cancelledAt = time; }
}

class FakeNode {
  constructor(kind) {
    this.kind = kind;
    this.gain = new FakeParameter();
    this.frequency = new FakeParameter();
    this.stops = [];
    this.connections = [];
  }
  connect(node) { this.connections.push(node); }
  disconnect() { this.disconnected = true; }
  setPeriodicWave(wave) { this.wave = wave; }
  start(time, offset) { this.startTime = time; this.offset = offset; }
  stop(time) { this.stops.push(time); }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.nodes = [];
    this.destination = {};
  }
  createGain() { return new FakeNode('gain'); }
  createPeriodicWave() { return {}; }
  createOscillator() { const node = new FakeNode('oscillator'); this.nodes.push(node); return node; }
  createBufferSource() { const node = new FakeNode('buffer'); this.nodes.push(node); return node; }
  async resume() {}
  async decodeAudioData() { return { duration: 60 }; }
}

globalThis.AudioContext = FakeAudioContext;

const score = [
  { startBeat: 0, endBeat: 2, beats: 2, midi: 60, isRest: false },
  { startBeat: 2, endBeat: 3, beats: 1, midi: null, isRest: true },
  { startBeat: 3, endBeat: 8, beats: 5, midi: 62, isRest: false },
];

function makeAudio(t, callbacks) {
  const audio = new PracticeAudio(callbacks);
  t.after(() => audio.stop());
  return audio;
}

async function addBackground(audio) {
  await audio.setBackground({ name: 'piano.wav', arrayBuffer: async () => new ArrayBuffer(8) });
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);
}

test('pause and resume use the audio clock and replay only the remaining part of a held note', async t => {
  const audio = makeAudio(t);
  await audio.play({ notes: score, bpm: 120 });
  const context = audio._context;
  const firstSource = context.nodes[0];
  close(firstSource.startTime, 0.035);
  context.currentTime = 0.535;
  close(audio.getPosition(), 1);
  close(audio.pause(), 1);
  assert.equal(firstSource.stops.at(-1), context.currentTime);
  assert.equal(audio._voices.size, 0);

  await audio.play({ notes: score, bpm: 120, fromBeat: 1 });
  const resumedSource = context.nodes.at(-1);
  close(resumedSource.startTime, 0.57);
  close(resumedSource.stops[0], 1.075);
  close(audio.getPosition(), 1);
});

test('a positive backing offset delays its start and a negative offset seeks into its buffer', async t => {
  const audio = makeAudio(t);
  await addBackground(audio);
  await audio.play({ notes: score, bpm: 120, backgroundOffset: 2 });
  let source = audio._context.nodes.find(node => node.kind === 'buffer');
  close(source.startTime, 2.035);
  close(source.offset, 0);
  close(source.stops[0], 4.035);

  await audio.play({ notes: score, bpm: 120, backgroundOffset: -1 });
  source = audio._context.nodes.filter(node => node.kind === 'buffer').at(-1);
  close(source.startTime, 0.035);
  close(source.offset, 1);
});

test('negative backing offset adds a synchronized lead-in and can resume halfway through it', async t => {
  const audio = makeAudio(t);
  await addBackground(audio);
  await audio.play({ notes: score, bpm: 120, backgroundOffset: -1, includeLeadIn: true });
  let source = audio._context.nodes.find(node => node.kind === 'buffer');
  close(source.startTime, 0.035);
  close(source.offset, 0);
  close(audio.getPosition(), -2);
  assert.equal(audio._context.nodes.filter(node => node.kind === 'oscillator').length, 0);
  audio._context.currentTime = 0.535;
  close(audio.pause(), -1);

  await audio.play({ notes: score, bpm: 120, fromBeat: -1, backgroundOffset: -1 });
  source = audio._context.nodes.filter(node => node.kind === 'buffer').at(-1);
  close(source.startTime, 0.57);
  close(source.offset, 0.5);
  close(audio.getPosition(), -1);
});

test('seeking seeks backing audio relative to score time, and rests schedule no note voice', async t => {
  const audio = makeAudio(t);
  await addBackground(audio);
  await audio.play({ notes: score, bpm: 120, fromBeat: 2, backgroundOffset: -1 });
  const source = audio._context.nodes.find(node => node.kind === 'buffer');
  close(source.offset, 2);
  assert.equal(audio._context.nodes.filter(node => node.kind === 'oscillator').length, 0);
  audio._context.currentTime = 0.4;
  audio._tick();
  const note = audio._context.nodes.find(node => node.kind === 'oscillator');
  close(note.startTime, 0.535);
});

test('stop cancels pending background and note sources, and the score ends exactly once', async t => {
  let ends = 0;
  const audio = makeAudio(t, { onEnded: () => { ends += 1; } });
  await addBackground(audio);
  await audio.play({ notes: score, bpm: 120, backgroundOffset: 2 });
  const nodes = [...audio._context.nodes];
  audio.stop();
  for (const source of nodes) {
    assert.equal(source.stops.at(-1), 0);
    assert.equal(source.disconnected, true);
  }
  assert.equal(audio._voices.size, 0);
  assert.equal(audio.getPosition(), 0);

  await audio.play({ notes: score, bpm: 120 });
  audio._context.currentTime = 4.1;
  audio._tick();
  audio._tick();
  assert.equal(audio.isPlaying, false);
  assert.equal(audio.getPosition(), 8);
  assert.equal(ends, 1);
});

test('a stop while AudioContext resumes cannot start stale playback', async t => {
  const audio = makeAudio(t);
  const context = audio._ensureContext();
  let resume;
  context.resume = () => new Promise(resolve => { resume = resolve; });
  const pending = audio.play({ notes: score, bpm: 120 });
  audio.stop();
  resume();
  await pending;
  assert.equal(audio.isPlaying, false);
  assert.equal(context.nodes.length, 0);
});

test('6/8 metronome pulses use eighth notes while tempo remains quarter-note BPM', async t => {
  const audio = makeAudio(t);
  audio.setTimeSignature(6, 8);
  audio.setMetronome(true);
  await audio.play({ notes: score, bpm: 120 });
  audio._context.currentTime = 0.1;
  audio._tick();
  const clicks = audio._context.nodes.filter(node => node.type === 'triangle');
  assert.equal(clicks.length, 2);
  close(clicks[0].startTime, 0.035);
  close(clicks[1].startTime, 0.285);
  assert.equal(clicks[0].frequency.events[0].value, 1450);
  assert.equal(clicks[1].frequency.events[0].value, 1000);
});

test('empty scores do not start audio, and backing offsets do not create lead-in without a track', async t => {
  const audio = makeAudio(t);
  await audio.play({ notes: [], bpm: 120 });
  assert.equal(audio.isPlaying, false);
  assert.equal(audio._context, null);
  await audio.play({ notes: score, bpm: 120, backgroundOffset: -5, includeLeadIn: true });
  assert.equal(audio.getPosition(), 0);
});

test('manual notes sustain the requested pitch through the shared note volume without moving the score', async t => {
  const audio = makeAudio(t);
  await audio.play({ notes: score, bpm: 120, fromBeat: 1 });
  audio.pause();
  audio.setNoteVolume(0.4);
  assert.equal(await audio.startManualNote(69), true);
  const voice = audio._manualVoice;
  assert.equal(voice.source.frequency.events[0].value, 440);
  assert.equal(voice.source.wave, audio._reedWave);
  assert.equal(voice.gain.connections[0], audio._noteGain);
  assert.equal(audio._noteGain.gain.events.at(-1).value, 0.4);
  assert.equal(voice.source.stops.length, 0);
  audio._context.currentTime = 10;
  assert.equal(audio.getPosition(), 1);
  assert.equal(audio.isPlaying, false);

  audio.stopManualNote();
  close(voice.gain.gain.events.at(-2).value, 0.18);
  close(voice.gain.gain.events.at(-1).time, 10.045);
  assert.equal(voice.gain.gain.events.at(-1).value, 0);
  close(voice.source.stops[0], 10.05);
  assert.equal(audio._manualVoice, null);
  voice.source.onended();
  assert.equal(voice.source.disconnected, true);
  assert.equal(voice.gain.disconnected, true);
  assert.equal(audio._voices.size, 0);
});

test('quick manual taps release from their current attack level instead of jumping in volume', async t => {
  const audio = makeAudio(t);
  await audio.startManualNote(60);
  const voice = audio._manualVoice;
  audio._context.currentTime = 0.009;
  audio.stopManualNote();
  close(voice.gain.gain.cancelledAt, 0.009);
  close(voice.gain.gain.events.at(-2).value, 0.09);
  close(voice.source.stops[0], 0.059);
  audio.stopManualNote();
  assert.equal(voice.source.stops.length, 1);
});

test('replacing a manual note releases its predecessor and old cleanup preserves the new voice', async t => {
  const audio = makeAudio(t);
  await audio.startManualNote(60);
  const previous = audio._manualVoice;
  audio._context.currentTime = 0.1;
  assert.equal(await audio.startManualNote(72), true);
  const current = audio._manualVoice;
  assert.notEqual(current, previous);
  close(previous.source.stops[0], 0.15);
  close(current.source.frequency.events[0].value, previous.source.frequency.events[0].value * 2);
  previous.source.onended();
  assert.equal(audio._manualVoice, current);
  assert.equal(current.source.stops.length, 0);
});

test('manual stop cancels an async start before the browser grants audio access', async t => {
  const audio = makeAudio(t);
  const context = audio._ensureContext();
  let resume;
  context.resume = () => new Promise(resolve => { resume = resolve; });
  const pending = audio.startManualNote(60);
  audio.stopManualNote();
  resume();
  assert.equal(await pending, false);
  assert.equal(audio._manualVoice, null);
  assert.equal(context.nodes.length, 0);
});

test('only the newest pending manual note starts when resume promises resolve out of order', async t => {
  const audio = makeAudio(t);
  const context = audio._ensureContext();
  const resumes = [];
  context.resume = () => new Promise(resolve => { resumes.push(resolve); });
  const first = audio.startManualNote(60);
  const second = audio.startManualNote(69);
  resumes[1]();
  assert.equal(await second, true);
  resumes[0]();
  assert.equal(await first, false);
  assert.equal(context.nodes.length, 1);
  assert.equal(context.nodes[0].frequency.events[0].value, 440);
});

test('score play, pause, and stop release held manual notes and cancel pending manual starts', async t => {
  for (const action of ['play', 'pause', 'stop']) {
    await t.test(action, async subtest => {
      const audio = makeAudio(subtest);
      await audio.startManualNote(69);
      const voice = audio._manualVoice;
      audio._context.currentTime = 0.1;
      const invoke = () => action === 'play'
        ? audio.play({ notes: score, bpm: 120, fromBeat: 1 })
        : audio[action]();
      await invoke();
      close(voice.source.stops[0], 0.15);
      assert.equal(audio._manualVoice, null);
      audio.pause();

      const context = audio._context;
      const nodeCount = context.nodes.length;
      const resumes = [];
      context.resume = () => new Promise(resolve => { resumes.push(resolve); });
      const pending = audio.startManualNote(72);
      const scoreAction = invoke();
      resumes[0]();
      assert.equal(await pending, false);
      assert.equal(context.nodes.length, nodeCount);
      if (action === 'play') resumes[1]();
      await scoreAction;
      assert.equal(audio._manualVoice, null);
    });
  }
});
