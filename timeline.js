function secondsOffset(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(-600, Math.min(600, seconds)) : 0;
}

/** Describe two clips on a common clock; one beat is always a quarter note. */
export function createTimeline({ notes = [], bpm = 100, noteOffset = 0, backgroundOffset = 0, backgroundDuration = 0 } = {}) {
  const tempo = Number(bpm);
  if (!Number.isFinite(tempo) || tempo <= 0) throw new Error('Tempo must be greater than zero.');
  const scoreBeats = notes.reduce((end, note) => Math.max(end, Number(note.endBeat) || 0), 0);
  const secondsPerBeat = 60 / tempo;
  const scoreDuration = scoreBeats * secondsPerBeat;
  const trackDuration = Number.isFinite(Number(backgroundDuration)) ? Math.max(0, Number(backgroundDuration)) : 0;
  const hasNotes = scoreDuration > 0;
  const hasBackground = trackDuration > 0;
  const noteStartSeconds = secondsOffset(noteOffset);
  const noteEndSeconds = noteStartSeconds + scoreDuration;
  const backgroundStartSeconds = secondsOffset(backgroundOffset);
  const backgroundEndSeconds = backgroundStartSeconds + trackDuration;
  const starts = [];
  const ends = [];
  if (hasNotes) { starts.push(noteStartSeconds); ends.push(noteEndSeconds); }
  if (hasBackground) { starts.push(backgroundStartSeconds); ends.push(backgroundEndSeconds); }
  const startSeconds = Math.min(0, ...starts);
  const endSeconds = ends.length ? Math.max(...ends) : 0;
  const durationSeconds = endSeconds - startSeconds;
  return {
    startSeconds,
    endSeconds,
    durationSeconds,
    startBeat: startSeconds / secondsPerBeat,
    endBeat: endSeconds / secondsPerBeat,
    durationBeats: durationSeconds / secondsPerBeat,
    scoreBeats,
    scoreDuration,
    noteStartSeconds,
    noteEndSeconds,
    noteStartBeat: noteStartSeconds / secondsPerBeat,
    noteEndBeat: noteEndSeconds / secondsPerBeat,
    backgroundStartSeconds,
    backgroundEndSeconds,
    backgroundDuration: trackDuration,
    hasNotes,
    hasBackground,
  };
}
