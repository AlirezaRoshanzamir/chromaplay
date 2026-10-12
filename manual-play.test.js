import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualHarmonica } from './manual-play.js';

class FakeTarget {
  constructor({ hole, blocked = false } = {}) {
    this.listeners = new Map();
    this.dataset = hole ? { hole: String(hole) } : {};
    this.attributes = {};
    this.blocked = blocked;
    this.pitchLabel = { textContent: '' };
  }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  dispatch(name, properties = {}) {
    const event = {
      target: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...properties,
    };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return event;
  }
  closest(selector) {
    if (selector === '[data-hole]') return this.dataset.hole ? this : null;
    if (this.attributes.role === 'slider' && selector.includes('[role="slider"]')) return this;
    return this.blocked ? this : null;
  }
  querySelector() { return this.pitchLabel; }
  querySelectorAll() { return this.holes ?? []; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
  setPointerCapture() {}
}

function setup(t) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const document = globalThis.document = new FakeTarget();
  const window = globalThis.window = new FakeTarget();
  const root = new FakeTarget();
  root.holes = Array.from({ length: 12 }, (_, index) => new FakeTarget({ hole: index + 1 }));
  const drawButton = new FakeTarget(), sliderButton = new FakeTarget();
  const audio = {
    starts: [], stops: 0,
    async startManualNote(midi) { this.starts.push(midi); },
    stopManualNote() { this.stops++; },
  };
  const changes = [];
  let blocked = false;
  const instrument = new ManualHarmonica(root, {
    audio, drawButton, sliderButton,
    onChange: note => changes.push(note),
    isBlocked: () => blocked,
  });
  t.after(() => {
    instrument.stop();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  return {
    root, document, window, audio, changes, instrument, drawButton, sliderButton,
    setBlocked(value) { blocked = value; },
    down(code, properties = {}) { return document.dispatch('keydown', { code, ...properties }); },
    up(code, properties = {}) {
      // Simulate a sustained note so keyup does not need the minimum tap timer.
      instrument.startedAt = performance.now() - 300;
      return document.dispatch('keyup', { code, ...properties });
    },
  };
}

test('number row keys play all 12 holes and release their audio', t => {
  const f = setup(t);
  const keys = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'];
  for (const [index, code] of keys.entries()) {
    const press = f.down(code);
    assert.equal(press.defaultPrevented, true, code);
    assert.equal(f.changes.at(-1).hole, index + 1, code);
    assert.equal(f.changes.at(-1).draw, false, code);
    assert.equal(f.changes.at(-1).slider, false, code);
    assert.equal(f.up(code).defaultPrevented, true, code);
    assert.equal(f.changes.at(-1), null, `${code} releases`);
  }
  assert.equal(f.audio.starts.length, 12);
  assert.equal(f.audio.stops, 12);
});

test('physical key codes work with Shift and the numeric keypad', t => {
  const f = setup(t);
  for (const [code, key, hole] of [['Digit1', '!', 1], ['Digit0', ')', 10], ['Minus', '_', 11], ['Equal', '+', 12]]) {
    f.down(code, { key, shiftKey: true });
    assert.equal(f.changes.at(-1).hole, hole);
    f.up(code, { key, shiftKey: true });
  }
  for (let digit = 0; digit <= 9; digit++) {
    f.down(`Numpad${digit}`);
    assert.equal(f.changes.at(-1).hole, digit || 10);
    f.up(`Numpad${digit}`);
  }
});

test('D and S retune a held number note and release independently', t => {
  const f = setup(t);
  f.down('Digit1');
  f.down('KeyD');
  f.down('KeyS');
  assert.deepEqual(f.audio.starts, [60, 62, 63]);
  assert.equal(f.changes.at(-1).token, '-1#');
  assert.equal(f.drawButton.attributes['aria-pressed'], 'true');
  assert.equal(f.sliderButton.attributes['aria-pressed'], 'true');
  f.up('KeyD');
  assert.equal(f.changes.at(-1).token, '1#');
  f.up('KeyS');
  assert.equal(f.changes.at(-1).token, '1');
  assert.deepEqual(f.audio.starts, [60, 62, 63, 61, 60]);
  f.up('Digit1');
  assert.equal(f.changes.at(-1), null);
});

test('Left arrow activates the slider while held and consumes the shortcut', t => {
  const f = setup(t);
  f.down('Digit1');
  assert.equal(f.down('ArrowLeft').defaultPrevented, true);
  assert.equal(f.sliderButton.attributes['aria-pressed'], 'true');
  assert.equal(f.changes.at(-1).token, '1#');
  assert.deepEqual(f.audio.starts, [60, 61]);
  f.down('ArrowLeft', { repeat: true });
  assert.deepEqual(f.audio.starts, [60, 61]);
  f.up('ArrowLeft');
  assert.equal(f.sliderButton.attributes['aria-pressed'], 'false');
  assert.equal(f.changes.at(-1).token, '1');
  assert.deepEqual(f.audio.starts, [60, 61, 60]);
  f.up('Digit1');
});

test('S and Left arrow keep the slider active until both aliases are released', t => {
  const f = setup(t);
  for (const releaseOrder of [['KeyS', 'ArrowLeft'], ['ArrowLeft', 'KeyS']]) {
    f.down('Digit1');
    const startCount = f.audio.starts.length;
    f.down('KeyS');
    f.down('ArrowLeft');
    assert.equal(f.audio.starts.length, startCount + 1);
    f.up(releaseOrder[0]);
    assert.equal(f.sliderButton.attributes['aria-pressed'], 'true');
    assert.equal(f.changes.at(-1).token, '1#');
    assert.equal(f.audio.starts.length, startCount + 1, 'releasing one alias must not retune');
    f.up(releaseOrder[1]);
    assert.equal(f.sliderButton.attributes['aria-pressed'], 'false');
    assert.equal(f.changes.at(-1).token, '1');
    assert.equal(f.audio.starts.length, startCount + 2);
    f.up('Digit1');
  }
});

test('D and Left arrow held before hole 12 play its slider-in draw reed', t => {
  const f = setup(t);
  f.down('KeyD');
  f.down('ArrowLeft');
  f.down('Equal');
  assert.equal(f.changes.at(-1).token, '-12#');
  assert.equal(f.changes.at(-1).pitch, 'D7');
  assert.deepEqual(f.audio.starts, [98]);
  f.up('ArrowLeft');
  assert.equal(f.changes.at(-1).token, '-12');
  assert.deepEqual(f.audio.starts, [98, 95]);
  f.up('Equal');
  f.up('KeyD');
});

test('Space only holds draw, including on a focused hole, and consumes its release', t => {
  const f = setup(t);
  for (const target of [f.document, f.root.holes[11]]) {
    assert.equal(f.down('Space', { target }).defaultPrevented, true);
    assert.equal(f.drawButton.attributes['aria-pressed'], 'true');
    assert.equal(f.audio.starts.length, 0);
    assert.equal(f.instrument.note, null);
    assert.equal(f.down('Space', { target, repeat: true }).defaultPrevented, true);
    assert.equal(f.audio.starts.length, 0);
    assert.equal(f.up('Space', { target }).defaultPrevented, true);
    assert.equal(f.drawButton.attributes['aria-pressed'], 'false');
    assert.equal(f.up('Space', { target }).defaultPrevented, false);
  }
});

test('D and Space keep draw active until both aliases are released', t => {
  const f = setup(t);
  for (const releaseOrder of [['KeyD', 'Space'], ['Space', 'KeyD']]) {
    f.down('Digit1');
    const startCount = f.audio.starts.length;
    f.down('KeyD');
    f.down('Space');
    assert.equal(f.audio.starts.length, startCount + 1);
    assert.equal(f.up(releaseOrder[0]).defaultPrevented, true);
    assert.equal(f.drawButton.attributes['aria-pressed'], 'true');
    assert.equal(f.changes.at(-1).token, '-1');
    assert.equal(f.audio.starts.length, startCount + 1, 'releasing one alias must not retune');
    assert.equal(f.up(releaseOrder[1]).defaultPrevented, true);
    assert.equal(f.drawButton.attributes['aria-pressed'], 'false');
    assert.equal(f.changes.at(-1).token, '1');
    assert.equal(f.audio.starts.length, startCount + 2);
    f.up('Digit1');
  }
});

test('Space and Left arrow combine with number keys and retune independently', t => {
  const f = setup(t);
  f.down('Space');
  f.down('ArrowLeft');
  f.down('Digit1');
  assert.equal(f.changes.at(-1).token, '-1#');
  assert.deepEqual(f.audio.starts, [63]);
  f.up('Space');
  assert.equal(f.changes.at(-1).token, '1#');
  f.up('ArrowLeft');
  assert.equal(f.changes.at(-1).token, '1');
  assert.deepEqual(f.audio.starts, [63, 61, 60]);
  f.up('Digit1');
  assert.equal(f.changes.at(-1), null);
});

test('repeated keydown never restarts a held note or changes key priority', t => {
  const f = setup(t);
  f.down('Digit1');
  f.down('Digit1', { repeat: true });
  f.down('Digit1');
  f.down('Digit2');
  f.down('Digit1', { repeat: true });
  assert.equal(f.audio.starts.length, 2);
  assert.equal(f.changes.at(-1).hole, 2);
  f.up('Digit2');
  assert.equal(f.changes.at(-1).hole, 1);
  f.up('Digit1');
  assert.equal(f.changes.at(-1), null);
});

test('last held key wins, releasing it resumes the previous key, and other releases do not stop audio', t => {
  const f = setup(t);
  f.down('Digit1');
  f.down('Digit2');
  f.down('Digit3');
  f.up('Digit2');
  assert.equal(f.changes.at(-1).hole, 3);
  assert.equal(f.audio.starts.length, 3);
  assert.equal(f.audio.stops, 0);
  f.up('Digit3');
  assert.equal(f.changes.at(-1).hole, 1);
  assert.equal(f.audio.stops, 0);
  f.up('Digit1');
  assert.equal(f.changes.at(-1), null);
  assert.equal(f.audio.stops, 1);
});

test('Enter on a hole participates in the same held-key priority as number keys', t => {
  const f = setup(t);
  const hole = f.root.holes[11];
  f.down('Digit2');
  f.down('Enter', { target: hole });
  assert.equal(f.changes.at(-1).hole, 12);
  f.down('Digit4');
  f.up('Digit4');
  assert.equal(f.changes.at(-1).hole, 12);
  f.up('Enter', { target: hole });
  assert.equal(f.changes.at(-1).hole, 2);
  f.down('Enter', { target: f.root.holes[4] });
  assert.equal(f.changes.at(-1).hole, 5);
  f.up('Enter');
  assert.equal(f.changes.at(-1).hole, 2);
  f.up('Digit2');
  assert.equal(f.changes.at(-1), null);
});

test('editing, dialogs, composing, and modified shortcuts do not play or consume number keys', t => {
  const f = setup(t);
  for (const properties of [
    { target: new FakeTarget({ blocked: true }) },
    { isComposing: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true },
  ]) {
    for (const code of ['Digit1', 'Minus', 'Equal', 'KeyD', 'KeyS', 'ArrowLeft', 'Space']) {
      assert.equal(f.down(code, properties).defaultPrevented, false);
      assert.equal(f.up(code, properties).defaultPrevented, false);
    }
  }
  f.setBlocked(true);
  assert.equal(f.down('Digit1').defaultPrevented, false);
  assert.equal(f.down('ArrowLeft').defaultPrevented, false);
  assert.equal(f.down('Space').defaultPrevented, false);
  assert.equal(f.up('Space').defaultPrevented, false);
  assert.equal(f.audio.starts.length, 0);
  assert.equal(f.drawButton.attributes['aria-pressed'], 'false');
  assert.equal(f.sliderButton.attributes['aria-pressed'], 'false');
});

test('a focused waveform slider keeps navigation and number keys out of manual playing', t => {
  const f = setup(t);
  const waveform = new FakeTarget();
  waveform.setAttribute('role', 'slider');
  for (const code of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Digit1', 'Minus', 'Equal', 'Space', 'KeyD', 'KeyS']) {
    assert.equal(f.down(code, { target: waveform }).defaultPrevented, false, code);
    assert.equal(f.up(code, { target: waveform }).defaultPrevented, false, code);
  }
  assert.equal(f.audio.starts.length, 0);
  assert.equal(f.instrument.note, null);
  assert.equal(f.drawButton.attributes['aria-pressed'], 'false');
  assert.equal(f.sliderButton.attributes['aria-pressed'], 'false');
});

test('handled keydowns cannot retune or replace a held note, but its release still stops it', t => {
  const f = setup(t);
  f.down('Digit1');
  for (const code of ['ArrowLeft', 'Space', 'Digit2']) {
    f.down(code, { defaultPrevented: true });
    f.up(code);
  }
  assert.deepEqual(f.audio.starts, [60]);
  assert.equal(f.instrument.note.token, '1');
  assert.equal(f.drawButton.attributes['aria-pressed'], 'false');
  assert.equal(f.sliderButton.attributes['aria-pressed'], 'false');
  f.up('Digit1', { defaultPrevented: true });
  assert.equal(f.instrument.note, null);
  assert.equal(f.audio.stops, 1);
});

test('moving focus to a waveform releases held notes and modifiers before seeking', t => {
  const f = setup(t);
  const waveform = new FakeTarget();
  waveform.setAttribute('role', 'slider');
  f.down('Digit1');
  f.down('ArrowLeft');
  f.down('Space');
  assert.equal(f.instrument.note.token, '-1#');
  f.document.dispatch('focusin', { target: waveform });
  assert.equal(f.instrument.note, null);
  assert.equal(f.drawButton.attributes['aria-pressed'], 'false');
  assert.equal(f.sliderButton.attributes['aria-pressed'], 'false');
  const starts = f.audio.starts.length;
  f.up('Digit1', { target: waveform });
  f.up('ArrowLeft', { target: waveform });
  f.up('Space', { target: waveform });
  assert.equal(f.audio.starts.length, starts);
  assert.equal(f.instrument.note, null);
});

test('blur and editing focus clear held notes so later releases cannot revive audio', t => {
  const f = setup(t);
  for (const reset of [
    () => f.window.dispatch('blur'),
    () => f.document.dispatch('focusin', { target: new FakeTarget({ blocked: true }) }),
    () => f.window.dispatch('pagehide'),
    () => { f.document.hidden = true; f.document.dispatch('visibilitychange'); f.document.hidden = false; },
    () => f.instrument.stop(),
  ]) {
    f.down('Digit1');
    f.down('Digit2');
    reset();
    const starts = f.audio.starts.length;
    assert.equal(f.changes.at(-1), null);
    f.up('Digit2');
    f.up('Digit1');
    assert.equal(f.audio.starts.length, starts);
    assert.equal(f.changes.at(-1), null);
  }
});

test('mouse takeover clears keyboard notes and later key releases leave the mouse note playing', t => {
  const f = setup(t);
  f.down('Digit1');
  f.down('Digit2');
  f.root.dispatch('pointerdown', {
    target: f.root.holes[6], button: 0, isPrimary: true, pointerId: 7,
  });
  assert.equal(f.changes.at(-1).hole, 7);
  const starts = f.audio.starts.length;
  f.up('Digit2');
  f.up('Digit1');
  assert.equal(f.audio.starts.length, starts);
  assert.equal(f.audio.stops, 0);
  assert.equal(f.changes.at(-1).hole, 7);
  f.root.dispatch('pointerup', { pointerId: 7 });
  assert.equal(f.changes.at(-1), null);
});
