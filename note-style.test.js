import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotation } from './notation.js';
import { noteColors, noteGeometry, beatToX, progressForBeat, editorBeatWidth } from './note-style.js';

function rgb(color) { return color.match(/\d+/g).map(Number); }
function luminance(color) {
  const values = rgb(color).map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

test('note rectangles preserve exact duration ratios, including dotted notes and rests', () => {
  const parsed = parseNotation('1s 1e 1q 1h 1w 0q. -12#s.');
  const geometry = parsed.notes.map(note => noteGeometry(note));
  assert.deepEqual(geometry.map(note => note.width), [12, 24, 48, 96, 192, 72, 18]);
  for (let index = 1; index < geometry.length; index++) assert.equal(geometry[index].x, geometry[index - 1].endX);
  assert.equal(geometry.at(-1).endX, beatToX(parsed.totalBeats, parsed.totalBeats));
});

test('playhead follows time inside long notes and clamps lead-in and score end', () => {
  assert.equal(beatToX(-3, 4), 0);
  assert.equal(beatToX(0, 4), 0);
  assert.equal(beatToX(1.25, 4), 60);
  assert.equal(beatToX(2, 4), 96);
  assert.equal(beatToX(4, 4), 192);
  assert.equal(beatToX(9, 4), 192);
  assert.equal(beatToX(5, 0), 0);
  assert.equal(beatToX(NaN, 4), 0);
});

test('four whole notes fit the editor width with space for separators at every layout size', () => {
  const notes = parseNotation('1w -3#w 12w 0w').notes;
  for (const contentWidth of [200, 260, 540, 700, 1200]) {
    const scale = editorBeatWidth(contentWidth);
    const widths = notes.map(note => noteGeometry(note, scale).width);
    assert.ok(widths.reduce((sum, width) => sum + width, 0) + 80 <= contentWidth);
    assert.equal(widths[0], widths[3]);
    assert.equal(noteGeometry(parseNotation('1s').notes[0], scale).width * 16, widths[0]);
    assert.ok(scale <= 48);
  }
});

test('every higher hole is visibly darker, with green blow and red draw palettes', () => {
  for (const draw of [false, true]) {
    let previous = Infinity;
    for (let hole = 1; hole <= 12; hole++) {
      const colors = noteColors({ hole, draw });
      const channels = rgb(colors.background);
      const light = luminance(colors.background);
      assert.ok(light < previous, `Hole ${hole} should be darker`);
      assert.ok(draw ? channels[0] > channels[1] : channels[1] > channels[0]);
      const contrast = colors.foreground === '#ffffff' ? 1.05 / (light + 0.05) : (light + 0.05) / 0.05;
      assert.ok(contrast >= 4.5, `Hole ${hole} text must remain readable`);
      previous = light;
    }
  }
});

test('colors depend on hole and breath, while slider and duration leave them unchanged', () => {
  assert.deepEqual(noteColors({ hole: 3, draw: true }), noteColors({ hole: 3, draw: true, slider: true, duration: 'w' }));
  assert.deepEqual(noteColors({ hole: 0, isRest: true }), noteColors({ hole: 0, isRest: true, draw: true }));
});

test('inline playhead uses progress within each note across line breaks', () => {
  const parsed = parseNotation('1q\n-3#w 0h');
  const wholeNote = parsed.notes[1];
  assert.equal(progressForBeat(wholeNote, -2), 0);
  assert.equal(progressForBeat(wholeNote, 1), 0);
  assert.equal(progressForBeat(wholeNote, 2), 0.25);
  assert.equal(progressForBeat(wholeNote, 3), 0.5);
  assert.equal(progressForBeat(wholeNote, 5), 1);
  assert.equal(progressForBeat(wholeNote, 9), 1);
  assert.equal(progressForBeat(parsed.notes[2], 6), 0.5);
  assert.equal(progressForBeat(wholeNote, NaN), 0);
});
