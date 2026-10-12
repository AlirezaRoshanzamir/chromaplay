import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveScoreFormats, switchScoreFormat } from './score-formats.js';
import { parseNotation } from './notation.js';

const xmlSource = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Harmonica</part-name></score-part></part-list>
  <part id="P1"><measure number="1" implicit="yes">
    <attributes><divisions>8</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
    <direction><sound tempo="90"/></direction>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration><type>quarter</type></note>
  </measure></part>
</score-partwise>
`;

function project(patch = {}) {
  return { scoreFormat: 'dsl', notation: 'TEMPO 90\nTSIG 4/4\n1q -2h', musicxml: '', title: 'Practice', noteVolume: 42, backgroundOffset: -2, playbackRate: 0.75, ...patch };
}

const pitches = notation => parseNotation(notation).notes.map(note => note.midi);

test('DSL is authoritative while its XML view ignores old XML and preserves exact source text', () => {
  const notation = 'TEMP\t90\r\nTSIG 6 / 8\n+1q.L 0h\n';
  const original = project({ notation, musicxml: '<invalid old generated score>' });
  const before = structuredClone(original);
  const views = deriveScoreFormats(original);
  assert.equal(views.error, null);
  assert.equal(views.notation, notation);
  assert.match(views.musicxml, /<score-partwise/);
  assert.ok(Array.isArray(views.warnings));
  assert.deepEqual(original, before);
});

test('MusicXML is authoritative while its DSL view replaces stale notes and preserves XML bytes', () => {
  const original = project({ scoreFormat: 'musicxml', musicxml: xmlSource, notation: '12w' });
  const before = structuredClone(original);
  const views = deriveScoreFormats(original);
  assert.equal(views.error, null);
  assert.equal(views.musicxml, xmlSource);
  assert.deepEqual(pitches(views.notation), [60]);
  assert.equal(parseNotation(views.notation).tempo, 90);
  assert.deepEqual(original, before);
});

test('invalid main source retains the draft and clears the generated view', () => {
  const brokenDsl = project({ notation: '1q broken', musicxml: xmlSource });
  const dslViews = deriveScoreFormats(brokenDsl);
  assert.ok(dslViews.error);
  assert.equal(dslViews.notation, brokenDsl.notation);
  assert.equal(dslViews.musicxml, '');
  assert.deepEqual(dslViews.warnings, []);
  const brokenXml = project({ scoreFormat: 'musicxml', musicxml: '<score-partwise>', notation: '12w' });
  const xmlViews = deriveScoreFormats(brokenXml);
  assert.ok(xmlViews.error);
  assert.equal(xmlViews.notation, '');
  assert.equal(xmlViews.musicxml, brokenXml.musicxml);
  assert.deepEqual(xmlViews.warnings, []);
});

test('switching from DSL uses freshly generated XML and preserves the other project settings', () => {
  const original = project({ musicxml: xmlSource, notation: 'TEMPO 120\nTSIG 3/4\n-3#q 0h' });
  const before = structuredClone(original);
  const switched = switchScoreFormat(original, 'musicxml');
  assert.equal(switched.scoreFormat, 'musicxml');
  assert.notEqual(switched.musicxml, xmlSource);
  assert.equal(switched.notation, original.notation);
  const views = deriveScoreFormats(switched);
  assert.equal(views.error, null);
  assert.equal(views.notation, original.notation);
  assert.equal(switched.noteVolume, 42);
  assert.equal(switched.backgroundOffset, -2);
  assert.equal(switched.playbackRate, 0.75);
  assert.deepEqual(original, before);
});

test('switching from MusicXML replaces cached DSL and drops original XML only in the returned project', () => {
  const original = project({ scoreFormat: 'musicxml', musicxml: xmlSource, notation: '12w' });
  const before = structuredClone(original);
  const switched = switchScoreFormat(original, 'dsl');
  assert.equal(switched.scoreFormat, 'dsl');
  assert.equal(switched.musicxml, '');
  assert.deepEqual(pitches(switched.notation), [60]);
  assert.equal(switched.title, original.title);
  assert.equal(switched.noteVolume, original.noteVolume);
  assert.deepEqual(original, before);
});

test('switching rejects invalid conversions and unknown formats without mutating the draft', () => {
  for (const original of [project({ notation: 'no notes' }), project({ scoreFormat: 'musicxml', musicxml: '<unfinished' })]) {
    const before = structuredClone(original);
    assert.throws(() => switchScoreFormat(original, original.scoreFormat === 'dsl' ? 'musicxml' : 'dsl'));
    assert.deepEqual(original, before);
  }
  assert.throws(() => switchScoreFormat(project(), 'midi'), /Choose DSL or MusicXML/);
});

test('selecting the existing main format leaves an unfinished draft unchanged', () => {
  const original = project({ scoreFormat: 'musicxml', musicxml: '<unfinished', notation: '' });
  const result = switchScoreFormat(original, 'musicxml');
  assert.deepEqual(result, original);
  assert.notEqual(result, original);
});

test('legacy projects without a source-format field continue to use DSL', () => {
  const original = project();
  delete original.scoreFormat;
  const views = deriveScoreFormats(original);
  assert.equal(views.error, null);
  assert.equal(views.notation, original.notation);
  assert.match(views.musicxml, /<score-partwise/);
  assert.equal(switchScoreFormat(original, 'musicxml').scoreFormat, 'musicxml');
});
