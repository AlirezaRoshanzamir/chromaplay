import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotation, pitchFor, formatDuration, updateScoreTiming } from './notation.js';

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

test('malformed directives stay outside the timeline and report their source ranges', () => {
  for (const header of ['TEMPO', 'TEMPO120', 'TEMPO 29', 'TEMPO 301', 'TEMPO 60.5', 'TEMPO -60',
    'TSIG', 'TSIG6/8', 'TSIG 0/4', 'TSIG 33/4', 'TSIG 4/3', 'TSIG 4.5/4', 'TSIG 4/']) {
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

test('repeated initial directives use the last valid value of each kind', () => {
  const result = parseNotation('TEMPO 120\nTEMP 90\nTSIG 6/8\nTSIG 3/4\n1q');
  assert.deepEqual(result.errors, []);
  assert.deepEqual([result.tempo, result.numerator, result.denominator], [90, 3, 4]);
  assert.deepEqual(result.directives.map(({ valid, beat }) => [valid, beat]), [[true, 0], [true, 0], [true, 0], [true, 0]]);
  assert.equal(result.totalBeats, 1);
  const invalidLast = parseNotation('TEMPO 120 TEMP wrong TSIG 6/8 TSIG 0/4 1q');
  assert.deepEqual([invalidLast.tempo, invalidLast.numerator, invalidLast.denominator], [120, 6, 8]);
});

test('directives after notes take effect at their current beat and retain the initial defaults', () => {
  const source = '1q\nTEMPO 90\n2q TSIG 3/4\n-3h';
  const result = parseNotation(source);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.directives.map(({ start, end, beat }) => [source.slice(start, end), beat]), [['TEMPO 90', 1], ['TSIG 3/4', 2]]);
  assert.deepEqual(result.notes.map(({ token }) => token), ['1q', '2q', '-3h']);
  assert.deepEqual([result.tempo, result.numerator, result.denominator], [60, 4, 4]);
  assert.equal(result.totalBeats, 4);
});

test('a timing directive cannot join incomplete note fragments across its position', () => {
  const result = parseNotation('1\nTEMPO 120\nq\n2e');
  assert.deepEqual(result.notes.map(({ token }) => token), ['2e']);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors[0].start < result.errors[1].start);
  assert.equal(result.directives[0].beat, 0);
});

test('inline changes retain exact ranges and work beside notes and visual line markers', () => {
  const source = 'TEMPO 60\tTSIG 4 / 4  1qTEMPO 120-1q L TSIG 6/8\t2eLTEMP 90L0h';
  const result = parseNotation(source);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.notes.map(({ token, startBeat }) => [token, startBeat]), [['1q', 0], ['-1q', 1], ['2e', 2], ['0h', 2.5]]);
  assert.deepEqual(result.directives.map(({ start, end, beat }) => [source.slice(start, end), beat]), [
    ['TEMPO 60', 0], ['TSIG 4 / 4', 0], ['TEMPO 120', 1], ['TSIG 6/8', 2], ['TEMP 90', 2.5],
  ]);
  assert.equal(result.totalBeats, 4.5);
  assert.deepEqual([result.tempo, result.numerator, result.denominator], [60, 4, 4]);
});

test('incomplete timing values do not swallow the next note or directive', () => {
  for (const [source, invalid, tokens] of [
    ['1q TEMP 2e TEMPO 90 -3q', ['TEMP'], ['1q', '2e', '-3q']],
    ['TEMPO TSIG 6/8 1q', ['TEMPO'], ['1q']],
    ['TSIG 4/ 2q TEMPO 120 3q', ['TSIG 4/'], ['2q', '3q']],
    ['1q TEMPO wrong -2q TSIG 4/3 3q', ['TEMPO wrong', 'TSIG 4/3'], ['1q', '-2q', '3q']],
    ['TEMPO\n1q TSIG\n2q', ['TEMPO', 'TSIG'], ['1q', '2q']],
  ]) {
    const result = parseNotation(source);
    assert.deepEqual(result.errors.map(({ start, end }) => source.slice(start, end)), invalid, source);
    assert.deepEqual(result.notes.map(note => note.token), tokens, source);
  }
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

test('timing controls preserve TEMP spelling, formatting, CRLF and every body character', () => {
  const body = '\r\n 1qL - 3 # h.\t| 0e \r\n-2';
  const source = ` \ttEmP\t 090  \r\n tSiG  6 / 8\t\r\n${body}`;
  const updated = updateScoreTiming(source, { tempo: 120, numerator: 3 });
  assert.equal(updated, ` \ttEmP\t 120  \r\n tSiG  3 / 8\t\r\n${body}`);
  assert.equal(updateScoreTiming(updated, { tempo: 120, numerator: 3 }), updated);
  assert.equal(updateScoreTiming(source, { tempo: 90, numerator: 6, denominator: 8 }), source);
});

test('missing timing controls insert only requested headers in tempo then signature order', () => {
  const body = '\n 1q L-3#q\n\n0h ';
  assert.equal(updateScoreTiming(body, { tempo: 60 }), `TEMPO 60\n${body}`);
  assert.equal(updateScoreTiming(body, { numerator: 6 }), `TSIG 6/4\n${body}`);
  assert.equal(updateScoreTiming(body, { denominator: 8 }), `TSIG 4/8\n${body}`);
  assert.equal(updateScoreTiming(body, { tempo: 90, numerator: 6, denominator: 8 }), `TEMPO 90\nTSIG 6/8\n${body}`);
  assert.equal(updateScoreTiming(`TSIG 6/8\n${body}`, { tempo: 90 }), `TEMPO 90\nTSIG 6/8\n${body}`);
  assert.equal(updateScoreTiming(`TEMP 70\r\n${body}`, { denominator: 8 }), `TEMP 70\r\nTSIG 4/8\r\n${body}`);
  assert.equal(updateScoreTiming('TEMP 70', { numerator: 3 }), 'TEMP 70\nTSIG 3/4\n');
  assert.equal(updateScoreTiming('', { tempo: 90, numerator: 6, denominator: 8 }), 'TEMPO 90\nTSIG 6/8\n');
});

test('controls repair simple malformed headers without normalizing other invalid settings', () => {
  const source = '  TEMP\twrong  \nTSIG 6/3\n1q -3#';
  const changed = updateScoreTiming(source, { tempo: 80 });
  assert.equal(changed, '  TEMP\t80  \nTSIG 6/3\n1q -3#');
  assert.equal(updateScoreTiming(changed, { numerator: 5 }), '  TEMP\t80  \nTSIG 5/3\n1q -3#');
  assert.equal(updateScoreTiming(changed, { denominator: 8 }), '  TEMP\t80  \nTSIG 6/8\n1q -3#');
  assert.equal(updateScoreTiming('TEMPO60\nTSIG wrong\n1q', { numerator: 3 }), 'TEMPO60\nTSIG 3/4\n1q');
  assert.equal(updateScoreTiming('TEMPO60\n1q', { tempo: 90 }), 'TEMPO 90\n1q');
});

test('controls update only the effective initial directive and preserve every later change', () => {
  const duplicate = 'TEMPO 60\nTEMP 80\nTSIG 3/4\n1q';
  const updated = updateScoreTiming(duplicate, { tempo: 90 });
  assert.equal(updated, 'TEMPO 60\nTEMP 90\nTSIG 3/4\n1q');
  assert.deepEqual(parseNotation(updated).errors, []);
  const misplaced = '1q\nTEMPO 80\n-3#h';
  const fixedTop = updateScoreTiming(misplaced, { tempo: 90 });
  assert.equal(fixedTop, `TEMPO 90\n${misplaced}`);
  assert.deepEqual(parseNotation(fixedTop).errors, []);
  assert.equal(updateScoreTiming('1q TEMPO 60\n2q', { tempo: 90 }), 'TEMPO 90\n1q TEMPO 60\n2q');
  const mixed = 'TEMPO 60 TSIG 3/4 TSIG 6/8 1q TEMPO 120 TSIG 2/4 -3#h';
  assert.equal(updateScoreTiming(mixed, { tempo: 90, numerator: 5 }), 'TEMPO 90 TSIG 3/4 TSIG 5/8 1q TEMPO 120 TSIG 2/4 -3#h');
  assert.equal(updateScoreTiming('TEMPO 60 TEMP wrong 1q', { tempo: 90 }), 'TEMPO 90 TEMP wrong 1q');
});

test('inline timing controls preserve complete notes, incomplete notes, and neighboring directives', () => {
  for (const source of ['TEMPO 90 1q\n2h', 'TEMP 1 q L\n2h', 'TEMPO 60 TSIG 4/4\n1q',
    'TEMPO 90 -3#\n2q', 'TEMPO 90 -\n2q', 'TEMP 90 1\n2q', 'TEMPO 90 | 1\n2q']) {
    const parsed = parseNotation(source);
    const target = parsed.directives[0];
    const updated = updateScoreTiming(source, { tempo: 90 });
    assert.ok(updated.endsWith(source.slice(target.end)), source);
  }
  assert.equal(updateScoreTiming('TSIG 4/4 -3#q\n1q', { denominator: 8 }), 'TSIG 4/8 -3#q\n1q');
  assert.equal(updateScoreTiming('TSIG 4/4 | 1\n2q', { numerator: 3 }), 'TSIG 3/4 | 1\n2q');
});

test('timing patches reject invalid values and leave empty patches unchanged', () => {
  const source = 'TEMPO 60\n1q';
  assert.equal(updateScoreTiming(source, {}), source);
  for (const patch of [null, [], '90', { bpm: 90 }, { tempo: '90' }, { tempo: 29 }, { tempo: 301 },
    { tempo: 90.5 }, { numerator: 0 }, { numerator: 33 }, { denominator: 3 }, { denominator: null },
    { tempo: 90, numerator: NaN }]) {
    assert.throws(() => updateScoreTiming(source, patch), { name: /TypeError|RangeError/ }, JSON.stringify(patch));
  }
  assert.throws(() => updateScoreTiming(null, { tempo: 90 }), TypeError);
});
