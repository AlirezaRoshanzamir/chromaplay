import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROJECT, parseProjectFile, serializeProject, validateProject } from './project.js';
import { parseNotation } from './notation.js';

test('the default warm-up has 32 quarter beats and the requested settings', () => {
  assert.equal(DEFAULT_PROJECT.title, 'Morning warm-up');
  assert.equal(parseNotation(DEFAULT_PROJECT.notation).totalBeats, 32);
  assert.deepEqual(parseNotation(DEFAULT_PROJECT.notation).errors, []);
  assert.equal(DEFAULT_PROJECT.tempo, 90);
  assert.equal(DEFAULT_PROJECT.numerator, 4);
  assert.equal(DEFAULT_PROJECT.denominator, 4);
  assert.equal(DEFAULT_PROJECT.backgroundOffset, 0);
  assert.equal(DEFAULT_PROJECT.noteVolume, 70);
  assert.equal(DEFAULT_PROJECT.backgroundVolume, 65);
  assert.equal(DEFAULT_PROJECT.metronome, false);
  assert.equal(DEFAULT_PROJECT.loop, false);
});

test('JSON and .chroma round trips retain settings but never background audio', () => {
  const project = {
    ...DEFAULT_PROJECT,
    title: 'Slider study',
    notation: '-12#h. 0e 2e',
    tempo: 123,
    numerator: 6,
    denominator: 8,
    backgroundOffset: -2.125,
    noteVolume: 12,
    backgroundVolume: 81,
    metronome: true,
    loop: true,
  };
  const text = serializeProject({ ...project, backgroundTrack: 'blob:private-recording', other: 'discard' });
  assert.equal(JSON.parse(text).format, 'chromaplay');
  assert.ok(!text.includes('private-recording'));
  assert.ok(!text.includes('discard'));
  assert.ok(text.includes('\n  "title"'));
  assert.deepEqual(parseProjectFile(text, 'song.chroma'), project);
  assert.deepEqual(parseProjectFile(text, 'song.JSON'), project);
});

test('plain-text import uses its filename and defaults while preserving whitespace', () => {
  const notation = '\n 1 q | - 2 # h . \n';
  const imported = parseProjectFile(notation, 'Evening practice.txt');
  assert.deepEqual(imported, { ...DEFAULT_PROJECT, title: 'Evening practice', notation });
  assert.equal(parseProjectFile('1q', 'folder\\Study.TXT').title, 'Study');
  assert.equal(parseProjectFile('1q', '.txt').title, 'Untitled practice');
});

test('project and text imports preserve explicit L line markers exactly', () => {
  const notation = 'L 1w-3#q L\nL0h\t2eLL';
  const project = { ...DEFAULT_PROJECT, notation };
  assert.deepEqual(parseProjectFile(serializeProject(project), 'lines.chroma'), project);
  assert.equal(parseProjectFile(notation, 'lines.txt').notation, notation);
  assert.equal(parseNotation(notation).totalBeats, 7.5);
  assert.throws(() => parseProjectFile('1Lq', 'broken.txt'), /Invalid notation/);
});

test('missing optional fields default and missing version is accepted', () => {
  assert.deepEqual(validateProject({ notation: '1q' }), { ...DEFAULT_PROJECT, notation: '1q' });
  assert.deepEqual(validateProject({ notation: '', title: '' }), { ...DEFAULT_PROJECT, notation: '', title: '' });
  assert.notEqual(validateProject(DEFAULT_PROJECT), DEFAULT_PROJECT);
});

test('malformed files, unsupported versions, and foreign formats fail clearly', () => {
  assert.throws(() => parseProjectFile('{', 'bad.json'), /valid JSON/);
  for (const input of [null, [], 1, '1q', {}]) {
    assert.throws(() => parseProjectFile(JSON.stringify(input), 'bad.json'));
  }
  for (const version of [0, 2, '1', null]) {
    assert.throws(() => validateProject({ ...DEFAULT_PROJECT, version }), /version/);
  }
  assert.throws(() => validateProject({ ...DEFAULT_PROJECT, format: 'other-app' }), /not a ChromaPlay/);
  assert.throws(() => parseProjectFile('1q', 'notes.csv'), /\.txt/);
});

test('invalid notation is rejected on import and export, with a source location', () => {
  assert.throws(() => parseProjectFile('1q\n13w', 'invalid.txt'), /line 2, column 1/);
  assert.throws(() => parseProjectFile(JSON.stringify({ notation: '1x' }), 'invalid.json'), /Invalid notation/);
  assert.throws(() => serializeProject({ ...DEFAULT_PROJECT, notation: '-0q' }), /Invalid notation/);
});

test('autosave can restore an unfinished draft while still validating settings', () => {
  const draft = { ...DEFAULT_PROJECT, notation: '1q -3#' };
  assert.deepEqual(validateProject(draft, { allowInvalidNotation: true }), draft);
  assert.throws(() => validateProject({ ...draft, tempo: -1 }, { allowInvalidNotation: true }), /Tempo/);
  assert.throws(() => validateProject({ ...draft, notation: 123 }, { allowInvalidNotation: true }), /notation as text/);
});

test('numeric settings reject nonnumeric, nonfinite, out-of-range, and fractional integers', () => {
  const invalid = {
    tempo: [29, 301, 90.5, '90', null, NaN, Infinity],
    numerator: [0, 33, 4.5, '4'],
    denominator: [0, 1, 3, 32, '4', null],
    backgroundOffset: [-601, 601, '0', NaN, Infinity],
    noteVolume: [-1, 101, '70', NaN],
    backgroundVolume: [-1, 101, '65', Infinity],
  };
  for (const [field, values] of Object.entries(invalid)) {
    for (const value of values) {
      assert.throws(() => validateProject({ ...DEFAULT_PROJECT, [field]: value }), `${field}=${value}`);
    }
  }
  assert.doesNotThrow(() => validateProject({
    ...DEFAULT_PROJECT,
    tempo: 30,
    numerator: 32,
    denominator: 16,
    backgroundOffset: -600,
    noteVolume: 0,
    backgroundVolume: 100,
  }));
  assert.doesNotThrow(() => validateProject({ ...DEFAULT_PROJECT, tempo: 300, backgroundOffset: 600 }));
});

test('text and boolean fields enforce strict types and size limits', () => {
  for (const field of ['metronome', 'loop']) {
    for (const value of ['false', 0, 1, null]) {
      assert.throws(() => validateProject({ ...DEFAULT_PROJECT, [field]: value }));
    }
  }
  assert.throws(() => validateProject({ ...DEFAULT_PROJECT, title: 123 }), /title/);
  assert.throws(() => validateProject({ ...DEFAULT_PROJECT, title: 'x'.repeat(101) }), /100 characters/);
  assert.throws(() => validateProject({ ...DEFAULT_PROJECT, notation: ' '.repeat(100_001) }), /100,000/);
  assert.doesNotThrow(() => validateProject({ ...DEFAULT_PROJECT, notation: ' '.repeat(100_000), title: 'x'.repeat(100) }));
});

test('UTF-8 byte-order marks are accepted in text and JSON files', () => {
  assert.equal(parseProjectFile('\uFEFF1q', 'notes.txt').notation, '1q');
  assert.deepEqual(parseProjectFile(`\uFEFF${serializeProject(DEFAULT_PROJECT)}`, 'notes.chroma'), DEFAULT_PROJECT);
});
