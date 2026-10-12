function secondsOffset(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(-600, Math.min(600, seconds)) : 0;
}

/** Describe independently shifted clips on a clock that begins at zero. */
export function createTimeline({ notes = [], bpm = 100, noteOffset = 0, backgroundOffset = 0, backgroundDuration = 0, metronome = false, metronomeOffset = 0 } = {}) {
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
  const metronomeDuration = Math.max(scoreDuration, trackDuration);
  const hasMetronome = Boolean(metronome) && metronomeDuration > 0;
  const metronomeStartSeconds = secondsOffset(metronomeOffset);
  const metronomeEndSeconds = metronomeStartSeconds + metronomeDuration;
  const ends = [];
  if (hasNotes) ends.push(noteEndSeconds);
  if (hasBackground) ends.push(backgroundEndSeconds);
  if (hasMetronome) ends.push(metronomeEndSeconds);
  const startSeconds = 0;
  const endSeconds = Math.max(0, ...ends);
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
    metronomeDuration,
    metronomeStartSeconds,
    metronomeEndSeconds,
    metronomeStartBeat: metronomeStartSeconds / secondsPerBeat,
    metronomeEndBeat: metronomeEndSeconds / secondsPerBeat,
    hasNotes,
    hasBackground,
    hasMetronome,
  };
}
