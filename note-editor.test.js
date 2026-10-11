import test from 'node:test';
import assert from 'node:assert/strict';
import { editorSegments, replaceNotation } from './note-editor.js';

test('chip rendering preserves every source character and all line breaks', () => {
  const source = '\t 1q  - 3 # h. |\r\n\n12s0e\t+2w \n';
  const result = editorSegments(source);
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'note').map(segment => segment.note.token), ['1q', '-3#h.', '12s', '0e', '+2w']);
  for (const segment of result.segments) assert.equal(source.slice(segment.start, segment.end), segment.text);
});

test('opening one chip preserves neighbors and exposes its original spelling', () => {
  const source = '1q - 3 # h. 12s';
  const result = editorSegments(source, { start: 3, end: 10 });
  assert.deepEqual(result.segments.filter(segment => segment.type === 'note').map(segment => segment.note.token), ['1q', '12s']);
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
  assert.ok(result.segments.some(segment => segment.type === 'text' && segment.text.includes('- 3 # h.')));
});

test('literal newlines inside a note keep that note raw and retain line layout', () => {
  const source = '1q -3\n#h 2s';
  const result = editorSegments(source);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'note').map(segment => segment.note.token), ['1q', '2s']);
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
});

test('unfinished and invalid text stays editable beside compact valid notes', () => {
  const source = '1q2s -3# 99q 4h';
  const result = editorSegments(source);
  assert.ok(result.errors.length > 0);
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'note').map(segment => segment.note.token), ['1q', '2s', '4h']);
});

test('source edits replace backwards selections and keep pasted whitespace intact', () => {
  assert.deepEqual(replaceNotation('1q 2q\n3q', 5, 3, '-12#s\n\n'), { source: '1q -12#s\n\n\n3q', caret: 10 });
  assert.deepEqual(replaceNotation('1q', 2, 2, '\n'), { source: '1q\n', caret: 3 });
  assert.deepEqual(replaceNotation('1q 2q', 0, 5, ''), { source: '', caret: 0 });
});

test('L markers split explicit rows without adding characters to the source', () => {
  const source = 'L1q -3#hL\t4sLL12w L';
  const result = editorSegments(source);
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'line-break').map(segment => segment.start), [0, 8, 12, 13, 18]);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'note').map(segment => segment.note.token), ['1q', '-3#h', '4s', '12w']);
  assert.equal(result.totalBeats, 7.25);
  assert.equal(result.errors.length, 0);
  for (const segment of result.segments) assert.equal(source.slice(segment.start, segment.end), segment.text);
});

test('line markers stay visible while editing notes and preserve physical blank lines', () => {
  const source = '1qL\r\n\n -3#h L2e';
  const result = editorSegments(source, { start: 7, end: 11 });
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
  assert.equal(result.segments.filter(segment => segment.type === 'line-break').length, 2);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'note').map(segment => segment.note.token), ['1q', '2e']);
  assert.ok(result.segments.some(segment => segment.type === 'text' && segment.text.includes('\r\n\n -3#h ')));
});

test('L boundaries remain editable beside unfinished notation and lowercase l is ordinary invalid text', () => {
  const source = '-3L#hL2el';
  const result = editorSegments(source);
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
  assert.equal(result.segments.filter(segment => segment.type === 'line-break').length, 2);
  assert.ok(result.errors.length > 0);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'note').map(segment => segment.note.token), ['2e']);
  assert.deepEqual(replaceNotation('1qL2q', 2, 3, ''), { source: '1q2q', caret: 2 });
  assert.deepEqual(replaceNotation('1qL2q', 2, 3, '\n'), { source: '1q\n2q', caret: 3 });
});

test('timing headers stay plain editable text and preserve every physical line', () => {
  const source = ' \tTEMPO 120\r\n\nTSIG 6 / 8\r\n1q -3#eL\n0h';
  const result = editorSegments(source);
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'note').map(segment => segment.note.token), ['1q', '-3#e', '0h']);
  assert.deepEqual(result.segments[0], { type: 'text', text: ' \tTEMPO 120\r\n\nTSIG 6 / 8\r\n', start: 0, end: source.indexOf('1q') });
  assert.equal(result.segments.filter(segment => segment.type === 'line-break').length, 1);
  for (const segment of result.segments) assert.equal(source.slice(segment.start, segment.end), segment.text);
});

test('invalid header values never become chips or visual L markers', () => {
  const source = 'TEMPO 1q L\nTSIG 4/4 2h\n3qL4q';
  const result = editorSegments(source);
  assert.equal(result.errors.length, 2);
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'note').map(segment => segment.note.token), ['3q', '4q']);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'line-break').map(segment => segment.start), [source.lastIndexOf('L')]);
});

test('editing a header changes timing while following chip indices and source ranges stay correct', () => {
  const source = 'TEMPO 60\nTSIG 4/4\n1q -3#h';
  const update = replaceNotation(source, source.indexOf('60'), source.indexOf('60') + 2, '120');
  const result = editorSegments(update.source);
  assert.equal(result.tempo, 120);
  assert.equal(result.segments.map(segment => segment.text).join(''), update.source);
  assert.deepEqual(result.notes.map(({ index, token }) => [index, token]), [[0, '1q'], [1, '-3#h']]);
  assert.deepEqual(result.notes.map(({ start, end }) => update.source.slice(start, end)), ['1q', '-3#h']);
  const opened = editorSegments(update.source, { start: result.notes[0].start, end: result.notes[0].end });
  assert.deepEqual(opened.segments.filter(segment => segment.type === 'note').map(segment => segment.note.token), ['-3#h']);
  assert.equal(opened.segments.map(segment => segment.text).join(''), update.source);
});
