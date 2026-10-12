import { nearestSample } from './instrument.js';

const MAX_COLUMNS = 1500;
const PCM_PROFILE_COLUMNS = 4096;
const profileCache = new WeakMap();
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function timelineRange(timeline = {}) {
  const start = finite(timeline.startSeconds);
  const end = Math.max(start, finite(timeline.endSeconds, start));
  return { start, end, duration: end - start };
}

export function timeToRatio(seconds, timeline) {
  const { start, duration } = timelineRange(timeline);
  return duration ? clamp((finite(seconds, start) - start) / duration, 0, 1) : 0;
}

export function ratioToTime(ratio, timeline) {
  const { start, duration } = timelineRange(timeline);
  return start + clamp(finite(ratio), 0, 1) * duration;
}

/** Scan all PCM channels once; do not average channels, which could hide opposite-phase audio. */
export function buildAudioPeaks(buffer, columns = MAX_COLUMNS) {
  const length = Math.max(0, Math.floor(finite(buffer?.length)));
  const count = Math.max(1, Math.min(PCM_PROFILE_COLUMNS, Math.floor(finite(columns, MAX_COLUMNS))));
  const mins = new Float32Array(count);
  const maxs = new Float32Array(count);
  const duration = Math.max(0, finite(buffer?.duration));
  if (!length || !duration || !buffer.numberOfChannels) return { mins, maxs, duration };
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const pcm = buffer.getChannelData(channel);
    for (let bin = 0; bin < count; bin += 1) {
      const start = Math.floor(bin * length / count);
      const end = Math.min(length, Math.max(start + 1, Math.floor((bin + 1) * length / count)));
      let min = channel ? mins[bin] : Infinity, max = channel ? maxs[bin] : -Infinity;
      for (let frame = start; frame < end; frame += 1) {
        const value = pcm[frame];
        if (value < min) min = value;
        if (value > max) max = value;
      }
      mins[bin] = min;
      maxs[bin] = max;
    }
  }
  return { mins, maxs, duration };
}

function cachedAudioPeaks(buffer) {
  if (!buffer) return null;
  if (!profileCache.has(buffer)) profileCache.set(buffer, buildAudioPeaks(buffer, PCM_PROFILE_COLUMNS));
  return profileCache.get(buffer);
}

function peakRange(profile, from, to) {
  if (!profile?.duration || to <= 0 || from >= profile.duration || to <= from) return [0, 0];
  const count = profile.mins.length;
  const first = clamp(Math.floor(Math.max(0, from) / profile.duration * count), 0, count - 1);
  const last = clamp(Math.ceil(Math.min(profile.duration, to) / profile.duration * count), first + 1, count);
  let min = from < 0 || to > profile.duration ? 0 : Infinity;
  let max = from < 0 || to > profile.duration ? 0 : -Infinity;
  for (let i = first; i < last; i += 1) {
    min = Math.min(min, profile.mins[i]);
    max = Math.max(max, profile.maxs[i]);
  }
  return [min, max];
}

/** Place a PCM peak profile on the shared time axis, retaining silence outside the clip. */
export function alignAudioPeaks(profile, timeline, offset = 0, columns = MAX_COLUMNS) {
  const count = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(finite(columns, MAX_COLUMNS))));
  const mins = new Float32Array(count), maxs = new Float32Array(count);
  const { start, duration } = timelineRange(timeline);
  if (duration && profile) {
    for (let i = 0; i < count; i += 1) {
      const [min, max] = peakRange(profile, start + i * duration / count - offset, start + (i + 1) * duration / count - offset);
      mins[i] = min;
      maxs[i] = max;
    }
  }
  return { mins, maxs };
}

function noteEnvelope(at, duration) {
  const attack = Math.min(0.014, duration / 3);
  const release = Math.min(0.045, duration / 3);
  return clamp(Math.min(at / attack, (duration - at) / release), 0, 1);
}

function maximumEnvelope(from, to, duration) {
  const attack = Math.min(0.014, duration / 3);
  const release = Math.min(0.045, duration / 3);
  if (from <= duration - release && to >= attack) return 1;
  return Math.max(noteEnvelope(from, duration), noteEnvelope(to, duration));
}

function sampledNoteRange(profile, sample, midi, from, to) {
  const rate = 2 ** ((midi - sample.midi) / 12);
  let sourceStart = sample.start + from * rate;
  const sourceEnd = sample.start + to * rate;
  let min = 0, max = 0;
  const add = (start, end) => {
    const range = peakRange(profile, start, end);
    min = Math.min(min, range[0]);
    max = Math.max(max, range[1]);
  };
  if (sourceStart < sample.loopEnd) add(sourceStart, Math.min(sourceEnd, sample.loopEnd));
  sourceStart = Math.max(sourceStart, sample.loopEnd);
  const loopLength = sample.loopEnd - sample.loopStart;
  if (sourceEnd > sourceStart && loopLength > 0) {
    const length = sourceEnd - sourceStart;
    if (length >= loopLength) add(sample.loopStart, sample.loopEnd);
    else {
      const start = sample.loopStart + (sourceStart - sample.loopEnd) % loopLength;
      add(start, Math.min(start + length, sample.loopEnd));
      if (start + length > sample.loopEnd) add(sample.loopStart, sample.loopStart + length - (sample.loopEnd - start));
    }
  }
  return [min * 0.8, max * 0.8];
}

/**
 * Peak-envelope preview of the scheduled notes, excluding the optional metronome.
 * Sampled notes use real PCM peaks, pitch-adjusted offsets and sustain loops.
 * Synth notes use the normalized reed oscillator's +/-1 peak and its 0.18 gain.
 * This is an overview at display resolution, not a sample-accurate audio export.
 */
export function buildNotePeaks({ timeline, notes = [], bpm = 60, instrument = 'synth', instrumentData = null }, columns = MAX_COLUMNS) {
  const count = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(finite(columns, MAX_COLUMNS))));
  const mins = new Float32Array(count), maxs = new Float32Array(count);
  const { start, end, duration } = timelineRange(timeline);
  const secondsPerBeat = 60 / Math.max(1, finite(bpm, 60));
  const offset = finite(timeline?.noteStartSeconds);
  const profile = instrument === 'synth' ? null : cachedAudioPeaks(instrumentData?.buffer);
  if (!duration || (instrument !== 'synth' && !profile)) return { mins, maxs };
  for (const note of notes) {
    if (note.isRest || !Number.isFinite(note.midi)) continue;
    const noteStart = offset + finite(note.startBeat) * secondsPerBeat;
    const noteEnd = offset + finite(note.endBeat) * secondsPerBeat;
    if (noteEnd <= noteStart || noteEnd <= start || noteStart >= end) continue;
    const first = clamp(Math.floor((noteStart - start) / duration * count), 0, count - 1);
    const last = clamp(Math.ceil((noteEnd - start) / duration * count), first + 1, count);
    const sample = profile && nearestSample(instrumentData, note.midi);
    for (let i = first; i < last; i += 1) {
      const from = Math.max(0, start + i * duration / count - noteStart);
      const to = Math.min(noteEnd - noteStart, start + (i + 1) * duration / count - noteStart);
      if (to <= from) continue;
      const envelope = maximumEnvelope(from, to, noteEnd - noteStart);
      const [min, max] = sample ? sampledNoteRange(profile, sample, note.midi, from, to) : [-0.18, 0.18];
      mins[i] = Math.min(mins[i], min * envelope);
      maxs[i] = Math.max(maxs[i], max * envelope);
    }
  }
  return { mins, maxs };
}

export function formatTimelineTime(seconds, decimals = false) {
  const raw = Math.abs(finite(seconds));
  const value = decimals ? Math.round(raw * 10) / 10 : raw;
  const minutes = Math.floor(value / 60);
  const rest = decimals ? (value % 60).toFixed(1).padStart(4, '0') : String(Math.floor(value % 60)).padStart(2, '0');
  return `${seconds < 0 ? '-' : ''}${minutes}:${rest}`;
}

function rulerTicks(timeline, width) {
  const { start, end, duration } = timelineRange(timeline);
  if (!duration) return [{ time: start, label: formatTimelineTime(start) }];
  const desired = duration / Math.max(1, width / 85);
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const step = steps.find(value => value >= desired) || 3600 * Math.ceil(desired / 3600);
  const ticks = [];
  for (let i = Math.ceil(start / step); i * step <= end && ticks.length < 100; i += 1) {
    const time = i * step;
    ticks.push({ time, label: formatTimelineTime(time, step < 1) });
  }
  return ticks;
}

/** Two aligned waveform lanes with a shared seconds ruler and seek position. */
export class WaveformTimeline {
  constructor(root, { onSeek } = {}) {
    this.root = root;
    this.onSeek = onSeek;
    this.data = { timeline: { startSeconds: 0, endSeconds: 0 }, notes: [], bpm: 60, instrument: 'synth' };
    this.position = 0;
    this.dragging = null;
    this.destroyed = false;
    this.lanes = [
      ['ruler', '#waveform-ruler', 'Seek playback time'],
      ['track', '#track-waveform', 'Seek in backing track waveform'],
      ['notes', '#notes-waveform', 'Seek in notes waveform'],
    ].map(([kind, selector, label]) => {
      const canvas = root.querySelector(selector);
      if (!canvas) throw new Error(`Missing waveform canvas: ${selector}`);
      canvas.setAttribute('role', 'slider');
      canvas.setAttribute('aria-label', label);
      canvas.setAttribute('aria-orientation', 'horizontal');
      canvas.tabIndex = 0;
      canvas.style.touchAction = 'none';
      const cache = root.ownerDocument.createElement('canvas');
      return { kind, canvas, cache, context: canvas.getContext('2d'), cacheContext: cache.getContext('2d'), listeners: [] };
    });
    const listen = (lane, type, handler) => {
      lane.canvas.addEventListener(type, handler);
      lane.listeners.push([type, handler]);
    };
    for (const lane of this.lanes) {
      const seekEvent = event => {
        const rect = lane.canvas.getBoundingClientRect();
        this.seek(ratioToTime((event.clientX - rect.left) / Math.max(1, rect.width), this.data.timeline));
      };
      listen(lane, 'pointerdown', event => {
        if (event.button !== 0 || this.dragging) return;
        event.preventDefault();
        lane.canvas.focus({ preventScroll: true });
        this.dragging = { lane, id: event.pointerId };
        lane.canvas.setPointerCapture(event.pointerId);
        seekEvent(event);
      });
      listen(lane, 'pointermove', event => {
        if (this.dragging?.lane === lane && this.dragging.id === event.pointerId) seekEvent(event);
      });
      const finish = event => {
        if (this.dragging?.lane !== lane || this.dragging.id !== event.pointerId) return;
        this.dragging = null;
        if (lane.canvas.hasPointerCapture(event.pointerId)) lane.canvas.releasePointerCapture(event.pointerId);
      };
      listen(lane, 'pointerup', finish);
      listen(lane, 'pointercancel', finish);
      listen(lane, 'lostpointercapture', finish);
      listen(lane, 'keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const { start, end } = timelineRange(this.data.timeline);
        const step = event.shiftKey ? 5 : 1;
        const target = { ArrowLeft: this.position - step, ArrowRight: this.position + step, Home: start, End: end }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        this.seek(clamp(target, start, end));
      });
    }
    this.handleResize = () => this.rebuild();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.handleResize);
      for (const lane of this.lanes) this.observer.observe(lane.canvas);
    }
    this.rebuild();
  }

  setData(data) {
    this.data = { ...this.data, ...data };
    this.rebuild();
  }

  setPosition(seconds) {
    this.position = finite(seconds);
    this.renderPosition();
  }

  seek(seconds) {
    this.setPosition(seconds);
    this.onSeek?.(seconds);
  }

  rebuild() {
    if (this.destroyed) return;
    const { start, end } = timelineRange(this.data.timeline);
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 3);
    const backgroundProfile = cachedAudioPeaks(this.data.backgroundBuffer);
    for (const lane of this.lanes) {
      const rect = lane.canvas.getBoundingClientRect();
      lane.width = Math.max(1, rect.width);
      lane.height = Math.max(1, rect.height);
      const width = Math.max(1, Math.round(lane.width * ratio));
      const height = Math.max(1, Math.round(lane.height * ratio));
      lane.canvas.width = lane.cache.width = width;
      lane.canvas.height = lane.cache.height = height;
      lane.ratio = ratio;
      lane.canvas.setAttribute('aria-valuemin', String(start));
      lane.canvas.setAttribute('aria-valuemax', String(end));
      const ctx = lane.cacheContext;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, lane.width, lane.height);
      ctx.fillStyle = lane.kind === 'ruler' ? '#f4f5ec' : lane.kind === 'track' ? '#f4f7f6' : '#f7f8ef';
      ctx.fillRect(0, 0, lane.width, lane.height);
      const ticks = rulerTicks(this.data.timeline, lane.width);
      for (const tick of ticks) {
        const x = Math.round(timeToRatio(tick.time, this.data.timeline) * (lane.width - 1)) + 0.5;
        ctx.strokeStyle = tick.time === 0 ? '#c3cbb9' : '#e1e6dc';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, lane.kind === 'ruler' ? lane.height - 6 : 0); ctx.lineTo(x, lane.height); ctx.stroke();
        if (lane.kind === 'ruler') {
          ctx.fillStyle = '#78826f';
          ctx.font = '10px system-ui, sans-serif';
          ctx.textAlign = x < 30 ? 'left' : x > lane.width - 30 ? 'right' : 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(tick.label, clamp(x, 3, lane.width - 3), 3);
        }
      }
      if (lane.kind !== 'ruler') {
        const count = Math.min(MAX_COLUMNS, Math.max(1, Math.ceil(lane.width)));
        const peaks = lane.kind === 'track'
          ? alignAudioPeaks(backgroundProfile, this.data.timeline, finite(this.data.timeline?.backgroundStartSeconds), count)
          : buildNotePeaks(this.data, count);
        this.drawPeaks(lane, peaks);
      }
    }
    this.renderPosition();
  }

  drawPeaks(lane, peaks) {
    const ctx = lane.cacheContext;
    const center = lane.height / 2;
    let peak = 0;
    for (let i = 0; i < peaks.mins.length; i += 1) peak = Math.max(peak, -peaks.mins[i], peaks.maxs[i]);
    const volume = clamp(finite(lane.kind === 'track' ? this.data.backgroundVolume : this.data.noteVolume, 1), 0, 1);
    const gain = peak ? Math.max(0, center - 8) * volume / peak : 0;
    ctx.strokeStyle = '#d2d9cd';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, center + 0.5); ctx.lineTo(lane.width, center + 0.5); ctx.stroke();
    ctx.fillStyle = lane.kind === 'track' ? '#7594a0' : '#789f68';
    ctx.beginPath(); ctx.moveTo(0, center);
    for (let i = 0; i < peaks.maxs.length; i += 1) ctx.lineTo((i + 0.5) * lane.width / peaks.maxs.length, center - peaks.maxs[i] * gain);
    ctx.lineTo(lane.width, center);
    for (let i = peaks.mins.length - 1; i >= 0; i -= 1) ctx.lineTo((i + 0.5) * lane.width / peaks.mins.length, center - peaks.mins[i] * gain);
    ctx.closePath(); ctx.fill();
  }

  renderPosition() {
    if (this.destroyed) return;
    const ratio = timeToRatio(this.position, this.data.timeline);
    const { start, end } = timelineRange(this.data.timeline);
    for (const lane of this.lanes) {
      const ctx = lane.context;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, lane.canvas.width, lane.canvas.height);
      ctx.drawImage(lane.cache, 0, 0);
      ctx.setTransform(lane.ratio, 0, 0, lane.ratio, 0, 0);
      const x = Math.round(ratio * (lane.width - 1)) + 0.5;
      ctx.strokeStyle = '#b3664d'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, lane.height); ctx.stroke();
      if (lane.kind === 'ruler') {
        ctx.fillStyle = '#b3664d';
        ctx.beginPath(); ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 5); ctx.closePath(); ctx.fill();
      }
      lane.canvas.setAttribute('aria-valuenow', String(Math.round(clamp(this.position, start, end) * 100) / 100));
      lane.canvas.setAttribute('aria-valuetext', `${formatTimelineTime(this.position, true)} of ${formatTimelineTime(end, true)}`);
    }
  }

  destroy() {
    this.destroyed = true;
    this.observer?.disconnect();
    for (const lane of this.lanes) for (const [type, handler] of lane.listeners) lane.canvas.removeEventListener(type, handler);
  }
}
