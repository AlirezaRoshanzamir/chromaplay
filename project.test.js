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
  assert.equal(DEFAULT_PROJECT.instrument, 'fluid');
  assert.equal(DEFAULT_PROJECT.playbackRate, 1);
  assert.equal(DEFAULT_PROJECT.version, 5);
  assert.ok(DEFAULT_PROJECT.notation.startsWith('TEMPO 90\nTSIG 4/4\n'));
  assert.equal(DEFAULT_PROJECT.backgroundOffset, 0);
  assert.equal(DEFAULT_PROJECT.metronomeOffset, 0);
  assert.equal(DEFAULT_PROJECT.noteOffset, 0);
  assert.equal(DEFAULT_PROJECT.noteVolume, 70);
  assert.equal(DEFAULT_PROJECT.backgroundVolume, 65);
  assert.equal(DEFAULT_PROJECT.metronomeVolume, 70);
  assert.equal(DEFAULT_PROJECT.noteMuted, false);
  assert.equal(DEFAULT_PROJECT.backgroundMuted, false);
  assert.equal(DEFAULT_PROJECT.metronome, false);
  assert.equal(DEFAULT_PROJECT.loop, false);
});

test('JSON and .chroma round trips retain settings but never background audio', () => {
  const project = {
    ...DEFAULT_PROJECT,
    title: 'Slider study',
    notation: 'TEMPO 123\nTSIG 6/8\n-12#h. 0e 2e',
    tempo: 123,
    numerator: 6,
    denominator: 8,
    instrument: 'vcsl',
    playbackRate: 0.65,
    noteOffset: 1.375,
    backgroundOffset: -2.125,
    metronomeOffset: -0.625,
    noteVolume: 12,
    backgroundVolume: 81,
    metronomeVolume: 45,
    noteMuted: false,
    backgroundMuted: false,
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
  assert.deepEqual(imported, { ...DEFAULT_PROJECT, title: 'Evening practice', notation, tempo: 60 });
  assert.equal(parseProjectFile('1q', 'folder\\Study.TXT').title, 'Study');
  assert.equal(parseProjectFile('1q', '.txt').title, 'Untitled practice');
});

test('project and text imports preserve explicit L line markers exactly', () => {
  const notation = 'L 1w-3#q L\nL0h\t2eLL';
  const project = { ...DEFAULT_PROJECT, notation, tempo: 60 };
  assert.deepEqual(parseProjectFile(serializeProject(project), 'lines.chroma'), project);
  assert.equal(parseProjectFile(notation, 'lines.txt').notation, notation);
  assert.equal(parseNotation(notation).totalBeats, 7.5);
  assert.throws(() => parseProjectFile('1Lq', 'broken.txt'), /Invalid notation/);
});

test('missing optional fields default and missing version is accepted', () => {
  assert.deepEqual(validateProject({ notation: '1q' }), { ...DEFAULT_PROJECT, notation: '1q', tempo: 60 });
  assert.deepEqual(validateProject({ notation: '', title: '' }), { ...DEFAULT_PROJECT, notation: '', title: '', tempo: 60 });
  assert.notEqual(validateProject(DEFAULT_PROJECT), DEFAULT_PROJECT);
});

test('malformed files, unsupported versions, and foreign formats fail clearly', () => {
  assert.throws(() => parseProjectFile('{', 'bad.json'), /valid JSON/);
  for (const input of [null, [], 1, '1q', {}]) {
    assert.throws(() => parseProjectFile(JSON.stringify(input), 'bad.json'));
  }
  for (const version of [0, 6, '1', null]) {
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
  const draft = { ...DEFAULT_PROJECT, notation: '1q -3#', tempo: 60 };
  assert.deepEqual(validateProject(draft, { allowInvalidNotation: true }), draft);
  assert.throws(() => validateProject({ ...draft, noteVolume: -1 }, { allowInvalidNotation: true }), /Note volume/);
  assert.throws(() => validateProject({ ...draft, notation: 123 }, { allowInvalidNotation: true }), /notation as text/);
});

test('numeric settings reject nonnumeric, nonfinite, out-of-range, and fractional integers', () => {
  const invalid = {
    playbackRate: [0, -1, 0.249, 2.001, '1', null, NaN, Infinity, -Infinity],
    noteOffset: [-601, 601, '0', null, NaN, Infinity, -Infinity],
    backgroundOffset: [-601, 601, '0', null, NaN, Infinity, -Infinity],
    metronomeOffset: [-601, 601, '0', null, NaN, Infinity, -Infinity],
    noteVolume: [-1, 101, '70', NaN],
    backgroundVolume: [-1, 101, '65', Infinity],
    metronomeVolume: [-1, 101, '70', null, NaN, Infinity, -Infinity],
  };
  for (const [field, values] of Object.entries(invalid)) {
    for (const value of values) {
      assert.throws(() => validateProject({ ...DEFAULT_PROJECT, [field]: value }), `${field}=${value}`);
    }
  }
  assert.doesNotThrow(() => validateProject({
    ...DEFAULT_PROJECT,
    notation: 'TEMPO 30\nTSIG 32/16\n1q',
    noteOffset: 600,
    backgroundOffset: -600,
    noteVolume: 0,
    backgroundVolume: 100,
  }));
  assert.doesNotThrow(() => validateProject({ ...DEFAULT_PROJECT, notation: 'TEMPO 300\n1q', noteOffset: -600, backgroundOffset: 600 }));
});

test('text and boolean fields enforce strict types and size limits', () => {
  for (const field of ['metronome', 'loop', 'noteMuted', 'backgroundMuted']) {
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

test('old projects and plain-text imports start with both channels unmuted', () => {
  const { noteMuted, backgroundMuted, ...oldProject } = DEFAULT_PROJECT;
  const restored = validateProject(oldProject);
  assert.equal(restored.noteMuted, false);
  assert.equal(restored.backgroundMuted, false);
  for (const imported of [parseProjectFile(JSON.stringify(oldProject), 'old.chroma'), parseProjectFile('1q -1q', 'melody.txt')]) {
    assert.equal(imported.noteMuted, false);
    assert.equal(imported.backgroundMuted, false);
  }
});

test('each legacy mute combination becomes a visible zero volume with no hidden mute flag', () => {
  for (const noteMuted of [false, true]) {
    for (const backgroundMuted of [false, true]) {
      const project = { ...DEFAULT_PROJECT, noteMuted, backgroundMuted, noteVolume: 36, backgroundVolume: 82 };
      const expected = {
        ...project,
        noteVolume: noteMuted ? 0 : 36,
        backgroundVolume: backgroundMuted ? 0 : 82,
        noteMuted: false,
        backgroundMuted: false,
      };
      assert.deepEqual(validateProject(project, { allowInvalidNotation: true }), expected);
      assert.deepEqual(parseProjectFile(JSON.stringify(project), 'old-mix.chroma'), expected);
      assert.deepEqual(parseProjectFile(serializeProject(project), 'mix.chroma'), expected);
    }
  }
});

test('migrated mute volumes remain editable and never restore a hidden mute on save or export', () => {
  const restored = validateProject({ ...DEFAULT_PROJECT, noteMuted: true, backgroundMuted: true });
  assert.equal(restored.noteVolume, 0);
  assert.equal(restored.backgroundVolume, 0);
  const adjusted = { ...restored, noteVolume: 42, backgroundVolume: 73 };
  assert.deepEqual(validateProject(adjusted), adjusted);
  assert.deepEqual(parseProjectFile(serializeProject(adjusted), 'audible.chroma'), adjusted);
  assert.equal(adjusted.noteMuted, false);
  assert.equal(adjusted.backgroundMuted, false);
});

test('zero and nonzero slider volumes round-trip independently', () => {
  for (const noteVolume of [0, 36, 100]) {
    for (const backgroundVolume of [0, 82, 100]) {
      const project = { ...DEFAULT_PROJECT, noteVolume, backgroundVolume };
      assert.deepEqual(parseProjectFile(serializeProject(project), 'volumes.chroma'), project);
    }
  }
});

test('all sound choices round-trip, and unsupported choices are rejected', () => {
  for (const instrument of ['synth', 'fluid', 'vcsl']) {
    const project = { ...DEFAULT_PROJECT, instrument };
    assert.deepEqual(parseProjectFile(serializeProject(project), 'sound.chroma'), project);
  }
  for (const instrument of ['piano', '', null, 0]) {
    assert.throws(() => validateProject({ ...DEFAULT_PROJECT, instrument }), /Choose/);
  }
  const { instrument, ...oldProject } = DEFAULT_PROJECT;
  assert.equal(validateProject(oldProject).instrument, 'fluid');
});

test('version 1 and unversioned settings migrate into headers without changing notes', () => {
  const notation = '\n1q -2q L\n 3h 0e';
  for (const version of [undefined, 1]) {
    const oldProject = { notation, tempo: 123, numerator: 6, denominator: 8 };
    if (version !== undefined) oldProject.version = version;
    const migrated = validateProject(oldProject);
    assert.equal(migrated.version, 5);
    assert.equal(migrated.notation, `TEMPO 123\nTSIG 6/8\n${notation}`);
    assert.equal(migrated.tempo, 123);
    assert.equal(migrated.numerator, 6);
    assert.equal(migrated.denominator, 8);
    assert.deepEqual(parseNotation(migrated.notation).notes.map(({ token }) => token), ['1q', '-2q', '3h', '0e']);
    assert.deepEqual(validateProject(migrated), migrated);
    assert.deepEqual(parseProjectFile(serializeProject(migrated), 'old.chroma'), migrated);
  }
});

test('migration uses existing headers and fills only missing legacy settings', () => {
  const withTempo = validateProject({ version: 1, notation: 'TEMP 77\r\n1q', tempo: 90, numerator: 6, denominator: 8 });
  assert.equal(withTempo.notation, 'TEMP 77\r\nTSIG 6/8\n1q');
  assert.equal(withTempo.tempo, 77);
  assert.equal(withTempo.numerator, 6);
  const withSignature = validateProject({ version: 1, notation: 'TSIG 3/4\n1q', tempo: 80, numerator: 6, denominator: 8 });
  assert.equal(withSignature.notation, 'TEMPO 80\nTSIG 3/4\n1q');
  assert.equal(withSignature.numerator, 3);
  const both = 'TEMPO 55\nTSIG 2/4\n1q';
  assert.equal(validateProject({ version: 1, notation: both, tempo: 90, numerator: 6, denominator: 8 }).notation, both);
  assert.equal(validateProject({ version: 1, notation: '1q', denominator: 8 }).notation, 'TSIG 4/8\n1q');
});

test('deleting headers from a current project restores defaults without reinserting legacy fields', () => {
  const project = validateProject({ ...DEFAULT_PROJECT, notation: '1q', tempo: 120, numerator: 6, denominator: 8 });
  assert.equal(project.notation, '1q');
  assert.equal(project.tempo, 60);
  assert.equal(project.numerator, 4);
  assert.equal(project.denominator, 4);
  assert.deepEqual(parseProjectFile(serializeProject(project), 'defaults.chroma'), project);
});

test('current exports derive canonical settings from headers rather than stale numeric copies', () => {
  const json = JSON.parse(serializeProject({
    ...DEFAULT_PROJECT, notation: 'TEMPO 105\nTSIG 5/8\n1q', tempo: -1, numerator: 'old', denominator: null,
  }));
  assert.equal(json.tempo, 105);
  assert.equal(json.numerator, 5);
  assert.equal(json.denominator, 8);
  const text = parseProjectFile('TSIG 6/8\n1q', 'new.txt');
  assert.equal(text.tempo, 60);
  assert.equal(text.numerator, 6);
  assert.equal(text.denominator, 8);
});

test('invalid header drafts autosave exactly but cannot be exported or imported', () => {
  const notation = 'TEMPO \nTSIG 6/\n1q';
  const draft = validateProject({ ...DEFAULT_PROJECT, notation }, { allowInvalidNotation: true });
  assert.equal(draft.notation, notation);
  assert.equal(draft.tempo, 60);
  assert.equal(draft.numerator, 4);
  assert.equal(draft.denominator, 4);
  assert.deepEqual(validateProject(draft, { allowInvalidNotation: true }), draft);
  assert.throws(() => serializeProject(draft), /line 1/);
  assert.throws(() => parseProjectFile(notation, 'draft.txt'), /line 1/);
  const oldDraft = validateProject({ version: 1, notation, tempo: 90, numerator: 6, denominator: 8 }, { allowInvalidNotation: true });
  assert.equal(oldDraft.notation, notation);
});

test('legacy numeric settings validate before migration', () => {
  for (const [field, values] of Object.entries({
    tempo: [29, 301, 90.5, '90', null, NaN, Infinity],
    numerator: [0, 33, 4.5, '4'],
    denominator: [0, 1, 3, 32, '4', null],
  })) {
    for (const value of values) {
      assert.throws(() => validateProject({ version: 1, notation: '1q', [field]: value }), `${field}=${value}`);
    }
  }
});

test('version 2 projects keep their notation, sound, volumes, and track delay while adding zero note delay', () => {
  const notation = '\n 1qL -3#h\t0e \n';
  for (const instrument of ['synth', 'fluid', 'vcsl']) {
    const oldProject = {
      version: 2,
      title: 'Saved practice',
      notation,
      instrument,
      tempo: 120,
      numerator: 6,
      denominator: 8,
      noteVolume: 23,
      backgroundVolume: 47,
      backgroundOffset: -2.25,
    };
    const restored = parseProjectFile(JSON.stringify(oldProject), 'version-2.chroma');
    assert.equal(restored.version, 5);
    assert.equal(restored.notation, notation);
    assert.equal(restored.tempo, 60);
    assert.equal(restored.numerator, 4);
    assert.equal(restored.denominator, 4);
    assert.equal(restored.instrument, instrument);
    assert.equal(restored.noteVolume, 23);
    assert.equal(restored.backgroundVolume, 47);
    assert.equal(restored.backgroundOffset, -2.25);
    assert.equal(restored.noteOffset, 0);
    assert.deepEqual(parseProjectFile(serializeProject(restored), 'version-5.chroma'), restored);
  }
});

test('version 2 through 5 drafts retain text exactly without reinserting removed headers', () => {
  for (const version of [2, 3, 4, 5]) {
    for (const notation of ['1q', 'TEMPO \nTSIG 6/\n1q -3#', 'TEMP 75\r\nTSIG 3/8\r\n1q']) {
      const restored = validateProject({
        ...DEFAULT_PROJECT, version, notation, tempo: 120, numerator: 6, denominator: 8, noteOffset: -1.5,
      }, { allowInvalidNotation: true });
      assert.equal(restored.version, 5);
      assert.equal(restored.notation, notation);
      assert.equal(restored.noteOffset, -1.5);
      assert.deepEqual(validateProject(restored, { allowInvalidNotation: true }), restored);
    }
  }
});

test('note and track delays round-trip independently, including negative, fractional, and limit values', () => {
  for (const noteOffset of [-600, -2.125, 0, 1.375, 600]) {
    for (const backgroundOffset of [-600, -3.25, 0, 4.875, 600]) {
      const project = { ...DEFAULT_PROJECT, noteOffset, backgroundOffset };
      const exported = serializeProject(project);
      assert.equal(JSON.parse(exported).version, 5);
      assert.deepEqual(parseProjectFile(exported, 'delays.chroma'), project);
    }
  }
});

test('plain text and older projects default note delay to zero without changing the track delay', () => {
  for (const version of [undefined, 1, 2]) {
    const oldProject = { notation: '1q', backgroundOffset: 2.5 };
    if (version !== undefined) oldProject.version = version;
    const restored = validateProject(oldProject);
    assert.equal(restored.noteOffset, 0);
    assert.equal(restored.backgroundOffset, 2.5);
  }
  const imported = parseProjectFile('TEMPO 75\nTSIG 3/4\n1q', 'notes.txt');
  assert.equal(imported.noteOffset, 0);
  assert.equal(imported.backgroundOffset, 0);
});

test('empty scores can retain track-only settings without exporting the uploaded audio', () => {
  const project = validateProject({
    ...DEFAULT_PROJECT, notation: '', noteOffset: 4, backgroundOffset: -1.5, backgroundVolume: 53,
  });
  const exported = serializeProject({ ...project, backgroundTrack: 'blob:local-track', waveform: [1, 0.5] });
  assert.deepEqual(parseProjectFile(exported, 'track-only.chroma'), project);
  assert.equal(project.tempo, 60);
  assert.ok(!exported.includes('local-track'));
  assert.ok(!exported.includes('waveform'));
});

test('legacy metronome settings follow the old notes once, including zero volume and muted notes', () => {
  for (const version of [undefined, 1, 2, 3]) {
    for (const [noteVolume, noteMuted, expectedVolume] of [[0, false, 0], [42, false, 42], [70, true, 0]]) {
      const oldProject = {
        notation: 'TEMPO 75\nTSIG 3/4\n1q -2h', instrument: 'vcsl',
        noteOffset: -2.125, noteVolume, noteMuted, metronome: true,
        backgroundOffset: 4.75, backgroundVolume: 18,
      };
      if (version !== undefined) oldProject.version = version;
      const restored = parseProjectFile(JSON.stringify(oldProject), 'legacy.chroma');
      assert.equal(restored.version, 5);
      assert.equal(restored.metronomeOffset, -2.125);
      assert.equal(restored.metronomeVolume, expectedVolume);
      assert.equal(restored.metronome, true);
      assert.equal(restored.instrument, 'vcsl');
      assert.equal(restored.backgroundOffset, 4.75);
      assert.equal(restored.backgroundVolume, 18);
      assert.equal(restored.notation, oldProject.notation);
      const edited = { ...restored, noteOffset: 3, noteVolume: 100 };
      assert.deepEqual(parseProjectFile(serializeProject(edited), 'independent.chroma'), edited);
    }
  }
});

test('current scores default missing metronome settings independently of notes', () => {
  for (const version of [4, 5]) {
    const restored = validateProject({ version, notation: '1q', noteOffset: -3, noteVolume: 0 });
    assert.equal(restored.metronomeOffset, 0);
    assert.equal(restored.metronomeVolume, 70);
    assert.equal(restored.playbackRate, 1);
  }
  const imported = parseProjectFile('1q', 'notes.txt');
  assert.equal(imported.metronomeOffset, 0);
  assert.equal(imported.metronomeVolume, 70);
  const defaults = validateProject({ version: 3, notation: '1q' });
  assert.equal(defaults.metronomeOffset, 0);
  assert.equal(defaults.metronomeVolume, 70);
});

test('explicit metronome settings are preserved and validated even in older files', () => {
  for (const version of [1, 2, 3, 4, 5]) {
    const source = {
      version, notation: '1q', metronomeOffset: 0, metronomeVolume: 0,
      noteOffset: 12, noteVolume: 89,
    };
    const restored = validateProject(source);
    assert.equal(restored.metronomeOffset, 0);
    assert.equal(restored.metronomeVolume, 0);
    assert.throws(() => validateProject({ ...source, metronomeOffset: 601 }), /Metronome start delay/);
    assert.throws(() => validateProject({ ...source, metronomeVolume: 101 }), /Metronome volume/);
  }
});

test('metronome volume and delay round-trip at fractional values and both limits without clamping', () => {
  for (const metronomeOffset of [-600, -1.25, 0, 2.875, 600]) {
    for (const metronomeVolume of [0, 32.5, 100]) {
      const project = { ...DEFAULT_PROJECT, metronome: true, metronomeOffset, metronomeVolume };
      assert.deepEqual(parseProjectFile(serializeProject(project), 'metronome.chroma'), project);
    }
  }
  const draft = { ...DEFAULT_PROJECT, notation: 'TEMPO \n1q', metronomeVolume: 0, metronomeOffset: -0.5 };
  assert.equal(validateProject(draft, { allowInvalidNotation: true }).metronomeVolume, 0);
  assert.throws(() => validateProject({ ...draft, metronomeOffset: -600.01 }, { allowInvalidNotation: true }), /Metronome start delay/);
});

test('older projects default to normal playback speed without changing their timing or mixer', () => {
  for (const version of [undefined, 1, 2, 3, 4]) {
    const source = {
      notation: 'TEMPO 93\nTSIG 6/8\n1q. -3#e 0h', instrument: 'vcsl',
      noteOffset: -2, backgroundOffset: 1.25, noteVolume: 0, backgroundVolume: 81,
      metronome: true, metronomeOffset: 3.5, metronomeVolume: 43,
    };
    if (version !== undefined) source.version = version;
    const restored = parseProjectFile(JSON.stringify(source), 'older.chroma');
    assert.equal(restored.version, 5);
    assert.equal(restored.playbackRate, 1);
    for (const key of Object.keys(source).filter(key => key !== 'version')) {
      assert.equal(restored[key], source[key], key);
    }
    assert.equal(restored.tempo, 93);
    assert.equal(restored.numerator, 6);
    assert.equal(restored.denominator, 8);
    assert.deepEqual(parseProjectFile(serializeProject(restored), 'migrated.chroma'), restored);
  }
  assert.equal(parseProjectFile('1q', 'notes.txt').playbackRate, 1);
});

test('playback speed round-trips independently of score tempo, source delays, and channel volumes', () => {
  for (const playbackRate of [0.25, 0.65, 1, 1.125, 2]) {
    const project = {
      ...DEFAULT_PROJECT, playbackRate, notation: 'TEMPO 120\nTSIG 3/4\n1w', tempo: 120, numerator: 3,
      noteOffset: -2.5, backgroundOffset: 3, metronomeOffset: 0.75,
      noteVolume: 0, backgroundVolume: 80, metronomeVolume: 30,
    };
    const exported = serializeProject(project);
    assert.equal(JSON.parse(exported).version, 5);
    assert.deepEqual(parseProjectFile(exported, 'speed.chroma'), project);
    const draft = { ...project, notation: 'TEMPO 120\nTSIG 3/4\n-3#' };
    assert.deepEqual(validateProject(draft, { allowInvalidNotation: true }), draft);
  }
});

test('explicit playback speed is validated in every supported project version', () => {
  for (const version of [1, 2, 3, 4, 5]) {
    assert.equal(validateProject({ version, notation: '1q', playbackRate: 0.4 }).playbackRate, 0.4);
    for (const playbackRate of [0, 2.01, '0.5', null, NaN, Infinity]) {
      assert.throws(() => validateProject({ version, notation: '1q', playbackRate }), /Playback speed/);
      assert.throws(() => validateProject({ version, notation: '-3#', playbackRate }, { allowInvalidNotation: true }), /Playback speed/);
    }
  }
});

test('inline timing changes round-trip as source text while project fields describe only initial settings', () => {
  const notation = 'TEMPO 80 TSIG 3/4\r\n1h 1q L TEMPO 120 2q TSIG 6/8 -3#q.';
  const project = validateProject({ ...DEFAULT_PROJECT, notation, playbackRate: 0.75 });
  assert.deepEqual([project.tempo, project.numerator, project.denominator], [80, 3, 4]);
  const imported = parseProjectFile(serializeProject(project), 'changes.chroma');
  assert.equal(imported.notation, notation);
  assert.deepEqual(imported, project);
  const text = parseProjectFile('1q TEMPO 90 TSIG 6/8 2q.', 'changes.txt');
  assert.deepEqual([text.tempo, text.numerator, text.denominator], [60, 4, 4]);
  assert.equal(text.notation, '1q TEMPO 90 TSIG 6/8 2q.');
});

test('legacy initial settings do not overwrite or borrow from later timing changes', () => {
  const notation = '1q TEMPO 120 TSIG 6/8 2q.';
  const project = validateProject({ version: 1, notation, tempo: 75, numerator: 3, denominator: 4 });
  assert.equal(project.notation, `TEMPO 75\nTSIG 3/4\n${notation}`);
  assert.deepEqual([project.tempo, project.numerator, project.denominator], [75, 3, 4]);
});
