import test from 'node:test';
import assert from 'node:assert/strict';
import { dslToMusicXml, musicXmlToDsl, MAX_MUSICXML_LENGTH } from './musicxml.js';
import { parseNotation } from './notation.js';
import { createScoreTiming } from './score-timing.js';

const score = body => `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Harmonica</part-name></score-part></part-list><part id="P1">${body}</part></score-partwise>`;
const measure = (body, attrs = '') => `<measure number="1" ${attrs}>${body}</measure>`;
const attributes = (divisions = 8, meter = '4/4') => `<attributes><divisions>${divisions}</divisions><time><beats>${meter.split('/')[0]}</beats><beat-type>${meter.split('/')[1]}</beat-type></time></attributes>`;
const pitched = (step = 'C', octave = 4, duration = 8, extra = '', prefix = '') => `<note>${prefix}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration>${extra}</note>`;
const annotation = text => `<notations><technical><other-technical>${text}</other-technical></technical></notations>`;
const tokens = result => parseNotation(result.notation).notes.map(note => note.token);
const withoutMetadata = xml => xml.replace(/\s*<identification>[\s\S]*?<\/identification>/, '');
const warning = (result, pattern) => assert.ok(result.warnings.some(message => pattern.test(message)), result.warnings.join('\n'));
const musicalSummary = notation => {
  const parsed = parseNotation(notation);
  return { notes: parsed.notes.map(({ midi, hole, draw, slider, beats }) => ({ midi, hole, draw, slider, beats })), tempo: parsed.tempo, numerator: parsed.numerator, denominator: parsed.denominator, seconds: createScoreTiming(parsed).beatToSeconds(parsed.totalBeats) };
};

test('round trips exact DSL spelling, whitespace, CRLF, line markers, separators, rests, and every fingering', () => {
  const notes = [];
  for (let hole = 1; hole <= 12; hole += 1) for (const sign of ['', '-']) for (const slide of ['', '#']) notes.push(`${sign}${hole}${slide}q`);
  const original = ` TEMP 060\r\nTSIG 4 / 4\r\n ${notes.join(' | ')} L\n\n0w.\t 1 h \nTEMPO 120\n TSIG 6/8 -3#s. 0e `;
  const exported = dslToMusicXml(original, { title: 'Blow & draw <practice> "1"' });
  const imported = musicXmlToDsl(exported.xml);
  assert.equal(imported.notation, original);
  assert.equal(imported.title, 'Blow & draw <practice> "1"');
  assert.deepEqual(imported.warnings, []);
  assert.match(exported.xml, /<midi-program>23<\/midi-program>/);
});

test('empty, layout-only, and timing-only DSL round trip without inventing notes', () => {
  for (const original of ['', '\nL | L\r\n', 'TEMPO 75 TSIG 3/4']) {
    assert.equal(musicXmlToDsl(dslToMusicXml(original).xml).notation, original);
    assert.deepEqual(tokens(musicXmlToDsl(withoutMetadata(dslToMusicXml(original).xml))), []);
  }
});

test('formatting XML with extra indentation does not discard exact DSL', () => {
  const original = ' 1qL\n+4h\n';
  const xml = dslToMusicXml(original).xml.replace(/>\s*</g, '>\n    <');
  assert.equal(musicXmlToDsl(xml).notation, original);
});

test('editing pitch invalidates metadata and ignores a stale harmonica fingering', () => {
  const xml = dslToMusicXml(' 4q ').xml.replace('<step>C</step>', '<step>D</step>');
  const imported = musicXmlToDsl(xml);
  assert.deepEqual(tokens(imported), ['-5q']);
  warning(imported, /embedded DSL was not reused/);
  warning(imported, /did not match/);
});

test('editing valid annotations changes same-pitch fingerings instead of reusing stale DSL', () => {
  const xml = dslToMusicXml('4q').xml.replace('hole=4;breath=blow;slide=out', 'hole=5;breath=blow;slide=out');
  assert.deepEqual(tokens(musicXmlToDsl(xml)), ['5q']);
  const slide = dslToMusicXml('4q').xml.replace('hole=4;breath=blow;slide=out', 'hole=4;breath=draw;slide=in');
  assert.deepEqual(tokens(musicXmlToDsl(slide)), ['-4#q']);
});

test('invalid annotation formats and hole numbers are reported, never executed', () => {
  for (const text of ['chromaplay:hole=99;breath=draw;slide=in', 'chromaplay:hole=4;breath=blow', 'chromaplay:alert(1)']) {
    const result = musicXmlToDsl(score(measure(attributes() + pitched('C', 5, 8, annotation(text)))));
    assert.deepEqual(tokens(result), ['4q']);
    warning(result, /annotation was invalid/);
  }
});

test('changing tempo or duration invalidates metadata and changes playback', () => {
  const original = dslToMusicXml('TEMPO 60 1q').xml;
  const tempo = musicXmlToDsl(original.replace('tempo="60"', 'tempo="120"'));
  assert.equal(parseNotation(tempo.notation).tempo, 120);
  const duration = musicXmlToDsl(original.replace('<duration>8</duration>', '<duration>16</duration>'));
  assert.deepEqual(tokens(duration), ['1h']);
});

test('exports repeated tempo and meter changes, rests and dots without metadata dependency', () => {
  const original = 'TEMPO 70 TSIG 4/4 1q -1h. TEMPO 120 0q 2q TSIG 6/8 -3#q. 4q. TEMPO 45 TSIG 2/4 -12#h';
  const imported = musicXmlToDsl(withoutMetadata(dslToMusicXml(original).xml));
  assert.deepEqual(musicalSummary(imported.notation), musicalSummary(original));
  const directives = parseNotation(imported.notation).directives;
  assert.deepEqual(directives.filter(item => item.kind === 'tempo').map(item => [item.beat, item.tempo]), [[0, 70], [4, 120], [9, 45]]);
  assert.deepEqual(directives.filter(item => item.kind === 'time-signature').map(item => [item.beat, item.numerator, item.denominator]), [[0, 4, 4], [6, 6, 8], [9, 2, 4]]);
});

test('long notes split at bars with standard ties and merge on import', () => {
  const original = 'TSIG 3/4 -4#w. 12w -12#w.';
  const exported = dslToMusicXml(original);
  assert.match(exported.xml, /<tie type="start"\/>/);
  assert.match(exported.xml, /<tie type="stop"\/>/);
  assert.match(exported.xml, /<tied type="start"\/>/);
  assert.deepEqual(musicalSummary(musicXmlToDsl(withoutMetadata(exported.xml)).notation), musicalSummary(original));
});

test('very short measures use a 32nd type for tied pieces without changing the original duration', () => {
  const original = 'TSIG 1/16 1s. -2q.';
  const xml = dslToMusicXml(original).xml;
  assert.match(xml, /<type>32nd<\/type>/);
  assert.deepEqual(musicalSummary(musicXmlToDsl(withoutMetadata(xml)).notation), musicalSummary(original));
});

test('exported notes carry a complete harmonica annotation including the special top D7 reed', () => {
  const xml = dslToMusicXml('-12#q 5h 0s').xml;
  assert.match(xml, /<step>D<\/step>\s*<octave>7<\/octave>/);
  assert.match(xml, /chromaplay:hole=12;breath=draw;slide=in/);
  assert.equal((xml.match(/<other-technical>/g) || []).length, 2);
});

test('maps unannotated pitch deterministically and never transposes pitches to fit', () => {
  const xml = score(measure(attributes() + pitched('C', 5) + pitched('C', 3) + pitched('D', 7)));
  const result = musicXmlToDsl(xml);
  assert.deepEqual(tokens(result), ['4q', '0q', '-12#q']);
  warning(result, /automatic fingering/);
  warning(result, /replaced with rests; no notes were transposed/);
});

test('uses explicit pitch alterations and treats microtones as unavailable', () => {
  const xml = score(measure(attributes() + pitched('C', 4).replace('</step>', '</step><alter>1</alter>') + pitched('C', 4).replace('</step>', '</step><alter>0.5</alter>')));
  assert.deepEqual(tokens(musicXmlToDsl(xml)), ['1#q', '0q']);
});

test('honors instrument transposition when choosing sounding harmonica pitches', () => {
  const xml = score(measure(attributes() + '<attributes><transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>' + pitched('D', 4)));
  const result = musicXmlToDsl(xml);
  assert.deepEqual(tokens(result), ['1q']);
  warning(result, /sounding pitches/);
});

test('reads sound tempo, dotted metronome tempo, and direction offsets within a sustained note', () => {
  const xml = score(measure(attributes(8) + '<direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>80</per-minute></metronome></direction-type></direction>' + pitched('C', 4, 32) + '<direction><direction-type><words>faster</words></direction-type><offset>-16</offset><sound tempo="150"/></direction>'));
  const result = musicXmlToDsl(xml);
  const parsed = parseNotation(result.notation);
  assert.equal(parsed.tempo, 120);
  assert.deepEqual(tokens(result), ['1h', '1h']);
  assert.deepEqual(parsed.directives.filter(item => item.kind === 'tempo').map(item => [item.beat, item.tempo]), [[0, 120], [2, 150]]);
  warning(result, /articulated again/);
});

test('limits unsupported tempos and meters with explicit conversion warnings', () => {
  const result = musicXmlToDsl(score(measure(attributes(8, '40/32') + '<sound tempo="12.4"/>' + pitched())));
  const parsed = parseNotation(result.notation);
  assert.equal(parsed.tempo, 30);
  assert.equal(parsed.numerator, 32);
  assert.equal(parsed.denominator, 16);
  warning(result, /30 to 300/);
  warning(result, /Time signatures outside/);
});

test('supports score-timewise and namespace-prefixed MusicXML', () => {
  const xml = `<score-timewise><part-list><score-part id="P1"><part-name>Test</part-name></score-part></part-list><measure number="1"><part id="P1">${attributes()}${pitched()}</part></measure><measure number="2"><part id="P1">${pitched('D')}</part></measure></score-timewise>`;
  assert.deepEqual(tokens(musicXmlToDsl(xml)), ['1q', '-1q']);
  const namespaced = score(measure(attributes() + pitched())).replace('<score-partwise ', '<score-partwise xmlns="http://www.musicxml.org/xsd/MusicXML" ');
  assert.deepEqual(tokens(musicXmlToDsl(namespaced)), ['1q']);
  const prefixed = score(measure(attributes() + pitched())).replace(/(<\/?)([A-Za-z][\w-]*)/g, '$1mx:$2').replace('<mx:score-partwise ', '<mx:score-partwise xmlns:mx="http://www.musicxml.org/xsd/MusicXML" ');
  assert.deepEqual(tokens(musicXmlToDsl(prefixed)), ['1q']);
});

test('imports ordinary external DOCTYPE without loading it, XML comments, CDATA, entities and BOM', () => {
  const xml = '\uFEFF<?xml version="1.0"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "https://example.invalid/never-fetch.dtd">' + score(measure(attributes() + pitched())).replace('<part-list>', '<work><work-title><![CDATA[A & B]]> &amp; &#x43; &#68;</work-title></work><!-- score --><part-list>');
  const result = musicXmlToDsl(xml);
  assert.equal(result.title, 'A & B & C D');
  assert.deepEqual(tokens(result), ['1q']);
});

test('picks one part, voice and staff, drops chord extras, and preserves gaps', () => {
  const firstPart = measure(attributes() + pitched('C', 4, 8, '<voice>2</voice><staff>1</staff>') + pitched('E', 4, 8, '<voice>2</voice>', '<chord/>') + '<forward><duration>8</duration><voice>2</voice></forward>' + pitched('G', 4, 8, '<voice>2</voice>') + '<backup><duration>24</duration></backup>' + pitched('D', 4, 24, '<voice>1</voice>'));
  const xml = score(firstPart).replace('</score-partwise>', `<part id="P2">${measure(pitched('D', 6))}</part></score-partwise>`);
  const result = musicXmlToDsl(xml);
  assert.deepEqual(tokens(result), ['1q', '0q', '3q']);
  warning(result, /first part/);
  warning(result, /first encountered voice/);
  warning(result, /Chords were reduced/);
});

test('reports grace notes, tuplets, repeats, dynamics, and lyrics', () => {
  const body = attributes(12) + '<note><grace/><pitch><step>C</step><octave>4</octave></pitch><type>eighth</type></note>' + pitched('D', 4, 4, '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><dynamics><p/></dynamics></notations><lyric><text>Hello</text></lyric>') + '<barline><repeat direction="backward"/></barline>';
  const result = musicXmlToDsl(score(measure(body)));
  assert.deepEqual(tokens(result), ['-1s.']);
  for (const pattern of [/Grace notes/, /Tuplet timing/, /Repeats/, /Lyrics/, /rounded/]) warning(result, pattern);
});

test('imports rests, empty measures, full-measure rests and inferred dotted duration', () => {
  const xml = score(measure(attributes(8, '3/4') + '<note><rest measure="yes"/></note>') + measure('') + measure('<note><pitch><step>C</step><octave>4</octave></pitch><type>quarter</type><dot/></note>', 'implicit="yes"'));
  const result = musicXmlToDsl(xml);
  assert.deepEqual(tokens(result), ['0h.', '0h.', '1q.']);
  warning(result, /missing MusicXML duration/);
});

test('preserves system breaks and separators when between notes', () => {
  const xml = score(measure(attributes() + pitched() + '<barline location="middle"><bar-style>regular</bar-style></barline>' + pitched('D')) + measure('<print new-system="yes"/>' + pitched('E')));
  const result = musicXmlToDsl(xml);
  assert.match(result.notation, /1q \| -1q \| L\n2q/);
});

test('exports standard system breaks at measure starts and warns about mid-measure editor lines', () => {
  assert.match(dslToMusicXml('1w L 2w').xml, /<print new-system="yes"\/>/);
  assert.match(dslToMusicXml('1q | 2q').xml, /<barline location="middle">/);
  assert.ok(dslToMusicXml('1q L 2q').warnings.some(message => /line breaks inside a measure/.test(message)));
});

test('does not silently restore embedded DSL if the fingerprint or source is missing', () => {
  const xml = dslToMusicXml(' +1q ').xml;
  const hashRemoved = xml.replace(/<miscellaneous-field name="chromaplay:fingerprint">[^<]*<\/miscellaneous-field>/, '');
  const result = musicXmlToDsl(hashRemoved);
  assert.notEqual(result.notation, ' +1q ');
  assert.deepEqual(tokens(result), ['1q']);
  warning(result, /embedded DSL was not reused/);
});

test('rejects malformed and dangerous XML instead of attempting recovery', () => {
  const invalid = [
    '', '<score-partwise>', '<not-a-score/>', '<score-partwise></score-timewise>', '<score-partwise/><score-partwise/>',
    '<!DOCTYPE score-partwise [<!ENTITY file SYSTEM "file:///etc/passwd">]><score-partwise>&file;</score-partwise>',
    '<!DOCTYPE score-partwise [<!ENTITY a "ha"><!ENTITY b "&a;&a;">]><score-partwise/>',
    '<score-partwise>&unknown;</score-partwise>', '<score-partwise>&</score-partwise>', '<score-partwise>&#0;</score-partwise>',
    '<score-partwise bad="a" bad="b"/>', '<score-partwise bad="<"/>', '<score-partwise><!-- a -- b --></score-partwise>',
    '<score-partwise><![CDATA[x]</score-partwise>', '<score-partwise>]]></score-partwise>', '<score-partwise>\u0001</score-partwise>',
    '<mx:score-partwise/>', '<score-partwise><x/>', '<score-partwise/><!DOCTYPE score-partwise>',
  ];
  for (const xml of invalid) assert.throws(() => musicXmlToDsl(xml), Error, xml);
});

test('rejects invalid timing/pitches and malformed DSL with helpful messages', () => {
  assert.throws(() => dslToMusicXml('1z'), /Fix the DSL/);
  assert.throws(() => musicXmlToDsl(score(measure('<attributes><divisions>0</divisions></attributes>' + pitched()))), /divisions/);
  assert.throws(() => musicXmlToDsl(score(measure(attributes() + pitched('C', 4, -1)))), /duration/);
  assert.throws(() => musicXmlToDsl(score(measure(attributes() + pitched('H')))), /pitch/);
  assert.throws(() => musicXmlToDsl(score(measure(attributes() + '<backup><duration>8</duration></backup>'))), /before the measure start/);
  assert.throws(() => musicXmlToDsl(score(measure(attributes() + '<sound tempo="NaN"/>'))), /tempo/);
});

test('bounds source size, nesting, element count, duration, and converted DSL length', () => {
  assert.equal(MAX_MUSICXML_LENGTH, 2_000_000);
  assert.throws(() => musicXmlToDsl(' '.repeat(MAX_MUSICXML_LENGTH + 1)), /too large/);
  assert.throws(() => musicXmlToDsl(`<score-partwise>${'<a>'.repeat(70)}${'</a>'.repeat(70)}</score-partwise>`), /deeply nested/);
  assert.throws(() => musicXmlToDsl(`<score-partwise>${'<a/>'.repeat(100_001)}</score-partwise>`), /too large/);
  assert.throws(() => musicXmlToDsl(score(measure(pitched('C', 4, 1e9)))), /duration/);
  assert.throws(() => musicXmlToDsl(score(measure('<attributes><divisions>1</divisions></attributes>' + pitched('D', 7, 100_000)))), /100,000 character/);
});

test('changing embedded DSL metadata invalidates its fingerprint rather than overriding XML pitches', () => {
  const xml = dslToMusicXml('1q').xml.replace('name="chromaplay:dsl">1q<', 'name="chromaplay:dsl">-12#w<');
  const result = musicXmlToDsl(xml);
  assert.deepEqual(tokens(result), ['1q']);
  warning(result, /embedded DSL was not reused/);
});

test('sound offsets override direction offsets and work on standalone sound elements', () => {
  const xml = score(measure(attributes() + '<direction><direction-type><words>Faster</words></direction-type><offset>24</offset><sound tempo="120"><offset>8</offset></sound></direction>' + pitched('C', 4, 32) + '<sound tempo="90"><offset>-16</offset></sound>'));
  const parsed = parseNotation(musicXmlToDsl(xml).notation);
  assert.deepEqual(parsed.directives.filter(item => item.kind === 'tempo').map(item => [item.beat, item.tempo]), [[0, 60], [1, 120], [2, 90]]);
});

test('numeric extremes cannot produce infinite duration loops or nonfinite timelines', () => {
  for (const offset of ['1e100', '-1e100', 'Infinity', '800001']) {
    assert.throws(() => musicXmlToDsl(score(measure(attributes() + `<direction><offset>${offset}</offset><sound tempo="90"/></direction>`))), /offset/);
  }
  assert.throws(() => musicXmlToDsl(score(measure(attributes() + '<sound tempo="90"><offset>1e100</offset></sound>'))), /offset/);
  assert.throws(() => musicXmlToDsl(score(measure('<attributes><divisions>1e-300</divisions></attributes>' + pitched()))), /duration/);
  assert.throws(() => musicXmlToDsl(score(measure('<attributes><divisions>1e-300</divisions></attributes><sound tempo="90"><offset>1</offset></sound>'))), /offset/);
  assert.throws(() => musicXmlToDsl(score(measure(attributes() + '<forward><duration>1e100</duration></forward>'))), /too long/);
  for (const modification of ['<actual-notes>1e-300</actual-notes><normal-notes>1e300</normal-notes>', '<actual-notes>Infinity</actual-notes><normal-notes>2</normal-notes>']) {
    assert.throws(() => musicXmlToDsl(score(measure(attributes() + `<note><rest/><type>whole</type><time-modification>${modification}</time-modification></note>`))), /duration/);
  }
  assert.throws(() => musicXmlToDsl(score(measure('<attributes><time><beats>Infinity</beats><beat-type>4</beat-type></time></attributes>'))), /time signature/);
  assert.throws(() => dslToMusicXml('TSIG 1/16 ' + '1w '.repeat(1000)), /too many measures/);
});

test('rejects malformed declarations, illegal names and misplaced document types', () => {
  for (const xml of [
    '<?xml?><score-partwise/>', '<?XML version="1.0"?><score-partwise/>', ' <?xml version="1.0"?><score-partwise/>',
    '<score-partwise><?xml version="1.0"?></score-partwise>', '<?xml version="1.0"?><?xml version="1.0"?><score-partwise/>',
    '<!DOCTYPE wrong><score-partwise/>', '<score-partwise><!--x---></score-partwise>', '<score-partwise xmlns:a="urn:a"><a::note/></score-partwise>',
  ]) assert.throws(() => musicXmlToDsl(xml), /Invalid MusicXML/, xml);
});

const assertBeatMap = (result, expected) => {
  assert.equal(result.beatMap.length, expected.length);
  for (const [index, [sourceBeat, playbackBeat]] of expected.entries()) {
    assert.ok(Math.abs(result.beatMap[index].sourceBeat - sourceBeat) < 1e-10, `source beat at boundary ${index}`);
    assert.ok(Math.abs(result.beatMap[index].playbackBeat - playbackBeat) < 1e-10, `playback beat at boundary ${index}`);
  }
  assert.equal(result.beatMap.at(-1).playbackBeat, parseNotation(result.notation).totalBeats);
};

test('sheet beat map tracks every rounded tuplet note instead of stretching the whole score', () => {
  const tuplets = attributes(12) + pitched('C', 4, 4) + pitched('D', 4, 4) + pitched('E', 4, 4);
  const result = musicXmlToDsl(score(measure(tuplets, 'implicit="yes"') + measure(pitched('G', 4, 12))));
  assert.deepEqual(tokens(result), ['1s.', '-1s.', '2s.', '3q']);
  assertBeatMap(result, [[0, 0], [1 / 3, 3 / 8], [2 / 3, 6 / 8], [1, 9 / 8], [2, 17 / 8]]);
  assert.deepEqual(result.sourceMeasureStarts, [0, 1]);
});

test('sheet beat map expands short notes individually and grace notes consume no cursor time', () => {
  const grace = '<note><grace/><pitch><step>C</step><octave>4</octave></pitch><type>16th</type></note>';
  const result = musicXmlToDsl(score(measure(attributes(8) + grace + pitched('C', 4, 1) + pitched('D', 4, 1) + pitched('E', 4, 8))));
  assert.deepEqual(tokens(result), ['1s', '-1s', '2q']);
  assertBeatMap(result, [[0, 0], [1 / 8, 1 / 4], [1 / 4, 1 / 2], [5 / 4, 3 / 2]]);
});

test('sheet beat map keeps timing changes at their corresponding source and playback boundaries', () => {
  const body = attributes(12) + pitched('C', 4, 8)
    + '<direction><offset>-4</offset><sound tempo="120"/></direction>' + pitched('D', 4, 12);
  const result = musicXmlToDsl(score(measure(body)));
  assertBeatMap(result, [[0, 0], [1 / 3, 3 / 8], [2 / 3, 3 / 4], [5 / 3, 7 / 4]]);
  const tempo = parseNotation(result.notation).directives.find(directive => directive.kind === 'tempo' && directive.tempo === 120);
  assert.equal(tempo.beat, result.beatMap[1].playbackBeat);
});

test('sheet beat map distributes a rounded tied span across every emitted DSL piece', () => {
  const body = attributes(12) + pitched('C', 4, 4, '<tie type="start"/>') + pitched('C', 4, 4, '<tie type="stop"/>');
  const result = musicXmlToDsl(score(measure(body)));
  assert.deepEqual(tokens(result), ['1s.', '1s']);
  assertBeatMap(result, [[0, 0], [2 / 5, 3 / 8], [2 / 3, 5 / 8]]);
  // The original tie boundary at 1/3 remains inside the continuous mapped span.
  assert.ok(Math.abs(result.beatMap[1].playbackBeat * (1 / 3) / result.beatMap[1].sourceBeat - 5 / 16) < 1e-10);
});

test('sheet beat map includes silent gaps and tails from omitted voices, with first-part measure starts', () => {
  const body = attributes(12) + pitched('C', 4, 3, '<voice>1</voice>')
    + '<forward><duration>3</duration></forward>' + pitched('D', 4, 4, '<voice>1</voice>')
    + '<backup><duration>10</duration></backup>' + pitched('E', 4, 12, '<voice>2</voice>');
  const firstPart = score(measure(body) + measure(pitched('G', 4, 12, '<voice>1</voice>')));
  const xml = firstPart.replace('</score-partwise>', `<part id="P2">${measure(attributes(12) + pitched('C', 3, 48))}${measure(pitched('D', 3, 48))}</part></score-partwise>`);
  const result = musicXmlToDsl(xml);
  assert.deepEqual(tokens(result), ['1s', '0s', '-1s.', '0s', '3q']);
  assertBeatMap(result, [[0, 0], [1 / 4, 1 / 4], [1 / 2, 1 / 2], [5 / 6, 7 / 8], [1, 9 / 8], [2, 17 / 8]]);
  // The omitted second part lasts four beats per measure. The sheet renderer
  // can align [0, 1] here to its own measure timestamps [0, 4].
  assert.deepEqual(result.sourceMeasureStarts, [0, 1]);
});

test('unchanged embedded DSL uses an identity map and original XML measure starts without rewriting source', () => {
  const original = ' TSIG 3/4\r\n1w L 0q TEMPO 90 TSIG 2/4 -4#w. ';
  const xml = dslToMusicXml(original).xml;
  const result = musicXmlToDsl(xml);
  assert.equal(result.notation, original);
  assert.deepEqual(result.warnings, []);
  assertBeatMap(result, [[0, 0], [4, 4], [5, 5], [11, 11]]);
  assert.deepEqual(result.sourceMeasureStarts, [0, 3, 5, 7, 9]);
  assert.deepEqual(musicXmlToDsl(withoutMetadata(xml)).sourceMeasureStarts, result.sourceMeasureStarts);
});

test('empty unchanged DSL still supplies an origin and one measure start', () => {
  for (const notation of ['', '\nL | ', 'TEMPO 90 TSIG 6/8']) {
    const result = musicXmlToDsl(dslToMusicXml(notation).xml);
    assertBeatMap(result, [[0, 0]]);
    assert.deepEqual(result.sourceMeasureStarts, [0]);
    assert.equal(result.notation, notation);
  }
});

test('sheet beat map supports score-timewise pickups, backups, and division changes', () => {
  const first = attributes(12) + pitched('C', 4, 4, '<voice>1</voice>') + '<backup><duration>4</duration></backup>' + pitched('E', 4, 4, '<voice>2</voice>');
  const second = '<attributes><divisions>8</divisions></attributes>' + pitched('D', 4, 4, '<voice>1</voice>');
  const xml = `<score-timewise><part-list><score-part id="P1"><part-name>Test</part-name></score-part></part-list><measure number="0" implicit="yes"><part id="P1">${first}</part></measure><measure number="1"><part id="P1">${second}</part></measure></score-timewise>`;
  const result = musicXmlToDsl(xml);
  assertBeatMap(result, [[0, 0], [1 / 3, 3 / 8], [5 / 6, 7 / 8]]);
  assert.deepEqual(result.sourceMeasureStarts, [0, 1 / 3]);
});

test('sheet beat map includes rests leading to late tempo markings and deterministic zero-time jumps', () => {
  const lateTempo = musicXmlToDsl(score(measure(attributes(12) + pitched('C', 4, 4) + '<sound tempo="90"><offset>4</offset></sound>')));
  assertBeatMap(lateTempo, [[0, 0], [1 / 3, 3 / 8], [2 / 3, 3 / 4]]);
  const tiny = musicXmlToDsl(score(measure(attributes(1) + pitched('C', 4, 0.00000005) + pitched('D', 4, 1))));
  assertBeatMap(tiny, [[0, 0], [0.00000005, 0], [1.00000005, 1]]);
  assert.deepEqual(tokens(tiny), ['-1q']);
});

test('sub-EPSILON source overlaps never move sheet beat boundaries backward', () => {
  const result = musicXmlToDsl(score(measure(attributes(1) + pitched('C', 4, 1)
    + '<backup><duration>0.00000005</duration></backup>' + pitched('D', 4, 1))));
  assert.deepEqual(tokens(result), ['1q', '-1q']);
  assertBeatMap(result, [[0, 0], [1, 1], [1.99999995, 2]]);
});
