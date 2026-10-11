// Standard C solo tuning, expressed as MIDI note numbers.
// Hohner's tuning chart: https://hohner.de/fileadmin/documents/instruments/harmonicas/2025_tuning_chart.pdf
const BLOW_NOTES = Object.freeze([60, 64, 67, 72, 72, 76, 79, 84, 84, 88, 91, 96]);
const DRAW_NOTES = Object.freeze([62, 65, 69, 71, 74, 77, 81, 83, 86, 89, 93, 95]);
const PITCH_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);

export const DURATION_BEATS = Object.freeze({ w: 4, h: 2, q: 1, e: 0.5, s: 0.25 });

/** Headers occupy their own lines and never contribute notes or beats. */
function parseHeaders(source) {
  const result = { tempo: 60, numerator: 4, denominator: 4, directives: [], errors: [] };
  const seen = new Set();
  let bodyStarted = false;
  for (const line of source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!line[0]) continue;
    const text = line[0].replace(/[\r\n]+$/, '');
    const match = /\b(TEMPO|TEMP|TSIG)(?![a-z])/i.exec(text);
    if (!match) {
      if (text.trim()) bodyStarted = true;
      continue;
    }

    const keyword = match[1].toUpperCase();
    const kind = keyword === 'TSIG' ? 'time-signature' : 'tempo';
    const start = line.index + match.index;
    const end = line.index + text.length;
    const directive = { kind, start, end, valid: false };
    result.directives.push(directive);
    if (text.slice(0, match.index).trim()) bodyStarted = true;
    const header = text.slice(match.index).trim();
    const value = kind === 'tempo'
      ? /^(?:TEMPO|TEMP)\s+(\d+)$/i.exec(header)
      : /^TSIG\s+(\d+)\s*\/\s*(\d+)$/i.exec(header);
    let message = '';
    if (bodyStarted) message = `Put ${keyword} on its own header line before the notes.`;
    else if (seen.has(kind)) message = `Use only one ${kind === 'tempo' ? 'TEMPO' : 'TSIG'} header.`;
    else if (kind === 'tempo') {
      const tempo = value ? Number(value[1]) : NaN;
      if (!Number.isInteger(tempo) || tempo < 30 || tempo > 300) message = 'Use TEMPO followed by a whole number from 30 to 300, such as TEMPO 60.';
      else directive.tempo = tempo;
    } else {
      const numerator = value ? Number(value[1]) : NaN;
      const denominator = value ? Number(value[2]) : NaN;
      if (!Number.isInteger(numerator) || numerator < 1 || numerator > 32 || ![2, 4, 8, 16].includes(denominator)) {
        message = 'Use TSIG with a numerator from 1 to 32 and a denominator of 2, 4, 8, or 16, such as TSIG 4/4.';
      } else Object.assign(directive, { numerator, denominator });
    }
    seen.add(kind);
    if (message) result.errors.push({ message, start, end });
    else {
      directive.valid = true;
      if (kind === 'tempo') result.tempo = directive.tempo;
      else {
        result.numerator = directive.numerator;
        result.denominator = directive.denominator;
      }
    }
  }
  return result;
}

/** Return sounding pitch in scientific pitch notation. A zero hole is a rest. */
export function pitchFor(hole, draw = false, slider = false) {
  if (hole === 0) return { midi: null, pitch: null };
  if (!Number.isInteger(hole) || hole < 1 || hole > 12) {
    throw new RangeError('Choose a hole from 1 to 12.');
  }
  // The top slide-in draw reed is D7 in the standard Hohner solo layout.
  // The # token means press the slider, rather than a written accidental.
  const midi = slider && draw && hole === 12
    ? 98
    : (draw ? DRAW_NOTES : BLOW_NOTES)[hole - 1] + (slider ? 1 : 0);
  return { midi, pitch: `${PITCH_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}` };
}

/**
 * Parse [+|-]hole[#]duration[.] with quarter-note beats.
 * Whitespace and bar separators are ignored, including inside a note.
 * Uppercase L ends a visual line without adding time or joining note fragments.
 * Optional TEMPO/TEMP and TSIG header lines set timing before any notes.
 * start/end are original source offsets (end exclusive); token is compact.
 * Valid notes remain available for editing when errors exist. Playback callers
 * must check errors before using this timeline.
 */
export function parseNotation(source) {
  if (typeof source !== 'string') throw new TypeError('Notation must be text.');

  const headers = parseHeaders(source);
  let compact = '';
  const offsets = [];
  let directiveIndex = 0;
  for (let i = 0; i < source.length; i += 1) {
    const directive = headers.directives[directiveIndex];
    if (directive && i === directive.start) {
      // A boundary prevents note fragments on either side of an invalid,
      // misplaced header from being joined when whitespace is removed.
      compact += 'L';
      offsets.push(i);
      i = directive.end - 1;
      directiveIndex += 1;
      continue;
    }
    if (/\s/.test(source[i]) || source[i] === '|') continue;
    compact += source[i];
    offsets.push(i);
  }

  const notes = [];
  const errors = [...headers.errors];
  let cursor = 0;
  let totalBeats = 0;
  const isDigit = (character) => character !== undefined && /[0-9]/.test(character);
  const isStart = (character) => isDigit(character) || character === '+' || character === '-';
  const addError = (message, from, to) => {
    errors.push({ message, start: offsets[from], end: offsets[Math.max(from, to - 1)] + 1 });
  };
  const recover = () => {
    while (cursor < compact.length && compact[cursor] !== 'L' && !isStart(compact[cursor])) cursor += 1;
  };

  while (cursor < compact.length) {
    if (compact[cursor] === 'L') {
      cursor += 1;
      continue;
    }
    const from = cursor;
    let sign = '';
    if (compact[cursor] === '+' || compact[cursor] === '-') {
      sign = compact[cursor];
      cursor += 1;
    }

    const numberStart = cursor;
    while (isDigit(compact[cursor])) cursor += 1;
    if (cursor === numberStart) {
      // Always advance past an unexpected character, but preserve a following
      // sign so a valid note after the error can still be edited.
      if (cursor === from) cursor += 1;
      recover();
      addError('Expected a hole from 1 to 12, or 0 for a rest.', from, cursor);
      continue;
    }

    const numberText = compact.slice(numberStart, cursor);
    const hole = Number(numberText);
    const slider = compact[cursor] === '#';
    if (slider) cursor += 1;

    const duration = compact[cursor];
    if (!Object.hasOwn(DURATION_BEATS, duration)) {
      recover();
      addError('Add a duration: w, h, q, e, or s.', from, cursor);
      continue;
    }
    cursor += 1;
    const dotted = compact[cursor] === '.';
    if (dotted) cursor += 1;

    if (hole > 12 || (numberText.length > 1 && numberText[0] === '0')) {
      addError('Use a hole from 1 to 12, or 0 for a rest.', from, cursor);
      continue;
    }
    if (hole === 0 && (sign || slider)) {
      addError('A rest uses 0 and a duration, without a sign or #.', from, cursor);
      continue;
    }

    const beats = DURATION_BEATS[duration] * (dotted ? 1.5 : 1);
    const index = notes.length;
    notes.push({
      id: `note-${index}`,
      index,
      hole,
      draw: sign === '-',
      slider,
      duration,
      dotted,
      beats,
      startBeat: totalBeats,
      endBeat: totalBeats + beats,
      ...pitchFor(hole, sign === '-', slider),
      token: compact.slice(from, cursor),
      start: offsets[from],
      end: offsets[cursor - 1] + 1,
      isRest: hole === 0,
    });
    totalBeats += beats;
  }

  errors.sort((first, second) => first.start - second.start);
  return { notes, errors, totalBeats, tempo: headers.tempo, numerator: headers.numerator, denominator: headers.denominator, directives: headers.directives };
}

/** Format a nonnegative elapsed duration as minutes:seconds. */
export function formatDuration(seconds) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
