import { dslToMusicXml, musicXmlToDsl } from './musicxml.js';

/** Only the selected source is authoritative. Never keep an old generated view on errors. */
export function deriveScoreFormats(project) {
  const format = project.scoreFormat || 'dsl';
  try {
    if (format === 'musicxml') {
      const converted = musicXmlToDsl(project.musicxml);
      return { notation: converted.notation, musicxml: project.musicxml, warnings: converted.warnings, error: null };
    }
    const converted = dslToMusicXml(project.notation, { title: project.title });
    return { notation: project.notation, musicxml: converted.xml, warnings: converted.warnings, error: null };
  } catch (error) {
    return { notation: format === 'dsl' ? project.notation : '', musicxml: format === 'musicxml' ? project.musicxml : '', warnings: [], error: error.message || 'The score could not be converted.' };
  }
}

/** Called only after the user confirms the possible loss of conversion details. */
export function switchScoreFormat(project, format) {
  if (!['dsl', 'musicxml'].includes(format)) throw new Error('Choose DSL or MusicXML.');
  if (format === (project.scoreFormat || 'dsl')) return { ...project };
  const derived = deriveScoreFormats(project);
  if (derived.error) throw new Error(derived.error);
  return { ...project, scoreFormat: format, notation: derived.notation, musicxml: format === 'musicxml' ? derived.musicxml : '' };
}
