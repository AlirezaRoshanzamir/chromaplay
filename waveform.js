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

/** Keep a fixed-width viewport inside the nonnegative playback runtime. */
export function clampViewport(timeline, zoom = 1, startSeconds = 0) {
  const start = Math.max(0, finite(timeline?.startSeconds));
  const end = Math.max(start, finite(timeline?.endSeconds, start));
  const total = end - start;
  const factor = total ? clamp(finite(zoom, 1), 1, 32) : 1;
  const duration = total / factor;
  const left = clamp(finite(startSeconds, start), start, Math.max(start, end - duration));
  return { zoom: factor, startSeconds: left, endSeconds: left + duration, durationSeconds: duration };
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
export function buildNotePeaks({ timeline, notes = [], bpm = 60, timing = timeline?.timing, instrument = 'synth', instrumentData = null }, columns = MAX_COLUMNS) {
  const count = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(finite(columns, MAX_COLUMNS))));
  const mins = new Float32Array(count), maxs = new Float32Array(count);
  const { start, end, duration } = timelineRange(timeline);
  const secondsPerBeat = 60 / Math.max(1, finite(bpm, 60));
  const offset = finite(timeline?.noteStartSeconds);
  const profile = instrument === 'synth' ? null : cachedAudioPeaks(instrumentData?.buffer);
  if (!duration || (instrument !== 'synth' && !profile)) return { mins, maxs };
  for (const note of notes) {
    if (note.isRest || !Number.isFinite(note.midi)) continue;
    const noteStart = offset + (timing ? timing.beatToSeconds(finite(note.startBeat)) : finite(note.startBeat) * secondsPerBeat);
    const noteEnd = offset + (timing ? timing.beatToSeconds(finite(note.endBeat)) : finite(note.endBeat) * secondsPerBeat);
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

function clickEnvelope(time, peak) {
  if (time < 0 || time > 0.07) return 0;
  if (time < 0.002) return peak * time / 0.002;
  if (time < 0.065) return peak * (0.001 / peak) ** ((time - 0.002) / 0.063);
  return 0.001;
}

/** Constant pulse grids between tempo/meter markers, without expanding every click. */
function metronomeGrids(timing, bpm, numerator, denominator) {
  if (!timing) return [{ origin: 0, pulse: 60 / Math.max(1, finite(bpm, 60)) * 4 / Math.max(1, finite(denominator, 4)),
    meter: clamp(Math.round(finite(numerator, 4)), 1, 32), first: 0, last: Infinity }];
  const boundaries = [...new Set([...timing.tempoSegments, ...timing.meterSegments].map(segment => segment.beat))].sort((a, b) => a - b);
  let meterIndex = 0;
  return boundaries.map((beat, index) => {
    while (meterIndex + 1 < timing.meterSegments.length && timing.meterSegments[meterIndex + 1].beat <= beat) meterIndex += 1;
    const meter = timing.meterSegments[meterIndex];
    const { tempo } = timing.settingsAtBeat(beat);
    const secondsPerBeat = 60 / tempo;
    const pulseBeats = 4 / meter.denominator;
    return {
      origin: timing.beatToSeconds(beat) + (meter.beat - beat) * secondsPerBeat,
      pulse: pulseBeats * secondsPerBeat,
      meter: meter.numerator,
      first: Math.max(0, Math.ceil((beat - meter.beat) / pulseBeats - 1e-9)),
      last: index + 1 < boundaries.length ? Math.ceil((boundaries[index + 1] - meter.beat) / pulseBeats - 1e-9) - 1 : Infinity,
    };
  });
}

/** Peak envelope of the engine's 1500/2000 Hz square clicks, including its 0.65 bus gain. */
export function buildMetronomePeaks({ timeline, bpm = 60, timing = timeline?.timing, numerator = 4, denominator = 4, metronome = false }, columns = MAX_COLUMNS) {
  const count = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(finite(columns, MAX_COLUMNS))));
  const mins = new Float32Array(count), maxs = new Float32Array(count);
  const referencePeak = 0.28 * 0.65;
  const { start, duration } = timelineRange(timeline);
  const offset = finite(timeline?.metronomeStartSeconds);
  const end = finite(timeline?.metronomeEndSeconds, offset + finite(timeline?.metronomeDuration));
  if (!metronome || timeline?.hasMetronome === false || !duration || end <= Math.max(0, start, offset)) return { mins, maxs, referencePeak };
  for (const grid of metronomeGrids(timing, bpm, numerator, denominator)) {
    const { pulse, meter } = grid;
    const origin = offset + grid.origin;
    const firstScheduled = Math.max(grid.first, Math.ceil(-origin / pulse - 1e-9));
    const lastScheduled = Math.min(grid.last, Math.ceil((end - origin) / pulse - 1e-9) - 1);
    if (lastScheduled < firstScheduled) continue;
    const firstBin = clamp(Math.floor((origin + firstScheduled * pulse - start) / duration * count), 0, count - 1);
    const lastBin = clamp(Math.ceil((Math.min(end, origin + lastScheduled * pulse + 0.07) - start) / duration * count), 0, count);
    for (let bin = firstBin; bin < lastBin; bin += 1) {
      const left = Math.max(0, offset, start + bin * duration / count);
      const right = Math.min(end, start + (bin + 1) * duration / count);
      if (right <= left) continue;
      const first = Math.max(firstScheduled, Math.ceil((left - origin - 0.07) / pulse));
      const last = Math.min(lastScheduled, Math.ceil((right - origin) / pulse) - 1);
      if (last < first) continue;
      // Work is bounded by visible pixels and timing changes, even for very long scores.
      const firstPeak = Math.max(firstScheduled, Math.ceil((left - origin - 0.002) / pulse));
      const lastPeak = Math.min(last, Math.floor((right - origin - 0.002) / pulse));
      let amplitude = firstPeak <= lastPeak ? (Math.ceil(firstPeak / meter) * meter <= lastPeak ? 0.28 : 0.20) : 0;
      for (const index of new Set([first, first + 1, last])) {
        if (index > last) continue;
        const clickStart = origin + index * pulse;
        const from = Math.max(0, left - clickStart);
        const to = Math.min(0.07, right - clickStart);
        if (to <= from) continue;
        const peak = index % meter === 0 ? 0.28 : 0.20;
        amplitude = Math.max(amplitude, from <= 0.002 && to >= 0.002 ? peak : Math.max(clickEnvelope(from, peak), clickEnvelope(to, peak)));
      }
      mins[bin] = Math.min(mins[bin], -amplitude * 0.65);
      maxs[bin] = Math.max(maxs[bin], amplitude * 0.65);
    }
  }
  return { mins, maxs, referencePeak };
}

export function formatTimelineTime(seconds, decimals = false) {
  const precision = typeof decimals === 'number' ? clamp(Math.floor(decimals), 0, 3) : decimals ? 1 : 0;
  const raw = Math.abs(finite(seconds));
  const value = precision ? Math.round(raw * 10 ** precision) / 10 ** precision : raw;
  const minutes = Math.floor(value / 60);
  const rest = precision ? (value % 60).toFixed(precision).padStart(3 + precision, '0') : String(Math.floor(value % 60)).padStart(2, '0');
  return `${seconds < 0 ? '-' : ''}${minutes}:${rest}`;
}

function rulerTicks(timeline, width) {
  const { start, end, duration } = timelineRange(timeline);
  if (!duration) return [{ time: start, label: formatTimelineTime(start) }];
  const desired = duration / Math.max(1, width / 85);
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const step = steps.find(value => value >= desired) || 3600 * Math.ceil(desired / 3600);
  const ticks = [];
  for (let i = Math.ceil(start / step); i * step <= end && ticks.length < 100; i += 1) {
    const time = i * step;
    ticks.push({ time, label: formatTimelineTime(time, step < 1 ? Math.ceil(-Math.log10(step)) : 0) });
  }
  return ticks;
}

/** Three aligned waveform lanes with a shared, zoomable seconds ruler and seek position. */
export class WaveformTimeline {
  constructor(root, { onSeek } = {}) {
    this.root = root;
    this.onSeek = onSeek;
    this.data = { timeline: { startSeconds: 0, endSeconds: 0 }, notes: [], bpm: 60, instrument: 'synth' };
    this.position = 0;
    this.view = clampViewport(this.data.timeline);
    this.dragging = null;
    this.destroyed = false;
    this.lanes = [
      ['ruler', '#waveform-ruler', 'Seek playback time'],
      ['track', '#track-waveform', 'Seek in backing track waveform'],
      ['notes', '#notes-waveform', 'Seek in notes waveform'],
      ['metronome', '#metronome-waveform', 'Seek in metronome waveform'],
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
        this.seek(ratioToTime((event.clientX - rect.left) / Math.max(1, rect.width), this.view));
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
        const { start, end } = timelineRange({ ...this.data.timeline, startSeconds: Math.max(0, finite(this.data.timeline.startSeconds)) });
        const step = event.shiftKey ? 5 : 1;
        const target = { ArrowLeft: this.position - step, ArrowRight: this.position + step, Home: start, End: end }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        this.seek(clamp(target, start, end));
      });
    }
    this.controls = Object.fromEntries(['zoom-in', 'zoom-out', 'zoom-fit', 'zoom-value', 'pan', 'view-range']
      .map(name => [name, root.querySelector(`#waveform-${name}`)]));
    this.controlListeners = [];
    const bind = (name, event, callback) => {
      const control = this.controls[name];
      if (!control) return;
      control.addEventListener(event, callback);
      this.controlListeners.push([control, event, callback]);
    };
    bind('zoom-in', 'click', () => this.setZoom(this.view.zoom * 2));
    bind('zoom-out', 'click', () => this.setZoom(this.view.zoom / 2));
    bind('zoom-fit', 'click', () => this.setZoom(1));
    bind('pan', 'input', () => this.panTo(Number(this.controls.pan.value)));
    this.handleResize = () => this.rebuild();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.handleResize);
      for (const lane of this.lanes) this.observer.observe(lane.canvas);
    }
    this.rebuild();
  }

  setData(data) {
    this.data = { ...this.data, ...data };
    this.view = clampViewport(this.data.timeline, this.view.zoom, this.view.startSeconds);
    this.rebuild();
  }

  setPosition(seconds, { follow = false } = {}) {
    const full = clampViewport(this.data.timeline);
    this.position = clamp(finite(seconds), full.startSeconds, full.endSeconds);
    if (follow && this.view.zoom > 1 && (this.position < this.view.startSeconds || this.position > this.view.endSeconds)) {
      const left = this.position - this.view.durationSeconds * (this.position < this.view.startSeconds ? 0.9 : 0.1);
      this.view = clampViewport(this.data.timeline, this.view.zoom, left);
      this.rebuild();
      return;
    }
    this.renderPosition();
  }

  seek(seconds) {
    this.setPosition(seconds, { follow: true });
    this.onSeek?.(this.position);
  }

  setZoom(zoom) {
    const visible = this.position >= this.view.startSeconds && this.position <= this.view.endSeconds;
    const anchor = visible ? this.position : (this.view.startSeconds + this.view.endSeconds) / 2;
    const fraction = this.view.durationSeconds ? (anchor - this.view.startSeconds) / this.view.durationSeconds : 0.5;
    const next = clampViewport(this.data.timeline, zoom, this.view.startSeconds);
    this.view = clampViewport(this.data.timeline, next.zoom, anchor - next.durationSeconds * fraction);
    this.rebuild();
  }

  panTo(startSeconds) {
    this.view = clampViewport(this.data.timeline, this.view.zoom, startSeconds);
    this.rebuild();
  }

  updateControls() {
    const full = clampViewport(this.data.timeline);
    const { zoom, startSeconds, endSeconds, durationSeconds } = this.view;
    const controls = this.controls;
    if (controls['zoom-in']) controls['zoom-in'].disabled = zoom >= 32 || !full.durationSeconds;
    for (const name of ['zoom-out', 'zoom-fit']) if (controls[name]) controls[name].disabled = zoom <= 1;
    if (controls['zoom-value']) controls['zoom-value'].textContent = `${zoom}x`;
    const precision = durationSeconds < 1 ? 3 : 1;
    const rangeText = `${formatTimelineTime(startSeconds, precision)} - ${formatTimelineTime(endSeconds, precision)}`;
    if (controls['view-range']) controls['view-range'].textContent = rangeText;
    if (controls.pan) {
      controls.pan.min = String(full.startSeconds);
      controls.pan.max = String(Math.max(full.startSeconds, full.endSeconds - durationSeconds));
      controls.pan.step = String(Math.max(0.001, full.durationSeconds / 10000));
      controls.pan.value = String(startSeconds);
      controls.pan.disabled = zoom <= 1;
      controls.pan.hidden = zoom <= 1 || !full.durationSeconds;
      controls.pan.setAttribute('aria-valuetext', rangeText);
    }
  }

  rebuild() {
    if (this.destroyed) return;
    this.view = clampViewport(this.data.timeline, this.view.zoom, this.view.startSeconds);
    this.updateControls();
    const { start, end } = timelineRange(clampViewport(this.data.timeline));
    const viewport = { ...this.data.timeline, ...this.view };
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
      ctx.fillStyle = lane.kind === 'ruler' ? '#f4f5ec' : lane.kind === 'track' ? '#f4f7f6' : lane.kind === 'metronome' ? '#f8f4ec' : '#f7f8ef';
      ctx.fillRect(0, 0, lane.width, lane.height);
      const ticks = rulerTicks(viewport, lane.width);
      for (const tick of ticks) {
        const x = Math.round(timeToRatio(tick.time, viewport) * (lane.width - 1)) + 0.5;
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
          ? alignAudioPeaks(backgroundProfile, viewport, finite(this.data.timeline?.backgroundStartSeconds), count)
          : lane.kind === 'metronome' ? buildMetronomePeaks({ ...this.data, timeline: viewport }, count)
            : buildNotePeaks({ ...this.data, timeline: viewport }, count);
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
    if (peaks.referencePeak) peak = peaks.referencePeak;
    const volume = clamp(finite(lane.kind === 'track' ? this.data.backgroundVolume : lane.kind === 'metronome' ? this.data.metronomeVolume : this.data.noteVolume, 1), 0, 1);
    const gain = peak ? Math.max(0, center - 8) * volume / peak : 0;
    ctx.strokeStyle = '#d2d9cd';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, center + 0.5); ctx.lineTo(lane.width, center + 0.5); ctx.stroke();
    ctx.fillStyle = lane.kind === 'track' ? '#7594a0' : lane.kind === 'metronome' ? '#b08c60' : '#789f68';
    ctx.beginPath(); ctx.moveTo(0, center);
    for (let i = 0; i < peaks.maxs.length; i += 1) ctx.lineTo((i + 0.5) * lane.width / peaks.maxs.length, center - peaks.maxs[i] * gain);
    ctx.lineTo(lane.width, center);
    for (let i = peaks.mins.length - 1; i >= 0; i -= 1) ctx.lineTo((i + 0.5) * lane.width / peaks.mins.length, center - peaks.mins[i] * gain);
    ctx.closePath(); ctx.fill();
  }

  renderPosition() {
    if (this.destroyed) return;
    const ratio = timeToRatio(this.position, this.view);
    const visible = this.position >= this.view.startSeconds && this.position <= this.view.endSeconds;
    const { start, end } = timelineRange(clampViewport(this.data.timeline));
    for (const lane of this.lanes) {
      const ctx = lane.context;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, lane.canvas.width, lane.canvas.height);
      ctx.drawImage(lane.cache, 0, 0);
      ctx.setTransform(lane.ratio, 0, 0, lane.ratio, 0, 0);
      const x = Math.round(ratio * (lane.width - 1)) + 0.5;
      ctx.strokeStyle = '#b3664d'; ctx.lineWidth = 1.5;
      if (visible) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, lane.height); ctx.stroke(); }
      if (visible && lane.kind === 'ruler') {
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
    for (const [control, event, handler] of this.controlListeners) control.removeEventListener(event, handler);
  }
}
