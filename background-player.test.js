import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundPlayer } from './background-player.js';

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name) { for (const callback of [...(this.listeners.get(name) || [])]) callback(); }
}

class FakeMedia extends Events {
  constructor() {
    super(); this.preservesPitch = false; this.webkitPreservesPitch = false;
    this.readyState = 0; this.duration = 60; this.paused = true; this.seeking = false;
    this.playCalls = 0; this.pauseCalls = 0; this.seeks = []; this._time = 0; this.autoMetadata = true;
  }
  get currentTime() { return this._time; }
  set currentTime(value) { this._time = value; this.seeks.push(value); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  load() {
    this.readyState = 0;
    if (this.src && this.autoMetadata) { this.readyState = 1; this.emit('loadedmetadata'); }
  }
  play() { this.playCalls += 1; this.paused = false; return this.playBehavior?.() ?? Promise.resolve(); }
  pause() { this.pauseCalls += 1; this.paused = true; }
}

function fakeNode() {
  return { connections: [], disconnected: false,
    gain: { events: [], cancelScheduledValues(time) { this.events.push(['cancel', time]); },
      setValueAtTime(value, time) { this.events.push(['set', value, time]); },
      linearRampToValueAtTime(value, time) { this.events.push(['ramp', value, time]); } },
    connect(node) { this.connections.push(node); }, disconnect() { this.disconnected = true; } };
}

function makePlayer(t, { useDefaultTimers = false } = {}) {
  const context = new Events();
  Object.assign(context, { currentTime: 0, state: 'running', createGain: fakeNode,
    createMediaElementSource(media) { const node = fakeNode(); node.media = media; return node; } });
  const media = new FakeMedia();
  const pendingTimers = new Map();
  let timerId = 0;
  const timers = { setTimeout(callback, delay) { const id = ++timerId; pendingTimers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { pendingTimers.delete(id); } };
  const urls = { created: [], revoked: [], createObjectURL(file) { this.created.push(file); return `blob:test-${this.created.length}`; },
    revokeObjectURL(url) { this.revoked.push(url); } };
  const document = new Events(); document.hidden = false;
  const errors = [], ends = [];
  const output = fakeNode();
  const player = new BackgroundPlayer({ audioContext: context, output, mediaFactory: () => media,
    timers: useDefaultTimers ? undefined : timers, urlAPI: urls, document,
    onError: error => errors.push(error), onEnded: () => ends.push(true) });
  t.after(() => player.dispose());
  const fireTimer = () => {
    const [id, timer] = [...pendingTimers].sort((a, b) => a[1].delay - b[1].delay)[0];
    pendingTimers.delete(id); timer.callback();
  };
  return { player, media, context, pendingTimers, urls, output, errors, ends, document, fireTimer };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('default timers retain the browser global receiver while loading, scheduling and stopping', async t => {
  const pending = new Set();
  let timerId = 0;
  t.mock.method(globalThis, 'setTimeout', function () {
    assert.equal(this, globalThis, 'Window.setTimeout requires its global receiver');
    const id = ++timerId;
    pending.add(id);
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', function (id) {
    assert.equal(this, globalThis, 'Window.clearTimeout requires its global receiver');
    pending.delete(id);
  });
  const { player } = makePlayer(t, { useDefaultTimers: true });
  assert.equal(await player.setFile({}), true);
  assert.equal(pending.size, 0, 'metadata readiness cancels its timeout');
  const starting = player.play({ when: 10, offset: 0, playbackRate: 0.5, endTime: 20 });
  assert.equal(pending.size, 1);
  player.stop();
  assert.equal(await starting, false);
  assert.equal(pending.size, 0, 'stop cancels the delayed native start');
  player.dispose();
});

test('files use one pitch-preserving media element routed through the provided volume output', async t => {
  const { player, media, urls, output } = makePlayer(t);
  assert.equal(await player.setFile({ name: 'first.wav' }), true);
  assert.equal(media.src, 'blob:test-1');
  assert.equal(media.preservesPitch, true);
  assert.equal(media.webkitPreservesPitch, true);
  assert.equal(player.source.media, media);
  assert.equal(player.source.connections[0], player.gate);
  assert.equal(player.gate.connections[0], output);
  assert.equal(await player.setFile({ name: 'second.wav' }), true);
  assert.deepEqual(urls.revoked, ['blob:test-1']);
  player.clear();
  assert.deepEqual(urls.revoked, ['blob:test-1', 'blob:test-2']);
  assert.equal(media.src, '');
});

test('superseded metadata loads resolve false, failed current loads clear their source and URLs', async t => {
  const { player, media, urls, pendingTimers } = makePlayer(t);
  media.autoMetadata = false;
  const first = player.setFile({ name: 'first.wav' });
  const second = player.setFile({ name: 'second.wav' });
  assert.equal(await first, false);
  const rejected = assert.rejects(second, /could not be opened/);
  media.emit('error');
  await rejected;
  assert.equal(media.src, '');
  assert.deepEqual(urls.revoked, ['blob:test-1', 'blob:test-2']);
  assert.equal(pendingTimers.size, 0);
});

test('unlock primes silently during the gesture, and stop cancels an unresolved unlock', async t => {
  const { player, media } = makePlayer(t);
  await player.setFile({});
  assert.equal(await player.unlock(), true);
  assert.equal(media.paused, true);
  assert.equal(player.gate.gain.events.at(-1)[1], 0);
  let complete;
  media.playBehavior = () => new Promise(resolve => { complete = resolve; });
  const unlocking = player.unlock();
  player.stop();
  assert.equal(await unlocking, false);
  complete(); await flush();
  assert.equal(media.paused, true);
  assert.ok(!player.gate.gain.events.some(event => event[0] === 'ramp' && event[1] === 1));
});

test('scheduled starts use source-file seconds and speed, correcting a late callback against the audio clock', async t => {
  const { player, media, context, fireTimer } = makePlayer(t);
  await player.setFile({});
  await player.unlock();
  const starting = player.play({ when: 10, offset: 3, playbackRate: 0.5, endTime: 30 });
  assert.equal(media.paused, true);
  assert.equal(media.playbackRate, 0.5);
  context.currentTime = 12;
  fireTimer();
  assert.equal(await starting, true);
  assert.equal(media.currentTime, 4, 'two late clock seconds equal one source-file second at half speed');
  assert.equal(media.paused, false);
  assert.deepEqual(player.gate.gain.events.at(-1), ['set', 0, 30], 'the audio graph mutes exactly at the scheduled end');
});

test('a timer that fires before the audio clock reaches a distant offset stays silent and reschedules', async t => {
  const { player, media, context, fireTimer, pendingTimers } = makePlayer(t);
  await player.setFile({});
  media.duration = 1000;
  const starting = player.play({ when: 600, offset: 0, playbackRate: 2, endTime: 700 });
  assert.equal([...pendingTimers.values()][0].delay, 30000);
  context.currentTime = 20; fireTimer();
  assert.equal(media.playCalls, 0);
  assert.equal([...pendingTimers.values()][0].delay, 30000);
  player.stop();
  assert.equal(await starting, false);
  assert.equal(pendingTimers.size, 0);
});

test('pause and a newer seek cannot be undone by an older play promise completing later', async t => {
  const { player, media, context } = makePlayer(t);
  await player.setFile({});
  let complete;
  media.playBehavior = () => new Promise(resolve => { complete = resolve; });
  const old = player.play({ when: 0, offset: 0, playbackRate: 1, endTime: 20 });
  const oldComplete = complete;
  context.currentTime = 2;
  media.playBehavior = () => Promise.resolve();
  const current = player.play({ when: 2, offset: 10, playbackRate: 2, endTime: 20 });
  assert.equal(await old, false);
  assert.equal(await current, true);
  oldComplete(); await flush();
  assert.equal(media.currentTime, 10);
  assert.equal(media.paused, false);
  assert.equal(media.playbackRate, 2);
  player.stop();
  assert.equal(media.paused, true);
});

test('steady playback does not repeatedly seek, while large throttling drift recovers once', async t => {
  const { player, media, context, document, fireTimer } = makePlayer(t);
  await player.setFile({});
  await player.play({ when: 0, offset: 5, playbackRate: 0.5, endTime: 30 });
  const seeks = media.seeks.length;
  for (const second of [1, 2, 3]) {
    context.currentTime = second; media._time = 5 + second * 0.5 + 0.03;
    fireTimer();
  }
  assert.equal(media.seeks.length, seeks);
  context.currentTime = 10; media._time = 8;
  document.emit('visibilitychange');
  assert.equal(media.currentTime, 10);
  assert.equal(media.seeks.length, seeks + 1);
  context.currentTime = 10.1; media._time = 10.05;
  document.emit('visibilitychange');
  assert.equal(media.seeks.length, seeks + 1);
});

test('audio-context suspension pauses media and resume restores the same score-clock position', async t => {
  const { player, media, context } = makePlayer(t);
  await player.setFile({});
  await player.play({ when: 0, offset: 2, playbackRate: 2, endTime: 20 });
  context.currentTime = 3; context.state = 'suspended'; context.emit('statechange');
  assert.equal(media.paused, true);
  context.state = 'running'; context.emit('statechange'); await flush();
  assert.equal(media.paused, false);
  assert.equal(media.currentTime, 8);
});

test('blocked initial starts reject once, later playback errors use onError, and no stale audio restarts', async t => {
  const { player, media, errors, pendingTimers } = makePlayer(t);
  await player.setFile({});
  media.playBehavior = () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
  await assert.rejects(player.play({ when: 0, offset: 0, playbackRate: 1, endTime: 20 }), /Press Play again/);
  assert.equal(media.paused, true);
  assert.equal(errors.length, 0);
  assert.equal(pendingTimers.size, 0);
  media.playBehavior = () => Promise.resolve();
  await player.play({ when: 0, offset: 0, playbackRate: 1, endTime: 20 });
  media.error = new Error('read failure'); media.emit('error');
  assert.equal(errors.length, 1);
  assert.equal(media.paused, true);
  assert.equal(pendingTimers.size, 0);
});

test('native end and scheduled end stop media once, and disposal releases all resources', async t => {
  const { player, media, context, fireTimer, ends, urls, document } = makePlayer(t);
  await player.setFile({});
  await player.play({ when: 0, offset: 0, playbackRate: 1, endTime: 2 });
  context.currentTime = 2; fireTimer();
  media.emit('ended');
  assert.equal(ends.length, 1);
  assert.equal(media.paused, true);
  await player.play({ when: 2, offset: 30, playbackRate: 1, endTime: 10 });
  media.emit('ended');
  assert.equal(ends.length, 2);
  player.dispose();
  assert.equal(player.source.disconnected, true);
  assert.equal(player.gate.disconnected, true);
  assert.deepEqual(urls.revoked, ['blob:test-1']);
  assert.equal(document.listeners.get('visibilitychange').size, 0);
});
