import { parseNotation, pitchFor } from './notation.js';
import { createScoreTiming } from './score-timing.js';

export const MAX_MUSICXML_LENGTH = 2_000_000;
const MAX_ELEMENTS = 100_000;
const MAX_DSL_LENGTH = 100_000;
const EPSILON = 1e-7;
const XML_TYPES = { w: 'whole', h: 'half', q: 'quarter', e: 'eighth', s: '16th', t: '32nd' };
const DURATIONS = [[48, 'w.'], [32, 'w'], [24, 'h.'], [16, 'h'], [12, 'q.'], [8, 'q'], [6, 'e.'], [4, 'e'], [3, 's.'], [2, 's']];
const STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const PITCHES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const warnOnce = (warnings, message) => { if (!warnings.includes(message)) warnings.push(message); };
const localName = name => name.split(':').at(-1);
const elements = (node, name) => node.children.filter(child => typeof child !== 'string' && (!name || child.name === name));
const first = (node, name) => elements(node, name)[0];
const content = node => node ? node.children.map(child => typeof child === 'string' ? child : content(child)).join('') : '';
const value = (node, name) => content(first(node, name)).trim();
const descendants = (node, name) => {
  const result = [];
  for (const child of elements(node)) {
    if (child.name === name) result.push(child);
    result.push(...descendants(child, name));
  }
  return result;
};
const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '&#13;');
const xmlCharacter = code => code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff)
  || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);

function decodeEntities(text) {
  return text.replace(/&([^;\s<&]*);|&/g, (match, entity) => {
    const builtin = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(builtin, entity)) return builtin[entity];
    const numeric = /^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity || '');
    const code = numeric ? (entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))) : NaN;
    if (!Number.isInteger(code) || !xmlCharacter(code)) throw new Error('Invalid MusicXML: unknown or invalid XML entity.');
    return String.fromCodePoint(code);
  });
}

// A small, bounded XML reader shared by browsers and Node. It never loads DTDs,
// external entities, stylesheets, or URLs. The tree remains plain data.
function parseXml(source) {
  if (typeof source !== 'string') throw new TypeError('MusicXML must be text.');
  if (source.length > MAX_MUSICXML_LENGTH) throw new Error('MusicXML is too large. The limit is 2,000,000 characters.');
  if (!source.trim()) throw new Error('Enter or import a MusicXML score.');
  for (const character of source) if (!xmlCharacter(character.codePointAt(0))) throw new Error('Invalid MusicXML: forbidden XML character.');
  const xml = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const document = { name: '#document', children: [] };
  const stack = [document];
  const names = [];
  let cursor = 0;
  let count = 0;
  let doctype = false;
  let doctypeName = '';
  let declarationSeen = false;
  const fail = message => { throw new Error(`Invalid MusicXML: ${message}`); };
  while (cursor < xml.length) {
    if (xml[cursor] !== '<') {
      const end = xml.indexOf('<', cursor);
      const text = xml.slice(cursor, end < 0 ? xml.length : end);
      if (text.includes(']]>')) fail('unexpected CDATA closing marker.');
      const decoded = decodeEntities(text);
      if (stack.length === 1 && decoded.trim()) fail('text outside the root element.');
      stack.at(-1).children.push(decoded);
      cursor = end < 0 ? xml.length : end;
      continue;
    }
    if (xml.startsWith('<!--', cursor)) {
      const end = xml.indexOf('-->', cursor + 4);
      if (end < 0 || xml.slice(cursor + 4, end).includes('--') || xml.slice(cursor + 4, end).endsWith('-')) fail('malformed XML comment.');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', cursor)) {
      const end = xml.indexOf(']]>', cursor + 9);
      if (end < 0 || stack.length === 1) fail('malformed CDATA section.');
      stack.at(-1).children.push(xml.slice(cursor + 9, end));
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', cursor)) {
      const end = xml.indexOf('?>', cursor + 2);
      if (end < 0) fail('unclosed processing instruction.');
      const instruction = xml.slice(cursor + 2, end);
      const target = /^([A-Za-z_][\w.:-]*)(?:\s|$)/.exec(instruction)?.[1];
      if (!target) fail('malformed processing instruction.');
      if (target.toLowerCase() === 'xml') {
        if (target !== 'xml' || cursor !== 0 || declarationSeen || !/^xml\s+version\s*=\s*(["'])1\.[01]\1(?:\s+encoding\s*=\s*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*$/.test(instruction)) fail('malformed or misplaced XML declaration.');
        declarationSeen = true;
      }
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith('<!DOCTYPE', cursor)) {
      if (doctype || stack.length !== 1 || elements(document).length) fail('misplaced document type.');
      let end = cursor + 9;
      let quote = '';
      for (; end < xml.length; end += 1) {
        const character = xml[end];
        if (quote) { if (character === quote) quote = ''; }
        else if (character === '"' || character === "'") quote = character;
        else if (character === '[') fail('internal DTDs and entity declarations are not supported.');
        else if (character === '>') break;
      }
      if (end === xml.length) fail('unclosed document type.');
      const declaration = xml.slice(cursor, end + 1);
      if (!/^<!DOCTYPE\s+[\w:.-]+(?:\s+(?:PUBLIC\s+(?:"[^"]*"|'[^']*')\s+(?:"[^"]*"|'[^']*')|SYSTEM\s+(?:"[^"]*"|'[^']*')))?\s*>$/.test(declaration)) fail('malformed document type.');
      doctype = true;
      doctypeName = /^<!DOCTYPE\s+([\w:.-]+)/.exec(declaration)[1];
      cursor = end + 1;
      continue;
    }
    if (xml.startsWith('<!', cursor)) fail('unsupported XML declaration.');
    const closing = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(xml.slice(cursor));
    if (closing) {
      if (stack.length === 1 || names.at(-1) !== closing[1]) fail('mismatched closing tag.');
      stack.pop(); names.pop(); cursor += closing[0].length;
      continue;
    }
    const opening = /^<([A-Za-z_][\w.:-]*)/.exec(xml.slice(cursor));
    if (!opening || !/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(opening[1])) fail('malformed element.');
    cursor += opening[0].length;
    const attrs = Object.create(null);
    let selfClosing = false;
    while (cursor < xml.length) {
      const space = /^\s*/.exec(xml.slice(cursor))[0];
      cursor += space.length;
      if (xml.startsWith('/>', cursor)) { selfClosing = true; cursor += 2; break; }
      if (xml[cursor] === '>') { cursor += 1; break; }
      if (!space) fail('attributes must be separated by spaces.');
      const attribute = /^([A-Za-z_][\w.:-]*)\s*=\s*("[^"<]*"|'[^'<]*')/.exec(xml.slice(cursor));
      if (!attribute || !/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(attribute[1]) || Object.hasOwn(attrs, attribute[1])) fail('malformed or duplicate attribute.');
      attrs[attribute[1]] = decodeEntities(attribute[2].slice(1, -1).replace(/[\t\n]/g, ' '));
      cursor += attribute[0].length;
    }
    if (cursor > xml.length || xml[cursor - 1] !== '>') fail('unclosed opening tag.');
    if (++count > MAX_ELEMENTS || stack.length > 64) fail('score structure is too large or deeply nested.');
    const inherited = stack.at(-1).namespaces || Object.create(null);
    const namespaces = { ...inherited };
    for (const [name, uri] of Object.entries(attrs)) {
      if (name === 'xmlns') namespaces[''] = uri;
      else if (name.startsWith('xmlns:')) namespaces[name.slice(6)] = uri;
    }
    const prefixes = [opening[1], ...Object.keys(attrs).filter(name => !name.startsWith('xmlns:'))];
    for (const name of prefixes) if (name.includes(':') && name.split(':')[0] !== 'xml' && !namespaces[name.split(':')[0]]) fail('undeclared namespace prefix.');
    const node = { name: localName(opening[1]), qualifiedName: opening[1], attrs, namespaces, children: [] };
    stack.at(-1).children.push(node);
    if (!selfClosing) { stack.push(node); names.push(opening[1]); }
  }
  if (stack.length !== 1 || elements(document).length !== 1) fail('expected one complete root element.');
  const root = elements(document)[0];
  if (doctypeName && doctypeName !== root.qualifiedName) fail('document type does not match the root element.');
  if (!['score-partwise', 'score-timewise'].includes(root.name)) throw new Error('This file is not a MusicXML score. Use an uncompressed .musicxml or .xml file.');
  return root;
}

// This fingerprint detects edits, including pitch, timing, and annotations. It
// is not a security signature. Formatting-only XML changes do not invalidate it.
function fingerprint(root) {
  const canonical = node => {
    if (typeof node === 'string') return node.trim() ? node : null;
    if (node.name === 'miscellaneous-field' && node.attrs.name === 'chromaplay:fingerprint') return null;
    if (node.name === 'miscellaneous-field' && node.attrs.name === 'chromaplay:dsl') return [node.qualifiedName, node.attrs.name, content(node)];
    return [node.qualifiedName, Object.entries(node.attrs).sort(([a], [b]) => a.localeCompare(b)), node.children.map(canonical).filter(item => item !== null)];
  };
  const text = JSON.stringify(canonical(root));
  let firstHash = 2166136261;
  let secondHash = 2246822519;
  for (let index = 0; index < text.length; index += 1) {
    firstHash = Math.imul(firstHash ^ text.charCodeAt(index), 16777619);
    secondHash = Math.imul(secondHash ^ text.charCodeAt(index), 3266489917);
  }
  return `v1-${(firstHash >>> 0).toString(16).padStart(8, '0')}${(secondHash >>> 0).toString(16).padStart(8, '0')}`;
}

function partsForUnits(units, xml = false) {
  if (!Number.isSafeInteger(units) || units < 0 || units > 800_000) throw new Error('The MusicXML score is too long to convert.');
  const available = xml ? [...DURATIONS, [1, 't']] : DURATIONS;
  const result = [];
  while (units > 0) {
    const next = available.find(([length]) => length <= units && (xml || units - length !== 1));
    if (!next) { result.push([2, 's']); break; }
    result.push(next);
    units -= next[0];
  }
  return result;
}

function sourceLayout(source, parsed) {
  const items = [...parsed.notes.map(note => ({ ...note, beat: note.startBeat })), ...parsed.directives].sort((a, b) => a.start - b.start);
  const markers = [];
  let cursor = 0;
  let beat = 0;
  for (const item of [...items, { start: source.length, end: source.length }]) {
    const gap = source.slice(cursor, item.start);
    for (const marker of gap.matchAll(/[|L\r\n]/g)) markers.push({ beat, line: marker[0] !== '|' });
    beat = item.endBeat ?? item.beat ?? beat;
    cursor = item.end;
  }
  return markers;
}

export function dslToMusicXml(notation, { title = 'ChromaPlay score' } = {}) {
  if (typeof notation !== 'string') throw new TypeError('Notation must be text.');
  if (notation.length > MAX_DSL_LENGTH) throw new Error('The DSL exceeds the 100,000 character limit.');
  const parsed = parseNotation(notation);
  if (parsed.errors.length) throw new Error(`Fix the DSL before converting: ${parsed.errors[0].message}`);
  if (parsed.notes.length > 20_000) throw new Error('The score has too many notes to convert to MusicXML.');
  const warnings = [];
  const timing = createScoreTiming(parsed);
  if (timing.totalBars > 10_000) throw new Error('The score has too many measures to convert to MusicXML.');
  const boundaries = [...new Set([0, ...timing.barsBetween(0, parsed.totalBeats).map(mark => mark.beat), parsed.totalBeats])].sort((a, b) => a - b);
  if (boundaries.length === 1) boundaries.push(0);
  const layout = sourceLayout(notation, parsed);
  const lineBeats = new Set(layout.filter(marker => marker.line).map(marker => marker.beat));
  if ([...lineBeats].some(beat => !boundaries.includes(beat))) warnOnce(warnings, 'Editor line breaks inside a measure are preserved in ChromaPlay metadata; other MusicXML apps may lay them out differently.');
  const measures = [];
  const timedDirectives = parsed.directives.filter(directive => directive.beat > 0);
  const separators = layout.filter(marker => !marker.line);
  let directiveCursor = 0;
  let separatorCursor = 0;
  let xmlLength = escapeXml(notation).length + escapeXml(title).length + 1000;
  let noteIndex = 0;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const settings = timing.settingsAtBeat(start);
    const body = [];
    if (start > 0 && lineBeats.has(start)) body.push('<print new-system="yes"/>');
    if (index === 0) body.push(`<attributes><divisions>8</divisions><time><beats>${parsed.numerator}</beats><beat-type>${parsed.denominator}</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`);
    const events = [];
    if (index === 0) events.push({ beat: 0, order: -2, xml: `<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${parsed.tempo}</per-minute></metronome></direction-type><sound tempo="${parsed.tempo}"/></direction>` });
    while (directiveCursor < timedDirectives.length) {
      const directive = timedDirectives[directiveCursor];
      if (directive.beat > end || (directive.beat === end && index < boundaries.length - 2)) break;
      directiveCursor += 1;
      const xml = directive.kind === 'tempo'
        ? `<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${directive.tempo}</per-minute></metronome></direction-type><sound tempo="${directive.tempo}"/></direction>`
        : `<attributes><time><beats>${directive.numerator}</beats><beat-type>${directive.denominator}</beat-type></time></attributes>`;
      events.push({ beat: directive.beat, order: directive.start, xml });
    }
    while (separatorCursor < separators.length && separators[separatorCursor].beat < end) {
      const marker = separators[separatorCursor++];
      if (marker.beat > start) events.push({ beat: marker.beat, order: -1, xml: '<barline location="middle"><bar-style>regular</bar-style></barline>' });
    }
    while (noteIndex < parsed.notes.length && parsed.notes[noteIndex].endBeat <= start) noteIndex += 1;
    for (let n = noteIndex; n < parsed.notes.length && parsed.notes[n].startBeat < end; n += 1) {
      const note = parsed.notes[n];
      let beat = Math.max(start, note.startBeat);
      const stop = Math.min(end, note.endBeat);
      const pieces = partsForUnits(Math.round((stop - beat) * 8), true);
      for (const [units, token] of pieces) {
        const before = beat > note.startBeat + EPSILON;
        const after = beat + units / 8 < note.endBeat - EPSILON;
        const pitch = note.isRest ? '<rest/>' : `<pitch><step>${PITCHES[note.midi % 12][0]}</step>${PITCHES[note.midi % 12].includes('#') ? '<alter>1</alter>' : ''}<octave>${Math.floor(note.midi / 12) - 1}</octave></pitch>`;
        const ties = note.isRest ? '' : `${before ? '<tie type="stop"/>' : ''}${after ? '<tie type="start"/>' : ''}`;
        const technical = note.isRest ? '' : `<notations>${before ? '<tied type="stop"/>' : ''}${after ? '<tied type="start"/>' : ''}<technical><other-technical>chromaplay:hole=${note.hole};breath=${note.draw ? 'draw' : 'blow'};slide=${note.slider ? 'in' : 'out'}</other-technical></technical></notations>`;
        events.push({ beat, order: note.start + 0.5, xml: `<note>${pitch}<duration>${units}</duration>${ties}<type>${XML_TYPES[token[0]]}</type>${token.endsWith('.') ? '<dot/>' : ''}${technical}</note>` });
        beat += units / 8;
      }
    }
    events.sort((a, b) => a.beat - b.beat || a.order - b.order);
    body.push(...events.map(event => event.xml));
    const implicit = Math.abs(end - start - settings.numerator * 4 / settings.denominator) > EPSILON;
    const measureXml = `    <measure number="${index + 1}"${implicit ? ' implicit="yes"' : ''}>\n      ${body.join('\n      ')}\n    </measure>`;
    xmlLength += measureXml.length;
    if (xmlLength > MAX_MUSICXML_LENGTH) throw new Error('The converted MusicXML exceeds the 2,000,000 character limit.');
    measures.push(measureXml);
  }
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">\n  <work><work-title>${escapeXml(title)}</work-title></work>\n  <identification><miscellaneous><miscellaneous-field name="chromaplay:dsl">${escapeXml(notation)}</miscellaneous-field><miscellaneous-field name="chromaplay:fingerprint"></miscellaneous-field></miscellaneous></identification>\n  <part-list><score-part id="P1"><part-name>Chromatic harmonica</part-name><score-instrument id="I1"><instrument-name>Chromatic harmonica</instrument-name></score-instrument><midi-instrument id="I1"><midi-channel>1</midi-channel><midi-program>23</midi-program></midi-instrument></score-part></part-list>\n  <part id="P1">\n${measures.join('\n')}\n  </part>\n</score-partwise>\n`;
  const tree = parseXml(xml);
  const hash = fingerprint(tree);
  descendants(tree, 'miscellaneous-field').find(field => field.attrs.name === 'chromaplay:fingerprint').children = [hash];
  const pretty = (node, depth = 0) => {
    const indent = '  '.repeat(depth);
    const attrs = Object.entries(node.attrs).map(([name, text]) => ` ${name}="${escapeXml(text)}"`).join('');
    if (!node.children.length) return `${indent}<${node.qualifiedName}${attrs}/>`;
    if (!elements(node).length) return `${indent}<${node.qualifiedName}${attrs}>${escapeXml(content(node))}</${node.qualifiedName}>`;
    return `${indent}<${node.qualifiedName}${attrs}>\n${elements(node).map(child => pretty(child, depth + 1)).join('\n')}\n${indent}</${node.qualifiedName}>`;
  };
  xml = `<?xml version="1.0" encoding="UTF-8"?>\n${pretty(tree)}\n`;
  if (xml.length > MAX_MUSICXML_LENGTH) throw new Error('The converted MusicXML exceeds the 2,000,000 character limit.');
  return { xml, warnings };
}

const FINGERINGS = [];
for (const slider of [false, true]) for (const hole of Array.from({ length: 12 }, (_, index) => index + 1)) for (const draw of [false, true]) {
  FINGERINGS.push({ hole, draw, slider, midi: pitchFor(hole, draw, slider).midi });
}

function fingeringFor(note, midi, warnings) {
  const annotations = descendants(note, 'other-technical').map(content).filter(text => text.trim().startsWith('chromaplay:'));
  for (const text of annotations) {
    const match = /^chromaplay:hole=(\d{1,2});breath=(blow|draw);slide=(in|out)$/.exec(text.trim());
    if (match && Number(match[1]) >= 1 && Number(match[1]) <= 12) {
      const fingering = { hole: Number(match[1]), draw: match[2] === 'draw', slider: match[3] === 'in' };
      if (pitchFor(fingering.hole, fingering.draw, fingering.slider).midi === midi) return fingering;
    }
    warnOnce(warnings, 'A ChromaPlay harmonica annotation was invalid or did not match the sounding pitch. The pitch was used instead.');
  }
  const fingering = FINGERINGS.find(candidate => candidate.midi === midi);
  if (fingering) warnOnce(warnings, 'Notes without matching harmonica annotations use an automatic fingering: slide out first, then the lowest matching hole.');
  else warnOnce(warnings, 'Pitches unavailable on the 12-hole C chromatic harmonica were replaced with rests; no notes were transposed to fit.');
  return fingering || { hole: 0, draw: false, slider: false };
}

function tempoValue(number, warnings) {
  if (!Number.isFinite(number) || number <= 0) throw new Error('Invalid MusicXML tempo: use a positive number.');
  const tempo = Math.max(30, Math.min(300, Math.round(number)));
  if (Math.abs(tempo - number) > EPSILON) warnOnce(warnings, 'Tempos were rounded or limited to the DSL range of 30 to 300 quarter notes per minute.');
  return tempo;
}

function signatureValue(time, warnings) {
  const beats = elements(time, 'beats');
  const beatTypes = elements(time, 'beat-type');
  if (!beats.length || !beatTypes.length) {
    warnOnce(warnings, 'An unmetered or unsupported time signature was replaced with 4/4.');
    return { numerator: 4, denominator: 4 };
  }
  const sum = text => /^\d+(?:\s*\+\s*\d+)*$/.test(text) ? text.split('+').reduce((total, part) => total + Number(part), 0) : NaN;
  let numerator = sum(content(beats[0]).trim());
  let denominator = Number(content(beatTypes[0]));
  if (beats.length > 1 || beatTypes.length > 1) warnOnce(warnings, 'Composite time signatures were simplified to the first beat group.');
  if (content(beats[0]).includes('+')) warnOnce(warnings, 'Additive time-signature groupings were combined into one numerator.');
  if (!Number.isInteger(numerator) || numerator < 1 || !Number.isInteger(denominator) || denominator < 1) throw new Error('Invalid MusicXML time signature.');
  if (denominator === 1 && numerator <= 8) { numerator *= 4; denominator = 4; warnOnce(warnings, 'Whole-note time signatures were expressed using quarter notes.'); }
  if (numerator > 32 || ![2, 4, 8, 16].includes(denominator)) {
    numerator = Math.max(1, Math.min(32, numerator));
    denominator = [2, 4, 8, 16].reduce((best, choice) => Math.abs(choice - denominator) < Math.abs(best - denominator) ? choice : best, 4);
    warnOnce(warnings, 'Time signatures outside the DSL range were simplified (numerator 1 to 32; denominator 2, 4, 8, or 16).');
  }
  return { numerator, denominator };
}

function noteDuration(note, divisions, meter, warnings) {
  const duration = first(note, 'duration');
  if (duration) {
    const beats = Number(content(duration)) / divisions;
    if (!Number.isFinite(beats) || beats <= 0 || beats > 100_000) throw new Error('Invalid MusicXML note duration.');
    return beats;
  }
  if (first(note, 'rest')?.attrs.measure === 'yes') return meter.numerator * 4 / meter.denominator;
  const lengths = { maxima: 32, long: 16, breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125, '64th': 0.0625, '128th': 0.03125, '256th': 0.015625, '512th': 0.0078125, '1024th': 0.00390625 };
  let beats = lengths[value(note, 'type')];
  if (!beats) throw new Error('A MusicXML note is missing its duration.');
  beats *= 2 - 2 ** -elements(note, 'dot').length;
  const modification = first(note, 'time-modification');
  if (modification) {
    const actual = Number(value(modification, 'actual-notes'));
    const normal = Number(value(modification, 'normal-notes'));
    if (!Number.isFinite(actual) || !Number.isFinite(normal) || !(actual > 0 && normal > 0)) throw new Error('Invalid MusicXML tuplet duration.');
    beats *= normal / actual;
  }
  if (!Number.isFinite(beats) || beats <= 0 || beats > 100_000) throw new Error('Invalid MusicXML note duration.');
  warnOnce(warnings, 'Some notes were missing MusicXML duration values; their written note types were used.');
  return beats;
}

/**
 * Import one melody. Information the compact DSL cannot express is reported.
 * beatMap contains {sourceBeat, playbackBeat} boundaries in quarter-note units.
 * Interpolate within each segment to follow the source during rounded playback;
 * at repeated playback boundaries the last sourceBeat takes effect. The source
 * timeline uses the first part's measure durations. sourceMeasureStarts contains
 * one source beat per original measure, without a final end sentinel, so a sheet
 * renderer can align measures whose other parts have a different duration.
 */
export function musicXmlToDsl(xml) {
  const root = parseXml(xml);
  const warnings = [];
  const title = value(first(root, 'work') || root, 'work-title') || value(root, 'movement-title') || undefined;
  const fields = descendants(root, 'miscellaneous-field');
  const savedDsl = fields.find(field => field.attrs.name === 'chromaplay:dsl');
  const savedHash = fields.find(field => field.attrs.name === 'chromaplay:fingerprint');
  let preservedNotation = null;
  let preservedParsed = null;
  if (savedDsl && savedHash && content(savedHash).trim() === fingerprint(root)) {
    const notation = content(savedDsl);
    if (notation.length <= MAX_DSL_LENGTH) {
      const parsed = parseNotation(notation);
      if (!parsed.errors.length) { preservedNotation = notation; preservedParsed = parsed; }
    }
  }
  if (savedDsl && preservedNotation === null) warnOnce(warnings, 'The MusicXML content changed, so its embedded DSL was not reused. The notes and annotations were converted again.');

  let measures;
  if (root.name === 'score-partwise') {
    const parts = elements(root, 'part');
    if (!parts.length) throw new Error('The MusicXML score has no parts.');
    if (parts.length > 1) warnOnce(warnings, 'Only the first part was imported. Other instruments were omitted.');
    measures = elements(parts[0], 'measure').map(measure => ({ node: measure, attrs: measure.attrs }));
  } else {
    const allMeasures = elements(root, 'measure');
    const partId = allMeasures.map(measure => first(measure, 'part')?.attrs.id).find(Boolean);
    if (!partId) throw new Error('The MusicXML score has no parts.');
    if (allMeasures.some(measure => elements(measure, 'part').length > 1)) warnOnce(warnings, 'Only the first part was imported. Other instruments were omitted.');
    measures = allMeasures.map(measure => ({ node: elements(measure, 'part').find(part => part.attrs.id === partId) || { children: [] }, attrs: measure.attrs }));
  }
  if (!measures.length) throw new Error('The MusicXML score has no measures.');
  if (descendants(root, 'repeat').length || descendants(root, 'ending').length || descendants(root, 'sound').some(node => ['dacapo', 'dalsegno', 'tocoda', 'fine'].some(name => Object.hasOwn(node.attrs, name)))) warnOnce(warnings, 'Repeats, endings, and navigation marks were not expanded. Measures play once in written order.');
  const omitted = ['lyric', 'dynamics', 'articulations', 'ornaments', 'harmony', 'pedal', 'wedge', 'slur', 'octave-shift'];
  if (omitted.some(name => descendants(root, name).length)) warnOnce(warnings, 'Lyrics, dynamics, articulations, ornaments, and other unsupported performance or engraving details are not represented in the DSL.');
  if (descendants(root, 'time-modification').length) warnOnce(warnings, 'Tuplet timing was converted to the closest durations available in the DSL.');

  let divisions = 1;
  let meter = { numerator: 4, denominator: 4 };
  let transpose = 0;
  let measureStart = 0;
  let selectedVoice;
  let selectedStaff;
  let order = 0;
  const notes = [];
  const directives = [];
  const markers = [];
  const sourceMeasureStarts = [];
  for (const [measureIndex, measure] of measures.entries()) {
    sourceMeasureStarts.push(measureStart);
    let cursor = 0;
    let extent = 0;
    let previousNoteStart = 0;
    if (measureIndex > 0) markers.push({ beat: measureStart, token: '|' });
    for (const child of elements(measure.node)) {
      const beat = measureStart + cursor;
      if (child.name === 'attributes') {
        if (first(child, 'divisions')) {
          divisions = Number(value(child, 'divisions'));
          if (!Number.isFinite(divisions) || divisions <= 0 || divisions > 1_000_000_000) throw new Error('Invalid MusicXML divisions value.');
        }
        const time = first(child, 'time');
        if (time) { meter = signatureValue(time, warnings); directives.push({ beat, order: order++, token: `TSIG ${meter.numerator}/${meter.denominator}` }); }
        const transposition = first(child, 'transpose');
        if (transposition) {
          transpose = Number(value(transposition, 'chromatic') || 0) + 12 * Number(value(transposition, 'octave-change') || 0);
          if (!Number.isFinite(transpose)) throw new Error('Invalid MusicXML transposition.');
          if (transpose) warnOnce(warnings, 'Written pitches were converted to sounding pitches using the instrument transposition.');
        }
      } else if (child.name === 'direction' || child.name === 'sound') {
        const sound = child.name === 'sound' ? child : first(child, 'sound');
        // A sound offset takes precedence over its parent direction offset.
        const offsetNode = (sound && first(sound, 'offset')) || first(child, 'offset');
        const offset = Number(offsetNode ? content(offsetNode) : 0) / divisions;
        if (!Number.isFinite(offset) || Math.abs(offset) > 100_000 || beat + offset > 100_000) throw new Error('Invalid MusicXML direction offset: the score limit is 100,000 quarter-note beats.');
        let tempo = sound?.attrs.tempo !== undefined ? Number(sound.attrs.tempo) : undefined;
        if (tempo === undefined) {
          const metronome = descendants(child, 'metronome')[0];
          if (metronome) {
            const unit = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125 }[value(metronome, 'beat-unit')];
            const perMinute = Number(value(metronome, 'per-minute'));
            if (unit && perMinute > 0) tempo = unit * (2 - 2 ** -elements(metronome, 'beat-unit-dot').length) * perMinute;
            else warnOnce(warnings, 'A nonnumeric or unsupported metronome marking was omitted.');
          }
        }
        if (tempo !== undefined) directives.push({ beat: Math.max(0, beat + offset), order: order++, token: `TEMPO ${tempoValue(tempo, warnings)}` });
      } else if (child.name === 'backup' || child.name === 'forward') {
        const duration = Number(value(child, 'duration')) / divisions;
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid MusicXML cursor duration.');
        cursor += child.name === 'backup' ? -duration : duration;
        if (cursor < -EPSILON) throw new Error('Invalid MusicXML: a backup moves before the measure start.');
        cursor = Math.max(0, cursor);
        extent = Math.max(extent, cursor);
      } else if (child.name === 'print' && (child.attrs['new-system'] === 'yes' || child.attrs['new-page'] === 'yes')) markers.push({ beat, token: 'L' });
      else if (child.name === 'barline' && child.attrs.location === 'middle') markers.push({ beat, token: '|' });
      else if (child.name === 'note') {
        if (first(child, 'grace')) { warnOnce(warnings, 'Grace notes were omitted.'); continue; }
        const duration = noteDuration(child, divisions, meter, warnings);
        const chord = Boolean(first(child, 'chord'));
        const noteStart = chord ? previousNoteStart : cursor;
        if (!chord) { previousNoteStart = cursor; cursor += duration; }
        extent = Math.max(extent, noteStart + duration, cursor);
        const voice = value(child, 'voice') || '1';
        const staff = value(child, 'staff') || '1';
        if (selectedVoice === undefined) { selectedVoice = voice; selectedStaff = staff; }
        if (voice !== selectedVoice || staff !== selectedStaff) { warnOnce(warnings, 'Only the first encountered voice and staff were imported. Other voices and staves were omitted.'); continue; }
        if (chord) { warnOnce(warnings, 'Chords were reduced to their first written note.'); continue; }
        let midi = null;
        if (!first(child, 'rest')) {
          const pitch = first(child, 'pitch');
          if (pitch) {
            const step = STEPS[value(pitch, 'step')];
            const octave = Number(value(pitch, 'octave'));
            const alter = Number(value(pitch, 'alter') || 0);
            if (step === undefined || !Number.isInteger(octave) || !Number.isFinite(alter)) throw new Error('Invalid MusicXML pitch.');
            midi = 12 * (octave + 1) + step + alter + transpose;
          } else warnOnce(warnings, 'Unpitched notes were replaced with rests.');
        }
        const fingering = midi === null ? { hole: 0, draw: false, slider: false } : fingeringFor(child, midi, warnings);
        const ties = [...elements(child, 'tie'), ...descendants(child, 'tied')].map(tie => tie.attrs.type);
        notes.push({ start: measureStart + noteStart, end: measureStart + noteStart + duration, midi, ...fingering, tieStart: ties.includes('start'), tieStop: ties.includes('stop'), order: order++ });
      }
    }
    // Empty measures still occupy a bar; pickups and partial measures keep
    // their actual duration rather than acquiring unrequested leading rests.
    measureStart += extent || (measure.attrs.implicit === 'yes' ? 0 : meter.numerator * 4 / meter.denominator);
    if (measureStart > 100_000) throw new Error('The MusicXML score is too long to convert.');
  }

  // Read the original XML measure timing above, but do not reconstruct or round
  // an unchanged ChromaPlay source. Its playback and source beats are identical.
  if (preservedNotation !== null) {
    const boundaries = [...new Set([0, ...preservedParsed.notes.map(note => note.endBeat), ...preservedParsed.directives.map(directive => directive.beat)])].sort((a, b) => a - b);
    return {
      notation: preservedNotation, warnings: [], title, sourceMeasureStarts,
      beatMap: boundaries.map(beat => ({ sourceBeat: beat, playbackBeat: beat })),
    };
  }

  notes.sort((a, b) => a.start - b.start || a.order - b.order);
  const melody = [];
  for (const note of notes) {
    const previous = melody.at(-1);
    const same = previous && previous.midi === note.midi && previous.hole === note.hole && previous.draw === note.draw && previous.slider === note.slider;
    if (previous && previous.tieStart && note.tieStop && same && Math.abs(previous.end - note.start) < EPSILON) {
      previous.end = note.end;
      previous.tieStart = note.tieStart;
      previous.mergedTie = true;
    } else if (previous && note.start < previous.end - EPSILON) warnOnce(warnings, 'Overlapping notes were omitted because the DSL plays one note at a time.');
    else melody.push(note);
  }
  if (!directives.some(item => item.beat < EPSILON && item.token.startsWith('TEMPO'))) directives.push({ beat: 0, order: -2, token: 'TEMPO 60' });
  if (!directives.some(item => item.beat < EPSILON && item.token.startsWith('TSIG'))) directives.push({ beat: 0, order: -1, token: 'TSIG 4/4' });
  directives.sort((a, b) => a.beat - b.beat || a.order - b.order);
  const output = [];
  let directiveIndex = 0;
  let markerIndex = 0;
  let position = 0;
  let playbackBeat = 0;
  const beatMap = [{ sourceBeat: 0, playbackBeat: 0 }];
  const recordBoundary = sourceBeat => {
    const previous = beatMap.at(-1);
    // The importer tolerates sub-EPSILON overlaps from fractional divisions;
    // that rounding noise must not make the sheet cursor run backward.
    sourceBeat = Math.max(previous.sourceBeat, sourceBeat);
    if (sourceBeat !== previous.sourceBeat || playbackBeat !== previous.playbackBeat) beatMap.push({ sourceBeat, playbackBeat });
  };
  markers.sort((a, b) => a.beat - b.beat || a.token.localeCompare(b.token));
  const emitDuration = (note, from, to, split = false) => {
    const beats = to - from;
    if (beats <= EPSILON) return;
    const units = Math.max(2, Math.round(beats * 8));
    if (Math.abs(units / 8 - beats) > EPSILON) warnOnce(warnings, 'Durations shorter than a sixteenth note or between supported values were rounded to nearby DSL durations.');
    const pieces = partsForUnits(units);
    if (note.hole && (split || pieces.length > 1)) warnOnce(warnings, 'Some sustained notes were split into several DSL notes and will be articulated again during playback.');
    recordBoundary(from);
    let emittedUnits = 0;
    for (const [pieceUnits, length] of pieces) {
      output.push(`${note.draw ? '-' : ''}${note.hole}${note.slider && note.hole ? '#' : ''}${length}`);
      emittedUnits += pieceUnits;
      playbackBeat += pieceUnits / 8;
      // A rounded sustained span is traversed at a constant ratio, including
      // when its duration requires several DSL notes. Preserve exact endpoints.
      recordBoundary(emittedUnits === units ? to : from + beats * emittedUnits / units);
    }
  };
  const emitMarkers = at => {
    while (markerIndex < markers.length && markers[markerIndex].beat <= at + EPSILON) {
      const marker = markers[markerIndex++];
      if (Math.abs(marker.beat - at) < EPSILON && at > EPSILON) output.push(marker.token);
    }
  };
  const emitDirectives = at => {
    emitMarkers(at);
    while (directiveIndex < directives.length && directives[directiveIndex].beat <= at + EPSILON) output.push(directives[directiveIndex++].token);
  };
  const emitSpan = (note, from, to) => {
    let cursor = from;
    emitDirectives(cursor);
    while (directiveIndex < directives.length && directives[directiveIndex].beat < to - EPSILON) {
      const change = directives[directiveIndex].beat;
      emitDuration(note, cursor, change, true);
      cursor = change;
      emitDirectives(cursor);
    }
    emitDuration(note, cursor, to, cursor !== from);
  };
  const rest = { hole: 0, draw: false, slider: false };
  for (const note of melody) {
    if (note.start > position + EPSILON) emitSpan(rest, position, note.start);
    emitSpan(note, note.start, note.end);
    position = note.end;
  }
  if (measureStart > position + EPSILON) emitSpan(rest, position, measureStart);
  emitDirectives(measureStart);
  while (directiveIndex < directives.length) {
    const next = directives[directiveIndex].beat;
    emitSpan(rest, measureStart, next);
    measureStart = next;
    emitDirectives(next);
  }
  const notation = output.join(' ').replace(/\s*\|\s*/g, ' | ').replace(/\s*L\s*/g, ' L\n').trim();
  if (notation.length > MAX_DSL_LENGTH) throw new Error('The converted DSL exceeds the 100,000 character limit.');
  if (parseNotation(notation).errors.length) throw new Error('This MusicXML score could not be represented as valid ChromaPlay notation.');
  return { notation, warnings, title, beatMap, sourceMeasureStarts };
}
