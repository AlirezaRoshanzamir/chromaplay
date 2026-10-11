import { parseNotation } from './notation.js';

export const DEFAULT_PROJECT = Object.freeze({
  version: 1,
  title: 'Morning warm-up',
  notation: [
    '1q -1q 2q -2q | 3q -3q -4q 4q',
    '5q -4q -3q 3q | -2q 2q -1q 1q',
    '1e -1e 2e -2e 3e -3e -4e 4e | 4q -4q -3q 3q',
    '-2q 2q -1q 1q | 1h 0h',
  ].join('\n'),
  tempo: 90,
  numerator: 4,
  denominator: 4,
  backgroundOffset: 0,
  noteVolume: 70,
  backgroundVolume: 65,
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

/** Validate and copy known project fields. This never retains audio or unknown data. */
export function validateProject(input, { allowInvalidNotation = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('The project must be a JSON object.');
  }
  if (Object.hasOwn(input, 'format') && input.format !== PROJECT_FORMAT) {
    throw new Error('This file is not a ChromaPlay project.');
  }
  if (Object.hasOwn(input, 'version') && input.version !== 1) {
    throw new Error('This project version is not supported. Use a version 1 project.');
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
  if (typeof project.title !== 'string' || project.title.length > 100) {
    throw new Error('The title must be text with 100 characters or fewer.');
  }
  checkNumber(project.tempo, 'Tempo', 30, 300, true);
  checkNumber(project.numerator, 'Time signature numerator', 1, 32, true);
  if (![2, 4, 8, 16].includes(project.denominator)) {
    throw new Error('The time signature denominator must be 2, 4, 8, or 16.');
  }
  checkNumber(project.backgroundOffset, 'Background offset', -600, 600);
  checkNumber(project.noteVolume, 'Note volume', 0, 100);
  checkNumber(project.backgroundVolume, 'Background volume', 0, 100);
  for (const field of ['metronome', 'loop']) {
    if (typeof project[field] !== 'boolean') {
      throw new Error(`${field === 'loop' ? 'Loop' : 'Metronome'} must be true or false.`);
    }
  }

  if (!allowInvalidNotation) {
    const { errors } = parseNotation(project.notation);
    if (errors.length) {
      const error = errors[0];
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
