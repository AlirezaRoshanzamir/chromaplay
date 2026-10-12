const MAX_TIMER_MS = 30_000;
const DRIFT_LIMIT_SECONDS = 0.15;
const CORRECTION_INTERVAL_SECONDS = 2;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject, settled: false };
}

function playbackError(error) {
  return new Error(error?.name === 'NotAllowedError'
    ? 'The browser blocked the backing track. Press Play again to allow audio.'
    : 'The backing track could not play. Try loading it again.', { cause: error });
}

/** Native pitch-preserving media playback, aligned to the score's AudioContext clock. */
export class BackgroundPlayer {
  constructor({ audioContext, output, onError, onEnded,
    mediaFactory = () => new Audio(), urlAPI = globalThis.URL,
    timers = {
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args),
    },
    document: documentObject = globalThis.document } = {}) {
    this.context = audioContext;
    this.media = mediaFactory();
    this.urlAPI = urlAPI;
    this.timers = timers;
    this.document = documentObject;
    this.onError = onError;
    this.onEnded = onEnded;
    this.media.preload = 'auto';
    this.media.loop = false;
    this.media.volume = 1;
    this.media.muted = false;
    this.pitchPreservationSupported = ['preservesPitch', 'webkitPreservesPitch', 'mozPreservesPitch'].some(key => key in this.media);
    for (const property of ['preservesPitch', 'webkitPreservesPitch', 'mozPreservesPitch']) {
      if (property in this.media) this.media[property] = true;
    }
    this.gate = audioContext.createGain();
    this.gate.gain.value = 0;
    this.source = audioContext.createMediaElementSource(this.media);
    this.source.connect(this.gate);
    this.gate.connect(output);
    this._generation = 0;
    this._url = null;
    this._loading = null;
    this._unlock = null;
    this._run = null;
    this._timer = null;
    this._disposed = false;
    this._handleError = () => { if (this._run) this._fail(this._run, this.media.error); };
    this._handleEnded = () => { if (this._run) this._finish(this._run); };
    this._handlePlaying = () => {
      if (this._run?.started) this._tick(true);
    };
    this._handleVisibility = () => { if (!this.document?.hidden) this._tick(true); };
    this._handleContextState = () => this._tick(true);
    this.media.addEventListener('error', this._handleError);
    this.media.addEventListener('ended', this._handleEnded);
    this.media.addEventListener('playing', this._handlePlaying);
    this.document?.addEventListener('visibilitychange', this._handleVisibility);
    this.context.addEventListener?.('statechange', this._handleContextState);
  }

  /** Call after waveform decoding succeeds. A replaced load resolves false. */
  setFile(file) {
    if (this._disposed) return Promise.reject(new Error('The backing player has been closed.'));
    let url;
    try { url = this.urlAPI.createObjectURL(file); }
    catch (error) { return Promise.reject(playbackError(error)); }
    this.clear();
    this._url = url;
    const load = deferred();
    this._loading = load;
    const cleanup = () => {
      this.timers.clearTimeout(load.timer);
      this.media.removeEventListener('loadedmetadata', ready);
      this.media.removeEventListener('error', failed);
      if (this._loading === load) this._loading = null;
    };
    const ready = () => {
      if (this._loading !== load) return;
      cleanup();
      load.resolve(true);
    };
    const failed = () => {
      if (this._loading !== load) return;
      cleanup();
      this.clear();
      load.reject(new Error('This backing track could not be opened. Try an MP3 or WAV file.'));
    };
    load.cancel = () => { cleanup(); load.resolve(false); };
    this.media.addEventListener('loadedmetadata', ready);
    this.media.addEventListener('error', failed);
    load.timer = this.timers.setTimeout(failed, 30_000);
    try {
      this.media.src = url;
      this.media.load();
      if (this.media.readyState >= 1) ready();
    } catch { failed(); }
    return load.promise;
  }

  /** Prime the same media element from a Play gesture, before awaiting other work. */
  unlock() {
    if (!this._url || this._disposed) return Promise.resolve(false);
    if (this._run) return Promise.resolve(true);
    if (this._unlock) return this._unlock.promise;
    const request = deferred();
    this._unlock = request;
    this._mute();
    const success = () => {
      if (this._unlock !== request) return;
      this._unlock = null;
      this.media.pause();
      request.resolve(true);
    };
    const failure = error => {
      if (this._unlock !== request) return;
      this._unlock = null;
      this.media.pause();
      request.reject(playbackError(error));
    };
    try { Promise.resolve(this.media.play()).then(success, failure); }
    catch (error) { failure(error); }
    return request.promise;
  }

  /** Resolve when this scheduled start succeeds; resolve false if cancelled before then. */
  play({ when, offset = 0, playbackRate = 1, endTime } = {}) {
    if (![when, offset, playbackRate, endTime].every(Number.isFinite) || offset < 0
      || playbackRate < 0.25 || playbackRate > 2 || endTime <= when) {
      return Promise.reject(new Error('Choose a valid backing-track time and speed from 0.25x to 2x.'));
    }
    if (playbackRate !== 1 && !this.pitchPreservationSupported) {
      return Promise.reject(new Error('This browser cannot preserve backing-track pitch at a different speed. Try a newer browser.'));
    }
    this.stop();
    if (!this._url || this._disposed || this.context.currentTime >= endTime) return Promise.resolve(false);
    const request = deferred();
    const run = { ...request, generation: this._generation, when, offset, playbackRate, endTime,
      starting: false, started: false, lastCorrection: -Infinity };
    this._run = run;
    this.media.playbackRate = playbackRate;
    this._tick();
    return run.promise;
  }

  _expectedPosition(run) {
    return run.offset + Math.max(0, this.context.currentTime - run.when) * run.playbackRate;
  }

  _mute() {
    const now = this.context.currentTime;
    this.gate.gain.cancelScheduledValues(now);
    this.gate.gain.setValueAtTime(0, now);
  }

  _openGate(run) {
    const now = this.context.currentTime;
    if (now >= run.endTime) return;
    this.gate.gain.cancelScheduledValues(now);
    this.gate.gain.setValueAtTime(0, now);
    this.gate.gain.linearRampToValueAtTime(1, Math.min(now + 0.008, run.endTime));
    this.gate.gain.setValueAtTime(0, run.endTime);
  }

  _arm(delayMs) {
    this.timers.clearTimeout(this._timer);
    this._timer = this.timers.setTimeout(() => {
      this._timer = null;
      this._tick();
    }, Math.max(1, Math.min(MAX_TIMER_MS, delayMs)));
  }

  _tick(recover = false) {
    const run = this._run;
    if (!run) return;
    const now = this.context.currentTime;
    const expected = this._expectedPosition(run);
    if (now >= run.endTime || Number.isFinite(this.media.duration) && expected >= this.media.duration) {
      this._finish(run);
      return;
    }
    if (this.context.state && this.context.state !== 'running') {
      this._mute();
      this.media.pause();
      this._arm(1000);
      return;
    }
    if (now < run.when) {
      this._arm((run.when - now) * 1000);
      return;
    }
    if (!run.starting && this.media.paused) {
      this._start(run);
      return;
    }
    if (run.started && !run.starting && !this.media.seeking
      && Math.abs(this.media.currentTime - expected) > DRIFT_LIMIT_SECONDS
      && (recover || now - run.lastCorrection >= CORRECTION_INTERVAL_SECONDS)) {
      // Correct a stalled or throttled media clock only after a meaningful drift.
      // Normal playback never seeks on animation frames or on every timer tick.
      try {
        this._mute();
        this.media.currentTime = expected;
        run.lastCorrection = now;
        this._openGate(run);
      } catch (error) { this._fail(run, error); return; }
    }
    this._arm(Math.min(1000, (run.endTime - now) * 1000));
  }

  _start(run) {
    if (this._run !== run) return;
    run.starting = true;
    this._mute();
    const success = () => {
      if (this._run !== run) return;
      run.starting = false;
      if (this.context.currentTime >= run.endTime) { this._finish(run); return; }
      if (this.context.state && this.context.state !== 'running') { this._tick(); return; }
      const expected = this._expectedPosition(run);
      if (Number.isFinite(this.media.duration) && expected >= this.media.duration) { this._finish(run); return; }
      try {
        if (Math.abs(this.media.currentTime - expected) > 0.04) this.media.currentTime = expected;
        run.lastCorrection = this.context.currentTime;
        run.started = true;
        this._openGate(run);
        if (!run.settled) { run.settled = true; run.resolve(true); }
        this._arm(Math.min(1000, (run.endTime - this.context.currentTime) * 1000));
      } catch (error) { this._fail(run, error); }
    };
    const failure = error => {
      if (this._run !== run) return;
      run.starting = false;
      if (this.context.state && this.context.state !== 'running' && error?.name === 'AbortError') {
        this._arm(1000);
        return;
      }
      this._fail(run, error);
    };
    try {
      this.media.currentTime = this._expectedPosition(run);
      this.media.playbackRate = run.playbackRate;
      Promise.resolve(this.media.play()).then(success, failure);
    } catch (error) { failure(error); }
  }

  _finish(run) {
    if (this._run !== run) return;
    this.stop();
    this.onEnded?.();
  }

  _fail(run, error) {
    if (this._run !== run) return;
    const started = run.settled;
    // Mark settled before stopping so an unsuccessful first start rejects, not resolves false.
    run.settled = true;
    this.stop();
    const message = playbackError(error);
    if (started) this.onError?.(message);
    else run.reject(message);
  }

  stop() {
    this._generation += 1;
    this.timers.clearTimeout(this._timer);
    this._timer = null;
    const run = this._run;
    this._run = null;
    if (run && !run.settled) { run.settled = true; run.resolve(false); }
    const request = this._unlock;
    this._unlock = null;
    request?.resolve(false);
    this._mute();
    this.media.pause();
  }

  clear() {
    this.stop();
    this._loading?.cancel();
    const url = this._url;
    this._url = null;
    this.media.removeAttribute('src');
    this.media.load();
    if (url) this.urlAPI.revokeObjectURL(url);
  }

  dispose() {
    if (this._disposed) return;
    this.clear();
    this._disposed = true;
    this.media.removeEventListener('error', this._handleError);
    this.media.removeEventListener('ended', this._handleEnded);
    this.media.removeEventListener('playing', this._handlePlaying);
    this.document?.removeEventListener('visibilitychange', this._handleVisibility);
    this.context.removeEventListener?.('statechange', this._handleContextState);
    this.source.disconnect();
    this.gate.disconnect();
  }
}
