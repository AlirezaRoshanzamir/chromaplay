import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteEditor, editorSegments, replaceNotation } from './note-editor.js';

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

test('timing directives become compact chips and preserve every physical line', () => {
  const source = ' \tTEMPO 120\r\n\nTSIG 6 / 8\r\n1q -3#eL\n0h';
  const result = editorSegments(source);
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'note').map(segment => segment.note.token), ['1q', '-3#e', '0h']);
  assert.deepEqual(result.segments[0], { type: 'text', text: ' \t', start: 0, end: 2 });
  assert.deepEqual(result.segments.filter(segment => segment.type === 'directive').map(segment => [segment.text, segment.directive.kind]), [
    ['TEMPO 120', 'tempo'], ['TSIG 6 / 8', 'time-signature'],
  ]);
  assert.equal(result.segments.filter(segment => segment.type === 'line-break').length, 1);
  for (const segment of result.segments) assert.equal(source.slice(segment.start, segment.end), segment.text);
});

test('invalid timing values remain plain editable text', () => {
  const source = 'TEMPO nope\nTSIG 0/4\n3qL4q';
  const result = editorSegments(source);
  assert.equal(result.errors.length, 2);
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
  assert.equal(result.segments.filter(segment => segment.type === 'directive').length, 0);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'note').map(segment => segment.note.token), ['3q', '4q']);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'line-break').map(segment => segment.start), [source.lastIndexOf('L')]);
});

test('inline timing chips preserve spelling and have no note width or duration', () => {
  const source = '1q  temp\t90 TSIG 6 / 8 -2eL\nTEMPO 120 3h';
  const result = editorSegments(source);
  assert.equal(result.errors.length, 0);
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'directive').map(segment => [segment.text, segment.directive.beat]), [
    ['temp\t90', 1], ['TSIG 6 / 8', 1], ['TEMPO 120', 1.5],
  ]);
  assert.deepEqual(result.notes.map(note => note.token), ['1q', '-2e', '3h']);
  assert.equal(result.totalBeats, 3.5);
  for (const segment of result.segments) assert.equal(source.slice(segment.start, segment.end), segment.text);
});

test('opening a timing chip exposes its exact source without opening neighboring tokens', () => {
  const source = '1q temp\t90 TSIG 6 / 8 -2h';
  const initial = editorSegments(source);
  const target = initial.directives[0];
  const result = editorSegments(source, { start: target.start, end: target.end });
  assert.equal(result.segments.map(segment => segment.text).join(''), source);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'directive').map(segment => segment.text), ['TSIG 6 / 8']);
  assert.deepEqual(result.segments.filter(segment => segment.type === 'note').map(segment => segment.text), ['1q', '-2h']);
  assert.ok(result.segments.some(segment => segment.type === 'text' && segment.text.includes('temp\t90')));
});

// Exercise the editor's editing and clipboard handlers without emulating browser
// layout. Browser checks cover contenteditable selection and actual chip sizing.
function editingHarness(source) {
  const editor = Object.create(NoteEditor.prototype);
  let selection = { anchor: source.length, focus: source.length };
  Object.assign(editor, {
    source, activeRange: null, undoStack: [], redoStack: [], lastEdit: null,
    composing: false, chips: new Map(), directiveChips: new Map(),
    selection: () => ({ ...selection }),
    restoreSelection: value => { selection = { ...value }; },
    revealCaret: () => {},
    render(value = null) {
      this.score = editorSegments(this.source, this.activeRange);
      this.chips = new Map(this.score.segments.filter(segment => segment.type === 'note').map(segment => [segment.note.index, {}]));
      this.directiveChips = new Map(this.score.segments.filter(segment => segment.type === 'directive').map(segment => [segment.start, {}]));
      if (value) selection = { ...value };
    },
  });
  editor.render();
  const input = (data, inputType = 'insertText') => {
    let prevented = false;
    editor.beforeInput({ data, inputType, cancelable: true, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  };
  return { editor, input, select: (anchor, focus = anchor) => { selection = { anchor, focus }; } };
}

test('clicking a timing chip opens the whole directive and spaces remain editable', () => {
  const source = '1q TEMPO 90 TSIG 6/8 2q';
  const { editor, input, select } = editingHarness(source);
  const directive = editor.score.directives[0];
  const chip = { dataset: { sourceStart: String(directive.start) }, classList: { contains: value => value === 'timing-chip' } };
  let prevented = false;
  editor.pointerDown({ button: 0, shiftKey: false, target: { closest: selector => selector.includes('.timing-chip') ? chip : null }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(editor.activeRange, { start: directive.start, end: directive.end });
  assert.deepEqual(editor.selection(), { anchor: directive.end, focus: directive.end });
  assert.equal(editor.directiveChips.has(directive.start), false);
  select(source.indexOf('90'));
  input(' ');
  assert.equal(editor.source, '1q TEMPO  90 TSIG 6/8 2q');
  assert.ok(editor.activeRange);
  assert.equal(editor.directiveChips.has(directive.start), false);
  editor.keyDown({ key: 'Tab' });
  assert.equal(editor.activeRange, null);
  assert.equal(editor.directiveChips.has(directive.start), true);
});

test('typing a directive keeps its keyword and value together until a trailing separator', () => {
  const { editor, input } = editingHarness('');
  for (const character of 'TEMPO 120') input(character);
  assert.equal(editor.source, 'TEMPO 120');
  assert.deepEqual(editor.activeRange, { start: 0, end: 9 });
  assert.equal(editor.directiveChips.size, 0);
  input(' ');
  assert.equal(editor.activeRange, null);
  assert.equal(editor.directiveChips.size, 1);
  for (const character of 'TSIG 6 / 8') input(character);
  assert.equal(editor.source, 'TEMPO 120 TSIG 6 / 8');
  assert.ok(editor.activeRange);
  input(null, 'insertParagraph');
  assert.equal(editor.source, 'TEMPO 120 TSIG 6 / 8\n');
  assert.equal(editor.activeRange, null);
  assert.equal(editor.directiveChips.size, 2);
});

test('backspace opens a timing chip before editing its text and undo restores source and selection', () => {
  const source = '1q TSIG 6 / 8';
  const { editor, input } = editingHarness(source);
  input(null, 'deleteContentBackward');
  assert.equal(editor.source, source);
  assert.deepEqual(editor.activeRange, { start: 3, end: source.length });
  input(null, 'deleteContentBackward');
  assert.equal(editor.source, '1q TSIG 6 / ');
  assert.equal(editor.directiveChips.size, 0);
  assert.ok(editor.score.errors.length);
  editor.history(-1);
  assert.equal(editor.source, source);
  assert.deepEqual(editor.selection(), { anchor: source.length, focus: source.length });
  assert.deepEqual(editor.activeRange, { start: 3, end: source.length });
  editor.history(1);
  assert.equal(editor.source, '1q TSIG 6 / ');
});

test('copy, cut, paste and undo preserve timing spelling and line markers', () => {
  const source = 'TEMP\t90\r\n1qL TSIG 6 / 8\n-2e';
  const { editor, select } = editingHarness(source);
  const clipboard = new Map();
  const event = { preventDefault() {}, clipboardData: { setData: (type, value) => clipboard.set(type, value), getData: type => clipboard.get(type) } };
  select(0, source.length);
  editor.copy(event);
  assert.equal(clipboard.get('text/plain'), source);
  assert.equal(editor.source, source);
  editor.copy(event, true);
  assert.equal(editor.source, '');
  editor.history(-1);
  assert.equal(editor.source, source);
  assert.deepEqual(editor.selection(), { anchor: 0, focus: source.length });
  editor.paste(event);
  assert.equal(editor.source, source);
  assert.equal(editor.score.segments.map(segment => segment.text).join(''), source);
  assert.equal(editor.directiveChips.size, 2);
});

test('DOM source positions and native edits use directive source rather than its compact label', () => {
  const raw = 'temp\t  90';
  const source = `1q ${raw}\n2q`;
  const { editor } = editingHarness(source);
  const text = data => ({ nodeType: 3, data });
  const element = (className, dataset, children = []) => {
    const node = {
      nodeType: 1, tagName: 'SPAN', dataset, childNodes: children,
      hasAttribute: () => false,
      matches: selector => selector.split(', ').includes(`.${className}`),
      closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); },
      contains(child) { return child === this || children.some(candidate => candidate === child || candidate.contains?.(child)); },
    };
    children.forEach((child, index) => {
      child.parentNode = node;
      child.parentElement = node;
      child.previousSibling = children[index - 1];
    });
    return node;
  };
  const label = text('TEMPO 90');
  const chip = element('timing-chip', { source: raw }, [label]);
  const before = text('1q ');
  const after = text('\n2q');
  editor.editor = element('editor', {}, [before, chip, after]);
  assert.equal(editor.offsetAt(label, 0), 3);
  assert.equal(editor.offsetAt(label, label.data.length), 3 + raw.length);
  assert.deepEqual(editor.pointAt(3 + raw.length), { node: after, offset: 0 });
  after.data += '\nTSIG 3/4';
  editor.nativeInput();
  assert.equal(editor.source, `${source}\nTSIG 3/4`);
  assert.equal(editor.score.segments.map(segment => segment.text).join(''), editor.source);
  editor.history(-1);
  assert.equal(editor.source, source);
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
