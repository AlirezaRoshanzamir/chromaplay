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
  close(source.stops[0], 62.035);

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

test('stop cancels pending sources and playback ends once after the longer backing track', async t => {
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
  assert.equal(audio.isPlaying, true);
  assert.equal(ends, 0);
  audio._context.currentTime = 60.1;
  audio._tick();
  audio._tick();
  assert.equal(audio.isPlaying, false);
  assert.equal(audio.getPosition(), 120);
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

test('independent note and backing offsets schedule on the same clock and resume a shifted held note', async t => {
  const audio = makeAudio(t);
  await addBackground(audio);
  await audio.play({ notes: score, bpm: 120, noteOffset: 2, backgroundOffset: 1, includeLeadIn: true });
  const context = audio._context;
  const background = [...audio._voices].find(voice => voice.type === 'background');
  close(background.source.startTime, 1.035);
  assert.equal([...audio._voices].some(voice => voice.type === 'note'), false);
  context.currentTime = 1.9;
  audio._tick();
  const note = [...audio._voices].find(voice => voice.type === 'note');
  close(note.source.startTime, 2.035);
  close(note.source.stops[0], 3.04);
  context.currentTime = 2.535;
  close(audio.pause(), 5);
  await audio.play({ notes: score, bpm: 120, noteOffset: 2, backgroundOffset: 1, fromBeat: 5 });
  const resumedNote = [...audio._voices].find(voice => voice.type === 'note');
  const resumedBackground = [...audio._voices].find(voice => voice.type === 'background');
  close(resumedNote.source.startTime, 2.57);
  close(resumedNote.source.stops[0], 3.075);
  close(resumedBackground.source.offset, 1.5);
});

test('notes can lead the backing track and the metronome moves with their score grid', async t => {
  const audio = makeAudio(t);
  await addBackground(audio);
  audio.setMetronome(true);
  await audio.play({ notes: score, bpm: 120, noteOffset: -2, backgroundOffset: 1, includeLeadIn: true });
  const context = audio._context;
  close(audio.getPosition(), -4);
  close([...audio._voices].find(voice => voice.type === 'note').source.startTime, 0.035);
  close([...audio._voices].find(voice => voice.type === 'click').source.startTime, 0.035);
  close([...audio._voices].find(voice => voice.type === 'background').source.startTime, 3.035);
  context.currentTime = 0.4;
  audio._tick();
  const clicks = [...audio._voices].filter(voice => voice.type === 'click');
  close(clicks[1].source.startTime, 0.535);
  audio.stop();
  close(audio.getPosition(), -4);
});

test('seeking into the backing tail does not replay notes or continue the score metronome', async t => {
  const audio = makeAudio(t);
  await addBackground(audio);
  audio.setMetronome(true);
  await audio.play({ notes: score, bpm: 120, noteOffset: 1, backgroundOffset: -2, fromBeat: 15 });
  close(audio.getPosition(), 15);
  const voices = [...audio._voices];
  assert.equal(voices.length, 1);
  assert.equal(voices[0].type, 'background');
  close(voices[0].source.offset, 9.5);
  close(voices[0].source.stops[0], 50.535);
  audio._context.currentTime = 0.5;
  audio._tick();
  assert.equal([...audio._voices].some(voice => voice.type === 'note' || voice.type === 'click'), false);
  assert.equal(audio.isPlaying, true);
});

test('a backing-only timeline plays without waiting for a harmonica sound and stops at its own end', async t => {
  let ends = 0;
  const audio = makeAudio(t, { onEnded: () => { ends += 1; } });
  await addBackground(audio);
  audio._instrumentReady = new Promise(() => {});
  audio.setMetronome(true);
  await audio.play({ notes: [], bpm: 120, backgroundOffset: -2, includeLeadIn: true });
  const voices = [...audio._voices];
  assert.equal(voices.length, 1);
  assert.equal(voices[0].type, 'background');
  close(audio.getPosition(), -4);
  close(voices[0].source.offset, 0);
  close(voices[0].source.stops[0], 60.035);
  audio._context.currentTime = 60.1;
  audio._tick();
  assert.equal(audio.isPlaying, false);
  close(audio.getPosition(), 116);
  assert.equal(ends, 1);
});

test('an entirely negative score range starts, clamps seeks, and finishes before timeline zero', async t => {
  let ends = 0;
  const audio = makeAudio(t, { onEnded: () => { ends += 1; } });
  await audio.play({ notes: score, bpm: 120, noteOffset: -10, includeLeadIn: true });
  assert.equal(audio.isPlaying, true);
  close(audio.getPosition(), -20);
  close([...audio._voices][0].source.startTime, 0.035);
  audio._context.currentTime = 4.1;
  audio._tick();
  assert.equal(audio.isPlaying, false);
  close(audio.getPosition(), -12);
  assert.equal(ends, 1);
  await audio.play({ notes: score, bpm: 120, noteOffset: -10, fromBeat: -50 });
  close(audio.getPosition(), -20);
  assert.equal(audio.isPlaying, true);
  await audio.play({ notes: score, bpm: 120, noteOffset: -10, fromBeat: 100 });
  close(audio.getPosition(), -12);
  assert.equal(audio.isPlaying, false);
});

test('a shorter backing clip does not trim a later note clip and timeline inspection follows load/remove', async t => {
  const audio = makeAudio(t);
  assert.equal(audio.getBackgroundBuffer(), null);
  assert.equal(audio.getInstrumentData(), null);
  const before = audio.getTimeline({ notes: score, bpm: 120, noteOffset: 3, backgroundOffset: -100 });
  assert.equal(before.startSeconds, 0);
  assert.equal(before.endSeconds, 7);
  await addBackground(audio);
  assert.ok(audio.getBackgroundBuffer());
  const loaded = audio.getTimeline({ notes: score, bpm: 120, noteOffset: 3, backgroundOffset: -59 });
  assert.equal(loaded.startSeconds, -59);
  assert.equal(loaded.endSeconds, 7);
  await audio.play({ notes: score, bpm: 120, noteOffset: 3, backgroundOffset: -59 });
  const background = [...audio._voices].find(voice => voice.type === 'background');
  close(background.source.offset, 59);
  close(background.source.stops[0], 1.035);
  audio._context.currentTime = 2;
  audio._tick();
  assert.equal(audio.isPlaying, true);
  audio.pause();
  audio.clearBackground();
  assert.equal(audio.getBackgroundBuffer(), null);
  assert.equal(audio.getTimeline({ notes: score, bpm: 120, noteOffset: 3, backgroundOffset: -59 }).startSeconds, 0);
});

test('6/8 metronome pulses use eighth notes while tempo remains quarter-note BPM', async t => {
  const audio = makeAudio(t);
  audio.setTimeSignature(6, 8);
  audio.setMetronome(true);
  await audio.play({ notes: score, bpm: 120 });
  audio._context.currentTime = 0.1;
  audio._tick();
  const clicks = [...audio._voices].filter(voice => voice.type === 'click').map(voice => voice.source);
  assert.equal(clicks.length, 2);
  close(clicks[0].startTime, 0.035);
  close(clicks[1].startTime, 0.285);
  assert.ok(clicks[0].frequency.events[0].value > clicks[1].frequency.events[0].value, 'the first beat has a higher accent');
});

test('metronome transients have enough energy to remain distinct from the default sampled sound', async t => {
  const audio = makeAudio(t);
  audio.setMetronome(true);
  await audio.play({ notes: score, bpm: 120 });
  audio._context.currentTime = 0.4;
  audio._tick();
  const clicks = [...audio._voices].filter(voice => voice.type === 'click');
  assert.equal(clicks.length, 2);
  const energyOverWindow = voice => {
    const [initial, peak, decay] = voice.gain.gain.events;
    const attackEnergy = peak.value ** 2 * (peak.time - initial.time) / 3;
    const decayEnergy = (peak.value ** 2 - decay.value ** 2) * (decay.time - peak.time)
      / (2 * Math.log(peak.value / decay.value));
    const tailEnergy = decay.value ** 2 * Math.max(0, voice.source.stops[0] - decay.time);
    const waveformPower = { square: 1, triangle: 1 / 3, sine: 1 / 2 }[voice.source.type];
    assert.ok(waveformPower, 'the transient has a known waveform power');
    assert.ok(voice.source.stops[0] - voice.source.startTime <= 0.08, 'the click remains a short transient');
    return Math.sqrt((attackEnergy + decayEnergy + tailEnergy) * waveformPower / 0.08)
      * audio._clickGain.gain.value;
  };
  const accentRms = energyOverWindow(clicks[0]);
  const regularRms = energyOverWindow(clicks[1]);
  // Browser-rendered FluidR3 C5 RMS over 80 ms at the default 70% Notes volume.
  // The former click was about 29 dB below it; keep enough margin for masking
  // without making the regular click dominate the harmonica.
  const defaultNoteRms = 0.1048;
  const relativeDb = 20 * Math.log10(regularRms / defaultNoteRms);
  assert.ok(relativeDb >= -16 && relativeDb <= -5, `regular click balance: ${relativeDb.toFixed(1)} dB`);
  assert.ok(accentRms > regularRms, 'the bar accent is stronger than the other pulses');
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
    assert.equal(audio._clickGain.gain.events.at(-1).value, noteMuted ? 0 : 0.65 * 0.7);
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
  assert.equal(audio._clickGain.gain.events.at(-1).value, 0.65 * 0.45);
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

test('Notes volume scales both notes and metronome, with zero silent before startup and during playback', async t => {
  const audio = makeAudio(t);
  audio.setNoteVolume(0);
  audio.setMetronome(true);
  assert.equal(audio._context, null);
  await addBackground(audio);
  await audio.play({ notes: score, bpm: 120 });
  const context = audio._context;
  assert.equal(audio._noteGain.gain.value, 0);
  assert.equal(audio._clickGain.gain.value, 0);
  assert.equal(audio._backgroundGain.gain.value, 0.65);
  const sources = [...context.nodes];
  const stops = sources.map(source => [...source.stops]);
  const startTime = audio._startTime;
  const endTime = audio._endTime;
  context.currentTime = 0.535;
  for (const volume of [0.3, 0.8, 0]) {
    audio.setNoteVolume(volume);
    assert.equal(audio._noteGain.gain.events.at(-1).value, volume);
    assert.equal(audio._clickGain.gain.events.at(-1).value, 0.65 * volume);
    assert.equal(audio._backgroundGain.gain.events.length, 0);
    assert.equal(audio.isPlaying, true);
    assert.equal(audio.metronomeEnabled, true);
    assert.equal(audio._startTime, startTime);
    assert.equal(audio._endTime, endTime);
    close(audio.getPosition(), 1);
    assert.deepEqual(context.nodes, sources);
    assert.deepEqual(sources.map(source => source.stops), stops);
  }
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

test('enabling the metronome during sampled playback schedules the next beat and disabling stops only clicks', async t => {
  mockSamples(t);
  const audio = makeAudio(t);
  await audio.setInstrument('fluid');
  await addBackground(audio);
  await audio.play({ notes: score, bpm: 120 });
  const context = audio._context;
  const note = [...audio._voices].find(voice => voice.type === 'note');
  const background = [...audio._voices].find(voice => voice.type === 'background');
  const noteStops = [...note.source.stops];
  const backgroundStops = [...background.source.stops];
  const startTime = audio._startTime;
  const endTime = audio._endTime;
  assert.equal(note.source.kind, 'buffer');
  context.currentTime = 0.1;
  audio.setMetronome(true);
  assert.equal([...audio._voices].filter(voice => voice.type === 'click').length, 0);
  context.currentTime = 0.4;
  audio._tick();
  const click = [...audio._voices].find(voice => voice.type === 'click');
  assert.ok(click, 'the next score beat has a click scheduled');
  close(click.source.startTime, 0.535);
  assert.equal(click.source.connections[0], click.gain);
  assert.equal(click.gain.connections[0], audio._clickGain);
  assert.equal(audio._clickGain.connections[0], context.destination);

  audio.setMetronome(false);
  assert.equal(click.source.stops.at(-1), context.currentTime);
  assert.equal(click.source.disconnected, true);
  assert.equal([...audio._voices].filter(voice => voice.type === 'click').length, 0);
  assert.deepEqual(note.source.stops, noteStops);
  assert.deepEqual(background.source.stops, backgroundStops);
  assert.equal(note.source.disconnected, undefined);
  assert.equal(background.source.disconnected, undefined);
  assert.equal(audio.isPlaying, true);
  assert.equal(audio._startTime, startTime);
  assert.equal(audio._endTime, endTime);
});

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
