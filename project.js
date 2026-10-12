import { parseNotation } from './notation.js';

export const DEFAULT_PROJECT = Object.freeze({
  version: 4,
  title: 'Morning warm-up',
  notation: [
    'TEMPO 90',
    'TSIG 4/4',
    '1q -1q 2q -2q | 3q -3q -4q 4q',
    '5q -4q -3q 3q | -2q 2q -1q 1q',
    '1e -1e 2e -2e 3e -3e -4e 4e | 4q -4q -3q 3q',
    '-2q 2q -1q 1q | 1h 0h',
  ].join('\n'),
  tempo: 90,
  numerator: 4,
  denominator: 4,
  instrument: 'fluid',
  noteOffset: 0,
  backgroundOffset: 0,
  metronomeOffset: 0,
  noteVolume: 70,
  backgroundVolume: 65,
  metronomeVolume: 70,
  noteMuted: false,
  backgroundMuted: false,
  metronome: false,
  loop: false,
});

const PROJECT_FORMAT = 'chromaplay';
const MAX_NOTATION_LENGTH = 100_000;

function checkNumber(value, field, minimum, maximum, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new Error(`${field} must be ${integer ? 'a whole number' : 'a number'} from ${minimum} to ${maximum}.`);
  }
}

/** Move old playback settings into the score once, when a version 1 file opens. */
function migrateLegacyNotation(input) {
  let notation = input.notation;
  const { directives } = parseNotation(notation);
  const tempoHeader = directives.find((directive) => directive.kind === 'tempo');
  const signatureHeader = directives.some((directive) => directive.kind === 'time-signature');
  if (!signatureHeader && (Object.hasOwn(input, 'numerator') || Object.hasOwn(input, 'denominator'))) {
    const numerator = Object.hasOwn(input, 'numerator') ? input.numerator : 4;
    const denominator = Object.hasOwn(input, 'denominator') ? input.denominator : 4;
    checkNumber(numerator, 'Time signature numerator', 1, 32, true);
    if (![2, 4, 8, 16].includes(denominator)) {
      throw new Error('The time signature denominator must be 2, 4, 8, or 16.');
    }
    const line = `TSIG ${numerator}/${denominator}\n`;
    if (tempoHeader) {
      const end = tempoHeader.end;
      const newline = /^(?:\r\n|\n|\r)/.exec(notation.slice(end));
      const insertAt = end + (newline?.[0].length || 0);
      notation = `${notation.slice(0, insertAt)}${newline ? '' : '\n'}${line}${notation.slice(insertAt)}`;
    } else {
      notation = line + notation;
    }
  }
  if (!tempoHeader && Object.hasOwn(input, 'tempo')) {
    checkNumber(input.tempo, 'Tempo', 30, 300, true);
    notation = `TEMPO ${input.tempo}\n${notation}`;
  }
  return notation;
}

/** Validate and copy known project fields. This never retains audio or unknown data. */
export function validateProject(input, { allowInvalidNotation = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('The project must be a JSON object.');
  }
  if (Object.hasOwn(input, 'format') && input.format !== PROJECT_FORMAT) {
    throw new Error('This file is not a ChromaPlay project.');
  }
  if (Object.hasOwn(input, 'version') && ![1, 2, 3, 4].includes(input.version)) {
    throw new Error('This project version is not supported. Use a version 1, 2, 3, or 4 project.');
  }
  if (!Object.hasOwn(input, 'notation') || typeof input.notation !== 'string') {
    throw new Error('The project must include notation as text.');
  }
  if (input.notation.length > MAX_NOTATION_LENGTH) {
    throw new Error('Notation must contain 100,000 characters or fewer.');
  }

  const project = {};
  for (const field of Object.keys(DEFAULT_PROJECT)) {
    project[field] = Object.hasOwn(input, field) ? input[field] : DEFAULT_PROJECT[field];
  }
  project.version = 4;
  project.notation = [2, 3, 4].includes(input.version) ? input.notation : migrateLegacyNotation(input);
  if (typeof project.title !== 'string' || project.title.length > 100) {
    throw new Error('The title must be text with 100 characters or fewer.');
  }
  if (!['synth', 'fluid', 'vcsl'].includes(project.instrument)) {
    throw new Error('Choose Synthesized reed, FluidR3 harmonica, or VCSL chromatic harmonica.');
  }
  checkNumber(project.noteOffset, 'Notes start delay', -600, 600);
  checkNumber(project.backgroundOffset, 'Track start delay', -600, 600);
  checkNumber(project.noteVolume, 'Note volume', 0, 100);
  checkNumber(project.backgroundVolume, 'Background volume', 0, 100);
  const booleanLabels = { metronome: 'Metronome', loop: 'Loop', noteMuted: 'Notes mute', backgroundMuted: 'Backing track mute' };
  for (const [field, label] of Object.entries(booleanLabels)) {
    if (typeof project[field] !== 'boolean') {
      throw new Error(`${label} must be true or false.`);
    }
  }
  // Older scores kept mute separate from volume. Show that state on the slider
  // so raising its value always restores sound without a hidden mute flag.
  for (const channel of ['note', 'background']) {
    if (project[`${channel}Muted`]) project[`${channel}Volume`] = 0;
    project[`${channel}Muted`] = false;
  }
  // Earlier versions tied the click to the notes. Copy those settings once;
  // current scores keep the metronome independent, even when a field is absent.
  if (input.version !== 4) {
    if (!Object.hasOwn(input, 'metronomeOffset')) project.metronomeOffset = project.noteOffset;
    if (!Object.hasOwn(input, 'metronomeVolume')) project.metronomeVolume = project.noteVolume;
  }
  checkNumber(project.metronomeOffset, 'Metronome start delay', -600, 600);
  checkNumber(project.metronomeVolume, 'Metronome volume', 0, 100);

  const parsed = parseNotation(project.notation);
  project.tempo = parsed.tempo;
  project.numerator = parsed.numerator;
  project.denominator = parsed.denominator;
  if (!allowInvalidNotation) {
    if (parsed.errors.length) {
      const error = parsed.errors[0];
      const precedingLines = project.notation.slice(0, error.start).split('\n');
      const line = precedingLines.length;
      const column = precedingLines[line - 1].length + 1;
      throw new Error(`Invalid notation at line ${line}, column ${column}: ${error.message}`);
    }
  }
  return project;
}

/** Import a saved JSON project or a plain-text notation file. */
export function parseProjectFile(text, filename) {
  if (typeof text !== 'string') throw new Error('The file must contain text.');
  if (typeof filename !== 'string') throw new Error('Choose a .chroma, .json, or .txt file.');
  // Some text editors add a UTF-8 byte-order mark at the start of a file.
  const content = text.replace(/^\uFEFF/, '');
  const extension = /\.([^.]+)$/.exec(filename)?.[1].toLowerCase();
  if (extension === 'txt') {
    const basename = filename.split(/[\\/]/).pop().replace(/\.txt$/i, '');
    return validateProject({
      ...DEFAULT_PROJECT,
      title: basename.trim().slice(0, 100) || 'Untitled practice',
      notation: content,
    });
  }
  if (extension !== 'chroma' && extension !== 'json') {
    throw new Error('Choose a .chroma, .json, or .txt file.');
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('This file does not contain valid JSON. Choose a ChromaPlay project or import notation as .txt.');
  }
  return validateProject(parsed);
}

/** Export settings and notation only. Background audio stays on the device. */
export function serializeProject(project) {
  return `${JSON.stringify({ format: PROJECT_FORMAT, ...validateProject(project) }, null, 2)}\n`;
}
