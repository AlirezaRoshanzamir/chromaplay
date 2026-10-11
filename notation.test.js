import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotation, pitchFor, formatDuration } from './notation.js';

const emptyScore = { notes: [], errors: [], totalBeats: 0, tempo: 60, numerator: 4, denominator: 4, directives: [] };

test('parses adjoining notes, explicit blow, draw, slider, and every duration', () => {
  const result = parseNotation('1w+2h-3#q12e-12s');
  assert.deepEqual(result.errors, []);
  assert.equal(result.totalBeats, 7.75);
  assert.deepEqual(result.notes.map(({ token }) => token), ['1w', '+2h', '-3#q', '12e', '-12s']);
  assert.deepEqual(result.notes.map(({ beats }) => beats), [4, 2, 1, 0.5, 0.25]);
  assert.deepEqual(result.notes.map(({ startBeat }) => startBeat), [0, 4, 6, 7, 7.5]);
  assert.deepEqual(result.notes.map(({ pitch }) => pitch), ['C4', 'E4', 'A#4', 'C7', 'B6']);
  assert.deepEqual(result.notes.map(({ draw }) => draw), [false, false, true, false, true]);
});

test('ignores whitespace within notes and retains exact original source ranges', () => {
  const source = ' \t- 3 # w \n| 1 2 e . \r\n0 q ';
  const result = parseNotation(source);
  assert.deepEqual(result.errors, []);
  assert.equal(result.totalBeats, 5.75);
  assert.deepEqual(result.notes.map(({ token }) => token), ['-3#w', '12e.', '0q']);
  assert.deepEqual(result.notes.map(({ start, end }) => source.slice(start, end)), ['- 3 # w', '1 2 e .', '0 q']);
});

test('L separates visual lines without requiring spaces or changing playback timing', () => {
  const result = parseNotation('1qL-3#wL0h');
  const withoutLines = parseNotation('1q-3#w0h');
  assert.deepEqual(result.errors, []);
  assert.equal(result.totalBeats, 7);
  assert.deepEqual(result.notes.map(({ token }) => token), ['1q', '-3#w', '0h']);
  assert.deepEqual(result.notes.map(({ startBeat, endBeat, pitch, isRest }) => ({ startBeat, endBeat, pitch, isRest })),
    withoutLines.notes.map(({ startBeat, endBeat, pitch, isRest }) => ({ startBeat, endBeat, pitch, isRest })));
});

test('L preserves source ranges with leading, repeated, and trailing line markers', () => {
  const source = 'L \t- 3 # w L\nL 1 2 e . L\r\n0 q LL';
  const result = parseNotation(source);
  assert.deepEqual(result.errors, []);
  assert.equal(result.totalBeats, 5.75);
  assert.deepEqual(result.notes.map(({ token }) => token), ['-3#w', '12e.', '0q']);
  assert.deepEqual(result.notes.map(({ start, end }) => source.slice(start, end)), ['- 3 # w', '1 2 e .', '0 q']);
  assert.deepEqual(parseNotation('L L\nLL | L'), emptyScore);
});

test('L never joins malformed note fragments and recovery stops at each line boundary', () => {
  const source = '1LqL-#L2eL3#LwL4q';
  const result = parseNotation(source);
  assert.deepEqual(result.notes.map(({ token }) => token), ['2e', '4q']);
  assert.deepEqual(result.errors.map(({ start, end }) => source.slice(start, end)), ['1', 'q', '-#', '3#', 'w']);
  assert.equal(result.totalBeats, 1.5);
  for (const input of ['1Lq', '-L3q', '1L2q', '1#Lq', '1qL.']) {
    assert.ok(parseNotation(input).errors.length > 0, input);
  }
  assert.ok(parseNotation('1ql2q').errors.length > 0, 'lowercase l is not a line marker');
});

test('all 12 holes use the three-octave C solo layout', () => {
  const blows = Array.from({ length: 12 }, (_, index) => pitchFor(index + 1).pitch);
  const draws = Array.from({ length: 12 }, (_, index) => pitchFor(index + 1, true).pitch);
  assert.deepEqual(blows, ['C4', 'E4', 'G4', 'C5', 'C5', 'E5', 'G5', 'C6', 'C6', 'E6', 'G6', 'C7']);
  assert.deepEqual(draws, ['D4', 'F4', 'A4', 'B4', 'D5', 'F5', 'A5', 'B5', 'D6', 'F6', 'A6', 'B6']);
  for (let hole = 1; hole <= 12; hole += 1) {
    for (const draw of [false, true]) {
      const sliderInterval = hole === 12 && draw ? 3 : 1;
      assert.equal(pitchFor(hole, draw, true).midi, pitchFor(hole, draw).midi + sliderInterval);
    }
  }
  assert.deepEqual(pitchFor(12, true, true), { midi: 98, pitch: 'D7' });
});

test('rests advance time without producing a pitch and dots extend each duration', () => {
  const result = parseNotation('0w.1h.0q.2e.0s.');
  assert.deepEqual(result.errors, []);
  assert.equal(result.totalBeats, 11.625);
  assert.deepEqual(result.notes.map(({ beats }) => beats), [6, 3, 1.5, 0.75, 0.375]);
  for (const note of result.notes.filter(({ isRest }) => isRest)) {
    assert.equal(note.midi, null);
    assert.equal(note.pitch, null);
    assert.equal(note.draw, false);
    assert.equal(note.slider, false);
  }
});

test('repeated identical tokens have distinct indices, IDs, ranges, and times', () => {
  const result = parseNotation('1q 1q1q | 1q');
  assert.equal(new Set(result.notes.map(({ id }) => id)).size, 4);
  assert.deepEqual(result.notes.map(({ index }) => index), [0, 1, 2, 3]);
  assert.deepEqual(result.notes.map(({ start, end }) => [start, end]), [[0, 2], [3, 5], [5, 7], [10, 12]]);
  assert.deepEqual(result.notes.map(({ endBeat }) => endBeat), [1, 2, 3, 4]);
});

test('invalid holes and decorated rests report whole-token ranges', () => {
  for (const source of ['13q', '123q', '01q', '00h', '-0q', '+0s', '0#w']) {
    const result = parseNotation(source);
    assert.equal(result.notes.length, 0, source);
    assert.equal(result.errors.length, 1, source);
    assert.equal(result.errors[0].start, 0, source);
    assert.equal(result.errors[0].end, source.length, source);
    assert.equal(result.totalBeats, 0, source);
  }
});

test('malformed syntax is never silently accepted', () => {
  for (const source of ['1', '-', '#1q', '1x', '1##q', '1q..', '--1q', '1q,2q', 'hello', '1Q']) {
    assert.ok(parseNotation(source).errors.length > 0, source);
  }
});

test('errors preserve source ranges while later valid notes remain editable', () => {
  const source = '1q | - 0 # h | 2e whoops -3q';
  const result = parseNotation(source);
  assert.deepEqual(result.notes.map(({ token }) => token), ['1q', '2e', '-3q']);
  assert.deepEqual(result.errors.map(({ start, end }) => source.slice(start, end)), ['- 0 # h', 'whoops']);
  assert.equal(result.totalBeats, 2.5);
});

test('empty input and separators are valid empty compositions', () => {
  assert.deepEqual(parseNotation(''), emptyScore);
  assert.deepEqual(parseNotation(' | \n\t | '), emptyScore);
});

test('score headers set timing without becoming notes or contributing beats', () => {
  const source = 'TEMPO 120\nTSIG 6/8\n1q-3#eL0h';
  const result = parseNotation(source);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tempo, 120);
  assert.equal(result.numerator, 6);
  assert.equal(result.denominator, 8);
  assert.equal(result.totalBeats, 3.5);
  assert.deepEqual(result.notes.map(({ token, index, id, startBeat }) => ({ token, index, id, startBeat })), [
    { token: '1q', index: 0, id: 'note-0', startBeat: 0 },
    { token: '-3#e', index: 1, id: 'note-1', startBeat: 1 },
    { token: '0h', index: 2, id: 'note-2', startBeat: 1.5 },
  ]);
  assert.deepEqual(result.notes.map(({ start, end }) => source.slice(start, end)), ['1q', '-3#e', '0h']);
  assert.deepEqual(result.directives.map(({ kind, start, end, valid }) => ({ kind, text: source.slice(start, end), valid })), [
    { kind: 'tempo', text: 'TEMPO 120', valid: true },
    { kind: 'time-signature', text: 'TSIG 6/8', valid: true },
  ]);
});

test('headers accept TEMP alias, mixed case, blank lines, spaces and CRLF', () => {
  const source = '\r\n  tSiG\t 12 / 16  \r\n\r\n\tTeMp  90\r\n\t- 3 # q \r\nL 2h';
  const result = parseNotation(source);
  assert.deepEqual(result.errors, []);
  assert.deepEqual([result.tempo, result.numerator, result.denominator], [90, 12, 16]);
  assert.deepEqual(result.notes.map(({ start, end }) => source.slice(start, end)), ['- 3 # q', '2h']);
  assert.deepEqual(result.notes.map(({ index, startBeat }) => [index, startBeat]), [[0, 0], [1, 1]]);
});

test('each header is optional and missing values use tempo 60 and 4/4', () => {
  for (const [source, expected] of [
    ['1q', [60, 4, 4]],
    ['TEMPO 30\n1q', [30, 4, 4]],
    ['TEMPO 300\n1q', [300, 4, 4]],
    ['TSIG 32/2\n1q', [60, 32, 2]],
    ['TSIG 1/16', [60, 1, 16]],
  ]) {
    const result = parseNotation(source);
    assert.deepEqual(result.errors, [], source);
    assert.deepEqual([result.tempo, result.numerator, result.denominator], expected, source);
  }
});

test('malformed headers stay outside the timeline and report their source ranges', () => {
  for (const header of ['TEMPO', 'TEMPO120', 'TEMP 1q', 'TEMPO 29', 'TEMPO 301', 'TEMPO 60.5', 'TEMPO -60',
    'TSIG', 'TSIG6/8', 'TSIG 0/4', 'TSIG 33/4', 'TSIG 4/3', 'TSIG 4.5/4', 'TSIG 4/4 2q', 'TSIG 4/']) {
    const source = `  ${header}\n-3#q`;
    const result = parseNotation(source);
    assert.equal(result.errors.length, 1, header);
    assert.equal(source.slice(result.errors[0].start, result.errors[0].end), header);
    assert.deepEqual(result.notes.map(({ token }) => token), ['-3#q'], header);
    assert.equal(result.totalBeats, 1, header);
    assert.deepEqual([result.tempo, result.numerator, result.denominator], [60, 4, 4], header);
    assert.equal(result.directives[0].valid, false, header);
  }
});

test('duplicate headers include the TEMP alias and do not replace earlier settings', () => {
  const result = parseNotation('TEMPO 120\nTEMP 90\nTSIG 6/8\nTSIG 3/4\n1q');
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every(error => error.message.startsWith('Use only one')));
  assert.deepEqual([result.tempo, result.numerator, result.denominator], [120, 6, 8]);
  assert.deepEqual(result.directives.map(({ valid }) => valid), [true, false, true, false]);
  assert.equal(result.totalBeats, 1);
});

test('headers after notes or beside notes report placement errors without eating neighboring notes', () => {
  const source = '1q\nTEMPO 90\n2q TSIG 3/4\n-3h';
  const result = parseNotation(source);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every(error => error.message.includes('before the notes')));
  assert.deepEqual(result.errors.map(({ start, end }) => source.slice(start, end)), ['TEMPO 90', 'TSIG 3/4']);
  assert.deepEqual(result.notes.map(({ token }) => token), ['1q', '2q', '-3h']);
  assert.deepEqual([result.tempo, result.numerator, result.denominator], [60, 4, 4]);
  assert.equal(result.totalBeats, 4);
});

test('a misplaced header cannot join incomplete note fragments across its line', () => {
  const result = parseNotation('1\nTEMPO 120\nq\n2e');
  assert.deepEqual(result.notes.map(({ token }) => token), ['2e']);
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors[0].start < result.errors[1].start);
  assert.ok(result.errors[1].start < result.errors[2].start);
});

test('pitch inputs and duration formatting handle boundary values', () => {
  assert.deepEqual(pitchFor(0), { midi: null, pitch: null });
  for (const hole of [-1, 13, 1.5, NaN, '1']) assert.throws(() => pitchFor(hole), RangeError);
  assert.throws(() => parseNotation(null), TypeError);
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(59.9), '0:59');
  assert.equal(formatDuration(60), '1:00');
  assert.equal(formatDuration(3601), '60:01');
  assert.equal(formatDuration(-10), '0:00');
  assert.equal(formatDuration(Infinity), '0:00');
});
