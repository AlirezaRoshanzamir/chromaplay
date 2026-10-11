import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotation } from './notation.js';
import { HarmonicaVisualizer } from './visualizer.js';

function setup(t, width = 960, height = 340) {
  const originalWindow = globalThis.window;
  const originalObserver = globalThis.ResizeObserver;
  globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  delete globalThis.ResizeObserver;
  const labels = [];
  const stack = [];
  const ctx = {
    save() {
      stack.push({ font: this.font, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha });
    },
    restore() { Object.assign(this, stack.pop()); },
    fillText(text, x, y, maxWidth) {
      labels.push({ text, x, y, maxWidth, font: this.font, color: this.fillStyle });
    },
    createLinearGradient() { return { addColorStop() {} }; },
  };
  for (const method of ['beginPath', 'moveTo', 'arcTo', 'closePath', 'lineTo', 'rect', 'clip', 'setTransform', 'clearRect', 'fillRect', 'fill', 'stroke', 'setLineDash']) {
    ctx[method] = () => {};
  }
  const rect = { left: 0, top: 0, width, height };
  const canvas = {
    style: {}, getContext: () => ctx, getBoundingClientRect: () => rect,
    addEventListener() {}, removeEventListener() {},
  };
  const visualizer = new HarmonicaVisualizer(canvas);
  t.after(() => {
    visualizer.destroy();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = originalObserver;
  });
  const render = (notation, beat = 0) => {
    visualizer.setScore(parseNotation(notation).notes);
    labels.length = 0;
    visualizer.setPosition(beat);
    return labels.filter(label => label.color === '#b4edb1' || label.color === '#eab09a');
  };
  return { visualizer, labels, rect, render };
}

test('short sixteenth blocks always show their hole and slider without overlapping adjacent labels', t => {
  const f = setup(t, 960, 180);
  for (const height of [180, 340, 640]) {
    f.rect.height = height;
    f.visualizer.resize();
    const labels = f.render(Array(8).fill('-12#s').join(' '));
    assert.equal(labels.length, 8, `All sixteenths are labeled at ${height}px`);
    for (const [index, label] of labels.entries()) {
      assert.equal(label.text, '12#');
      assert.match(label.font, /9px/);
      assert.equal(label.color, '#eab09a');
      const area = f.visualizer.hitAreas[index];
      assert.ok(label.y >= area.y && label.y <= area.y + area.height);
      if (index > 0) assert.ok(labels[index - 1].y - label.y >= 15);
    }
  }
});

test('narrow lanes retain direction, two-digit holes, and slider markers', t => {
  const f = setup(t, 320, 180);
  const labels = f.render('12#s -12#s 1s -1s');
  assert.deepEqual(labels.map(label => label.text), ['+12#', '-12#', '+1', '-1']);
  assert.deepEqual(labels.map(label => label.color), ['#b4edb1', '#eab09a', '#b4edb1', '#eab09a']);
  for (const label of labels) {
    assert.ok(label.maxWidth > 0 && label.maxWidth < 20);
    assert.match(label.font, /9px/);
  }
});

test('long notes keep the normal label size and duration geometry remains proportional', t => {
  const f = setup(t, 960, 640);
  const labels = f.render('3w -5#h 7q 9e');
  assert.deepEqual(labels.slice(0, 3).map(label => label.text), ['3', '5#', '7']);
  for (const label of labels.slice(0, 3)) assert.match(label.font, /12px/);
  const [whole, half, quarter, eighth] = f.visualizer.hitAreas;
  assert.equal(whole.height + 3, (half.height + 3) * 2);
  assert.equal(half.height + 3, (quarter.height + 3) * 2);
  assert.equal(quarter.height + 3, (eighth.height + 3) * 2);
});

test('short rests stay labeled and resizing changes the time window without changing the play position', t => {
  const f = setup(t, 960, 180);
  f.render('0s 0s 0s 0s 0s 0s 0s 0s');
  assert.equal(f.labels.filter(label => label.text === 'REST').length, 8);
  f.render('1w 2w 3w', 1);
  assert.equal(f.visualizer.hitAreas.length, 1);
  f.rect.height = 640;
  f.visualizer.resize();
  assert.equal(f.visualizer.beat, 1);
  assert.equal(f.visualizer.hitAreas.length, 3);
});

test('a partially played sixteenth keeps its label until its duration ends', t => {
  const f = setup(t, 960, 180);
  assert.deepEqual(f.render('-12#s 1q', 0.23).map(label => label.text), ['12#', '1']);
  assert.deepEqual(f.render('-12#s 1q', 0.25).map(label => label.text), ['1']);
});
