import { isInstrument, loadInstrument, nearestSample } from './instrument.js';
import { createTimeline } from './timeline.js';

const LOOKAHEAD_SECONDS = 0.2;
const SCHEDULER_INTERVAL_MS = 25;
const START_DELAY_SECONDS = 0.035;
const NOTE_GAIN = 0.18;
const MANUAL_ATTACK_SECONDS = 0.014;
const MANUAL_RELEASE_SECONDS = 0.045;

function clampVolume(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

/** Browser-only score and backing-track playback, measured in quarter-note beats. */
export class PracticeAudio {
  constructor({ onStateChange, onEnded } = {}) {
    this.onStateChange = onStateChange;
    this.onEnded = onEnded;
    this.isPlaying = false;
    this.background = null;
    this.noteVolume = 0.7;
    this.backgroundVolume = 0.65;
    this.noteMuted = false;
    this.backgroundMuted = false;
    this.metronomeEnabled = false;
    this.numerator = 4;
    this.denominator = 4;
    this._context = null;
    this._voices = new Set();
    this._generation = 0;
    this._manualGeneration = 0;
    this._manualVoice = null;
    this._backgroundLoadId = 0;
    this._position = 0;
    this._totalBeats = 0;
    this._notes = [];
    this._bpm = 100;
    this._timer = null;
    this._endTimer = null;
    this.instrument = 'synth';
    this._instrumentLoadId = 0;
    this._instrumentData = null;
    this._instrumentError = false;
    this._instrumentReady = Promise.resolve(null);
    this._timeline = createTimeline();
  }

  getTimeline(options = {}) {
    return createTimeline({ ...options, backgroundDuration: this._backgroundBuffer?.duration || 0 });
  }

  /** Decoded audio is shared for waveform inspection; callers must not modify it. */
  getBackgroundBuffer() { return this._backgroundBuffer || null; }

  getInstrumentData() { return this._instrumentData; }

  /** Select a sound. A superseded request returns false and cannot replace the current sound. */
  async setInstrument(id) {
    return this._loadSelectedInstrument(id, true);
  }

  async _loadSelectedInstrument(id, stopManual) {
    if (!isInstrument(id)) throw new Error('Choose a supported harmonica sound.');
    const loadId = ++this._instrumentLoadId;
    this.instrument = id;
    if (stopManual) this.stopManualNote();
    this._instrumentData = null;
    this._instrumentError = false;
    const pending = id === 'synth' ? Promise.resolve(null)
      : Promise.resolve().then(() => loadInstrument(this._ensureContext(), id));
    this._instrumentReady = pending;
    try {
      const data = await pending;
      if (loadId !== this._instrumentLoadId) return false;
      this._instrumentData = data;
      return true;
    } catch (error) {
      if (loadId !== this._instrumentLoadId) return false;
      this._instrumentError = true;
      throw error;
    }
  }

  async prepareInstrument() {
    // A new selection can arrive while the preceding files are being decoded.
    while (true) {
      if (this._instrumentError) await this._loadSelectedInstrument(this.instrument, false);
      const loadId = this._instrumentLoadId;
      try {
        await this._instrumentReady;
      } catch (error) {
        if (loadId === this._instrumentLoadId) throw error;
      }
      if (loadId === this._instrumentLoadId) return;
    }
  }

  _ensureContext() {
    if (this._context) return this._context;
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error('This browser does not support Web Audio.');
    const context = new AudioContextClass();
    this._context = context;
    this._noteGain = context.createGain();
    this._backgroundGain = context.createGain();
    this._clickGain = context.createGain();
    this._noteGain.gain.value = this.noteMuted ? 0 : this.noteVolume;
    this._backgroundGain.gain.value = this.backgroundMuted ? 0 : this.backgroundVolume;
    this._clickGain.gain.value = this.noteMuted ? 0 : 0.65 * this.noteVolume;
    this._noteGain.connect(context.destination);
    this._backgroundGain.connect(context.destination);
    this._clickGain.connect(context.destination);
    // A soft reed tone: stronger odd and even harmonics than a plain sine wave.
    const real = new Float32Array(9);
    const imaginary = new Float32Array([0, 1, 0.42, 0.26, 0.15, 0.09, 0.05, 0.025, 0.01]);
    this._reedWave = context.createPeriodicWave(real, imaginary);
    return context;
  }

  async play({ notes = [], bpm, fromBeat = 0, noteOffset = 0, backgroundOffset = 0, includeLeadIn = false }) {
    this._cancelPlayback();
    const generation = this._generation;
    this._notes = [...(notes || [])].sort((a, b) => a.startBeat - b.startBeat);
    this._bpm = Number(bpm);
    if (!Number.isFinite(this._bpm) || this._bpm <= 0) {
      this._notifyState();
      throw new Error('Tempo must be greater than zero.');
    }
    this._timeline = this.getTimeline({ notes: this._notes, bpm: this._bpm, noteOffset, backgroundOffset });
    this._totalBeats = this._timeline.endBeat;
    this._backgroundOffset = this._timeline.backgroundStartSeconds;
    const requestedBeat = Number.isFinite(Number(fromBeat)) ? Number(fromBeat) : 0;
    this._position = Math.min(this._totalBeats, Math.max(this._timeline.startBeat, requestedBeat));
    if (includeLeadIn && requestedBeat === 0) this._position = this._timeline.startBeat;
    if (this._timeline.durationBeats <= 0 || this._position >= this._totalBeats) {
      this._notifyState();
      return;
    }

    const context = this._ensureContext();
    await Promise.all([context.resume(), this._timeline.hasNotes ? this.prepareInstrument() : Promise.resolve()]);
    // A pause, stop, or newer play request may arrive while the browser resumes audio.
    if (generation !== this._generation) return;
    this._startBeat = this._position;
    this._startTime = context.currentTime + START_DELAY_SECONDS;
    this._endTime = this._timeAtBeat(this._totalBeats);
    this._noteEndTime = this._timeAtBeat(this._timeline.noteEndBeat);
    this._nextNoteIndex = this._notes.findIndex(note => note.endBeat + this._timeline.noteStartBeat > this._startBeat);
    if (this._nextNoteIndex < 0) this._nextNoteIndex = this._notes.length;
    this._resetClickCursor(this._startBeat);
    this.isPlaying = true;
    this._scheduleBackground();
    this._tick();
    this._timer = setInterval(() => this._tick(), SCHEDULER_INTERVAL_MS);
    this._endTimer = setTimeout(() => this._tick(), Math.max(0, (this._endTime - context.currentTime) * 1000 + 10));
    this._notifyState();
  }

  getPosition() {
    if (!this.isPlaying || !this._context) return this._position;
    const elapsed = Math.max(0, this._context.currentTime - this._startTime);
    return Math.min(this._totalBeats, this._startBeat + elapsed * this._bpm / 60);
  }

  pause() {
    this._position = this.getPosition();
    this._cancelPlayback();
    this._notifyState();
    return this._position;
  }

  stop() {
    this._cancelPlayback();
    this._position = this._timeline.startBeat;
    this._notifyState();
  }

  /** Hold a reed tone until stopped or replaced, without moving the score. */
  async startManualNote(midi) {
    if (!Number.isFinite(midi) || midi < 0 || midi > 127) {
      throw new RangeError('Choose a MIDI note from 0 to 127.');
    }
    this.stopManualNote();
    const generation = this._manualGeneration;
    const context = this._ensureContext();
    await Promise.all([context.resume(), this.prepareInstrument()]);
    if (generation !== this._manualGeneration) return false;

    const start = context.currentTime + 0.002;
    const { source, level, offset } = this._createNoteSource(midi, start);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + MANUAL_ATTACK_SECONDS);
    source.connect(gain);
    gain.connect(this._noteGain);
    const voice = this._trackVoice(source, gain, 'manual');
    voice.startedAt = start;
    voice.level = level;
    this._manualVoice = voice;
    source.start(start, offset);
    return true;
  }

  /** Release the held tone and invalidate any start waiting for audio access. */
  stopManualNote() {
    this._manualGeneration += 1;
    const voice = this._manualVoice;
    this._manualVoice = null;
    if (voice) this._releaseManualVoice(voice);
  }

  async setBackground(file) {
    const loadId = ++this._backgroundLoadId;
    const context = this._ensureContext();
    const bytes = await file.arrayBuffer();
    const buffer = await context.decodeAudioData(bytes);
    if (loadId !== this._backgroundLoadId) return this.background;
    this._backgroundBuffer = buffer;
    this.background = { name: file.name || 'Backing track', duration: buffer.duration };
    this._cancelVoices('background');
    if (this.isPlaying) this._scheduleBackground();
    return this.background;
  }

  clearBackground() {
    this._backgroundLoadId += 1;
    this._cancelVoices('background');
    this._backgroundBuffer = null;
    this.background = null;
  }

  setNoteVolume(value) {
    this.noteVolume = clampVolume(value);
    this._setGain(this._noteGain, this.noteMuted ? 0 : this.noteVolume);
    this._setGain(this._clickGain, this.noteMuted ? 0 : 0.65 * this.noteVolume);
  }

  setBackgroundVolume(value) {
    this.backgroundVolume = clampVolume(value);
    this._setGain(this._backgroundGain, this.backgroundMuted ? 0 : this.backgroundVolume);
  }

  setNoteMuted(muted) {
    this.noteMuted = Boolean(muted);
    this._setGain(this._noteGain, this.noteMuted ? 0 : this.noteVolume);
    this._setGain(this._clickGain, this.noteMuted ? 0 : 0.65 * this.noteVolume);
  }

  setBackgroundMuted(muted) {
    this.backgroundMuted = Boolean(muted);
    this._setGain(this._backgroundGain, this.backgroundMuted ? 0 : this.backgroundVolume);
  }

  setMetronome(enabled) {
    this.metronomeEnabled = Boolean(enabled);
    this._cancelVoices('click');
    if (this.isPlaying) {
      this._resetClickCursor(this.getPosition() + 0.001);
      this._tick();
    }
  }

  setTimeSignature(numerator, denominator) {
    const top = Number(numerator);
    const bottom = Number(denominator);
    if (!Number.isInteger(top) || top < 1 || top > 32 || ![1, 2, 4, 8, 16, 32].includes(bottom)) {
      throw new Error('Enter a valid time signature, such as 4/4 or 6/8.');
    }
    this.numerator = top;
    this.denominator = bottom;
    this._cancelVoices('click');
    if (this.isPlaying) this._resetClickCursor(this.getPosition() + 0.001);
  }

  _notifyState() {
    this.onStateChange?.({ isPlaying: this.isPlaying, beat: this.getPosition() });
  }

  _setGain(node, value) {
    if (node && this._context) node.gain.setTargetAtTime(value, this._context.currentTime, 0.015);
  }

  _timeAtBeat(beat) {
    return this._startTime + (beat - this._startBeat) * 60 / this._bpm;
  }

  _resetClickCursor(position) {
    const pulse = 4 / this.denominator;
    const scorePosition = position - this._timeline.noteStartBeat;
    this._nextClickBeat = Math.ceil(Math.max(0, scorePosition) / pulse - 1e-9) * pulse;
  }

  _tick() {
    if (!this.isPlaying) return;
    const now = this._context.currentTime;
    if (now >= this._endTime) {
      this._position = this._totalBeats;
      this._cancelPlayback();
      this._notifyState();
      this.onEnded?.();
      return;
    }
    const horizon = now + LOOKAHEAD_SECONDS;
    while (this._nextNoteIndex < this._notes.length) {
      const note = this._notes[this._nextNoteIndex];
      const start = this._timeAtBeat(Math.max(note.startBeat + this._timeline.noteStartBeat, this._startBeat));
      if (start > horizon) break;
      this._nextNoteIndex += 1;
      const end = this._timeAtBeat(note.endBeat + this._timeline.noteStartBeat);
      if (!note.isRest && Number.isFinite(note.midi) && end > now + 0.004) {
        this._scheduleNote(note.midi, Math.max(start, now + 0.003), end);
      }
    }
    if (!this.metronomeEnabled || !this._timeline.hasNotes) return;
    const pulse = 4 / this.denominator;
    while (this._nextClickBeat < this._timeline.scoreBeats && this._timeAtBeat(this._timeline.noteStartBeat + this._nextClickBeat) <= horizon) {
      const clickTime = this._timeAtBeat(this._timeline.noteStartBeat + this._nextClickBeat);
      const pulseIndex = Math.round(this._nextClickBeat / pulse);
      // If the browser throttles timers, skip missed clicks instead of bunching them together.
      if (clickTime >= now - 0.01) this._scheduleClick(Math.max(clickTime, now + 0.002), pulseIndex % this.numerator === 0);
      this._nextClickBeat += pulse;
    }
  }

  _trackVoice(source, gain, type) {
    const voice = { source, gain, type };
    this._voices.add(voice);
    source.onended = () => {
      source.disconnect();
      gain?.disconnect();
      this._voices.delete(voice);
      if (this._manualVoice === voice) this._manualVoice = null;
    };
    return voice;
  }

  _scheduleNote(midi, start, end) {
    if (end <= start) return;
    const context = this._context;
    const { source, level, offset } = this._createNoteSource(midi, start);
    const gain = context.createGain();
    const duration = end - start;
    const attack = Math.min(0.014, duration / 3);
    const release = Math.min(0.045, duration / 3);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + attack);
    gain.gain.setValueAtTime(level, end - release);
    gain.gain.linearRampToValueAtTime(0, end);
    source.connect(gain);
    gain.connect(this._noteGain);
    this._trackVoice(source, gain, 'note');
    source.start(start, offset);
    source.stop(end + 0.005);
  }

  _createNoteSource(midi, start) {
    const context = this._context;
    if (this.instrument === 'synth') {
      const source = context.createOscillator();
      source.setPeriodicWave(this._reedWave);
      source.frequency.setValueAtTime(440 * 2 ** ((midi - 69) / 12), start);
      return { source, level: NOTE_GAIN, offset: 0 };
    }
    if (!this._instrumentData) throw new Error('The selected harmonica sound is still loading.');
    const sample = nearestSample(this._instrumentData, midi);
    const source = context.createBufferSource();
    source.buffer = this._instrumentData.buffer;
    source.playbackRate.setValueAtTime(2 ** ((midi - sample.midi) / 12), start);
    source.loop = true;
    source.loopStart = sample.loopStart;
    source.loopEnd = sample.loopEnd;
    return { source, level: 0.8, offset: sample.start };
  }

  _scheduleClick(start, accent) {
    const source = this._context.createOscillator();
    const gain = this._context.createGain();
    // A short, bright pulse stays distinct from the sampled harmonica's attack.
    source.type = 'square';
    source.frequency.setValueAtTime(accent ? 2000 : 1500, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(accent ? 0.28 : 0.20, start + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.065);
    source.connect(gain);
    gain.connect(this._clickGain);
    this._trackVoice(source, gain, 'click');
    source.start(start);
    source.stop(Math.min(start + 0.07, this._noteEndTime));
  }

  _scheduleBackground() {
    if (!this._backgroundBuffer) return;
    const context = this._context;
    const earliestTime = Math.max(this._startTime, context.currentTime);
    const desiredStart = this._timeAtBeat(this._backgroundOffset * this._bpm / 60);
    const start = Math.max(earliestTime, desiredStart);
    const bufferOffset = Math.max(0, start - desiredStart);
    if (bufferOffset >= this._backgroundBuffer.duration || start >= this._endTime) return;
    const source = context.createBufferSource();
    source.buffer = this._backgroundBuffer;
    source.connect(this._backgroundGain);
    this._trackVoice(source, null, 'background');
    source.start(start, bufferOffset);
    source.stop(Math.min(this._endTime, desiredStart + this._backgroundBuffer.duration));
  }

  _cancelVoices(type) {
    const now = this._context?.currentTime ?? 0;
    for (const voice of [...this._voices]) {
      if (type && voice.type !== type) continue;
      if (voice.type === 'manual') {
        this._releaseManualVoice(voice);
        continue;
      }
      // Stop future and currently sounding sources alike, including backing audio.
      try { voice.source.stop(now); } catch { /* A source may already have ended. */ }
      voice.source.disconnect();
      voice.gain?.disconnect();
      this._voices.delete(voice);
    }
  }

  _releaseManualVoice(voice) {
    if (voice.releasing) return;
    voice.releasing = true;
    const now = this._context.currentTime;
    // Account for release during the attack so quick taps do not jump in volume.
    const level = voice.level * Math.min(1, Math.max(0, (now - voice.startedAt) / MANUAL_ATTACK_SECONDS));
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(level, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + MANUAL_RELEASE_SECONDS);
    voice.source.stop(now + MANUAL_RELEASE_SECONDS + 0.005);
  }

  _cancelPlayback() {
    this._generation += 1;
    this.stopManualNote();
    this.isPlaying = false;
    clearInterval(this._timer);
    clearTimeout(this._endTimer);
    this._timer = null;
    this._endTimer = null;
    this._cancelVoices();
  }
}
