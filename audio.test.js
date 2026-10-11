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
    this.playbackRate = new FakeParameter();
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

test('mute combinations change live sound without stopping or seeking either channel', async t => {
  const audio = makeAudio(t);
  audio.setMetronome(true);
  await addBackground(audio);
  await audio.play({ notes: score, bpm: 120 });
  const context = audio._context;
  context.currentTime = 0.535;
  const sources = [...context.nodes];
  const stops = sources.map(source => [...source.stops]);
  const startTime = audio._startTime;
  const endTime = audio._endTime;
  for (const [noteMuted, backgroundMuted] of [[true, false], [false, true], [true, true], [false, false]]) {
    audio.setNoteMuted(noteMuted);
    audio.setBackgroundMuted(backgroundMuted);
    assert.equal(audio._noteGain.gain.events.at(-1).value, noteMuted ? 0 : 0.7);
    assert.equal(audio._clickGain.gain.events.at(-1).value, noteMuted ? 0 : 0.65);
    assert.equal(audio._backgroundGain.gain.events.at(-1).value, backgroundMuted ? 0 : 0.65);
    assert.equal(audio.isPlaying, true);
    assert.equal(audio.metronomeEnabled, true);
    assert.equal(audio._startTime, startTime);
    assert.equal(audio._endTime, endTime);
    close(audio.getPosition(), 1);
    assert.deepEqual(context.nodes, sources);
    assert.deepEqual(sources.map(source => source.stops), stops);
  }
  audio.setNoteMuted(true);
  audio.setBackgroundMuted(true);
  context.currentTime = 0.785;
  close(audio.getPosition(), 1.5);
});

test('muting before audio starts is honored and changing muted volumes stays silent', async t => {
  const audio = makeAudio(t);
  audio.setNoteMuted(true);
  audio.setBackgroundMuted(true);
  audio.setNoteVolume(0.3);
  audio.setBackgroundVolume(0.8);
  assert.equal(audio._context, null);
  await addBackground(audio);
  await audio.play({ notes: score, bpm: 120 });
  assert.equal(audio._noteGain.gain.value, 0);
  assert.equal(audio._clickGain.gain.value, 0);
  assert.equal(audio._backgroundGain.gain.value, 0);
  audio.setNoteVolume(0.45);
  audio.setBackgroundVolume(0.9);
  assert.equal(audio._noteGain.gain.events.at(-1).value, 0);
  assert.equal(audio._backgroundGain.gain.events.at(-1).value, 0);
  assert.equal(audio.noteVolume, 0.45);
  assert.equal(audio.backgroundVolume, 0.9);
  audio.setNoteMuted(false);
  audio.setBackgroundMuted(false);
  assert.equal(audio._noteGain.gain.events.at(-1).value, 0.45);
  assert.equal(audio._clickGain.gain.events.at(-1).value, 0.65);
  assert.equal(audio._backgroundGain.gain.events.at(-1).value, 0.9);
});

test('notes mute controls an already held manual note without restarting it', async t => {
  const audio = makeAudio(t);
  await audio.startManualNote(60);
  const voice = audio._manualVoice;
  audio.setNoteMuted(true);
  assert.equal(audio._noteGain.gain.events.at(-1).value, 0);
  audio.setNoteMuted(false);
  assert.equal(audio._noteGain.gain.events.at(-1).value, 0.7);
  assert.equal(audio._manualVoice, voice);
  assert.equal(voice.source.stops.length, 0);
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

const sampleMetadata = {
  fluid: { samples: [{ midi: 60, start: 0, loopStart: 0.5, loopEnd: 1.6 }, { midi: 72, start: 2, loopStart: 2.5, loopEnd: 3.6 }] },
  vcsl: { samples: [{ midi: 60, start: 0, loopStart: 0.5, loopEnd: 1.6 }] },
};

function mockSamples(t, responseForAudio = () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })) {
  return t.mock.method(globalThis, 'fetch', async url => String(url).endsWith('.json')
    ? { ok: true, json: async () => sampleMetadata }
    : responseForAudio(String(url)));
}

test('sampled score notes use pitched sustain loops, shared mute gain, and accurate pause/resume durations', async t => {
  const fetchMock = mockSamples(t);
  const audio = makeAudio(t);
  assert.equal(await audio.setInstrument('fluid'), true);
  await audio.play({ notes: score, bpm: 60 });
  const voice = [...audio._voices].find(voice => voice.type === 'note');
  assert.equal(voice.source.kind, 'buffer');
  assert.equal(voice.source.loop, true);
  assert.equal(voice.source.loopStart, 0.5);
  assert.equal(voice.source.loopEnd, 1.6);
  assert.equal(voice.source.offset, 0);
  assert.equal(voice.source.playbackRate.events[0].value, 1);
  close(voice.source.stops[0], 2.04);
  assert.equal(voice.gain.connections[0], audio._noteGain);
  audio.setNoteMuted(true);
  assert.equal(audio._noteGain.gain.events.at(-1).value, 0);
  audio._context.currentTime = 1.035;
  close(audio.pause(), 1);
  assert.equal(voice.source.disconnected, true);
  await audio.play({ notes: score, bpm: 60, fromBeat: 3 });
  const resumed = [...audio._voices].find(voice => voice.type === 'note');
  close(resumed.source.playbackRate.events[0].value, 2 ** (2 / 12));
  close(resumed.source.stops[0] - resumed.source.startTime, 5.005);
  await audio.setInstrument('synth');
  await audio.setInstrument('fluid');
  assert.equal(fetchMock.mock.callCount(), 2, 'the decoded bank is cached');
});

test('sampled manual notes sustain until release, including beyond the recorded sample duration', async t => {
  mockSamples(t);
  const audio = makeAudio(t);
  await audio.setInstrument('vcsl');
  await audio.startManualNote(61);
  const voice = audio._manualVoice;
  assert.equal(voice.source.loop, true);
  close(voice.source.playbackRate.events[0].value, 2 ** (1 / 12));
  assert.equal(voice.source.stops.length, 0);
  audio._context.currentTime = 30;
  audio.stopManualNote();
  close(voice.gain.gain.events.at(-2).value, 0.8);
  close(voice.source.stops[0], 30.05);
});

test('selecting sounds out of order cannot replace the latest selection or start a stale manual note', async t => {
  let releaseFluid;
  let startedFluid;
  const waiting = new Promise(resolve => { startedFluid = resolve; });
  mockSamples(t, url => url.endsWith('/fluid.wav')
    ? new Promise(resolve => {
      releaseFluid = () => resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
      startedFluid();
    })
    : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  const audio = makeAudio(t);
  const first = audio.setInstrument('fluid');
  await waiting;
  const manual = audio.startManualNote(60);
  assert.equal(await audio.setInstrument('vcsl'), true);
  const bank = audio._instrumentData;
  releaseFluid();
  assert.equal(await first, false);
  assert.equal(await manual, false);
  assert.equal(audio.instrument, 'vcsl');
  assert.equal(audio._instrumentData, bank);
  assert.equal(audio._context.nodes.length, 0);
});

test('stopping while samples load cancels both pending score and manual starts', async t => {
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  mockSamples(t, () => new Promise(resolve => {
    release = () => resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    started();
  }));
  const audio = makeAudio(t);
  const selection = audio.setInstrument('fluid');
  await waiting;
  const playing = audio.play({ notes: score, bpm: 60 });
  const manual = audio.startManualNote(60);
  audio.stop();
  release();
  await selection;
  await playing;
  assert.equal(await manual, false);
  assert.equal(audio.isPlaying, false);
  assert.equal(audio._context.nodes.length, 0);
});

test('a failed sample download never silently plays the prior instrument and Play can retry it', async t => {
  let fail = true;
  mockSamples(t, () => ({ ok: !fail, arrayBuffer: async () => new ArrayBuffer(8) }));
  const audio = makeAudio(t);
  await assert.rejects(audio.setInstrument('fluid'), /could not load/);
  assert.equal(audio.instrument, 'fluid');
  await assert.rejects(audio.play({ notes: score, bpm: 60 }), /could not load/);
  assert.equal(audio.isPlaying, false);
  assert.equal(audio._context.nodes.length, 0);
  fail = false;
  assert.equal(await audio.startManualNote(60), true, 'a retry does not cancel its own manual start');
  assert.equal(audio._manualVoice.source.kind, 'buffer');
  assert.equal(audio.instrument, 'fluid');
});

test('a failed older sound request does not surface an error after a newer choice succeeds', async t => {
  let failFluid;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  mockSamples(t, () => new Promise((resolve, reject) => { failFluid = reject; started(); }));
  const audio = makeAudio(t);
  const pending = audio.setInstrument('fluid');
  await waiting;
  assert.equal(await audio.setInstrument('synth'), true);
  failFluid(new Error('network failed'));
  assert.equal(await pending, false);
  assert.equal(audio.instrument, 'synth');
  await audio.startManualNote(60);
  assert.equal(audio._manualVoice.source.kind, 'oscillator');
});
