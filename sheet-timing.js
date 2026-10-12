/** Index of the final point whose position is at or before value. */
function pointIndex(points, key, value) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle][key] <= value) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function spanSlope(first, second) {
  if (!first || !second) return 1;
  const slope = (second.sourceBeat - first.sourceBeat) / (second.playbackBeat - first.playbackBeat);
  // Extending a flat endpoint must still put out-of-score positions outside it.
  return Number.isFinite(slope) && slope > 0 ? slope : 1;
}

/**
 * Map the simplified playback score back to the original MusicXML engraving.
 * All positions use quarter-note beats. Prepare this once when the score/layout
 * changes; both lookup functions use binary search during playback and seeking.
 *
 * beatMap entries are {sourceBeat, playbackBeat}. Duplicate playback boundaries
 * approach the first source position, then jump to the last at that boundary.
 * Measure starts are parallel number arrays, without a final-end sentinel.
 */
export function createSheetBeatMap(beatMap, sourceMeasureStarts = [], displayMeasureStarts = []) {
  const points = (Array.isArray(beatMap) ? beatMap : [])
    .filter(point => point && Number.isFinite(point.sourceBeat) && Number.isFinite(point.playbackBeat))
    .map(({ sourceBeat, playbackBeat }) => ({ sourceBeat, playbackBeat }))
    .sort((first, second) => first.playbackBeat - second.playbackBeat);
  const measures = (Array.isArray(sourceMeasureStarts) ? sourceMeasureStarts : [])
    .map((sourceBeat, index) => ({ sourceBeat, displayBeat: displayMeasureStarts?.[index] }))
    .filter(point => Number.isFinite(point.sourceBeat) && Number.isFinite(point.displayBeat))
    .sort((first, second) => first.sourceBeat - second.sourceBeat);

  const firstGroupEnd = points.length ? pointIndex(points, 'playbackBeat', points[0].playbackBeat) : -1;
  let lastGroupStart = points.length - 1;
  while (lastGroupStart > 0 && points[lastGroupStart - 1].playbackBeat === points.at(-1).playbackBeat) lastGroupStart -= 1;
  const firstSlope = spanSlope(points[firstGroupEnd], points[firstGroupEnd + 1]);
  const lastSlope = spanSlope(points[lastGroupStart - 1], points[lastGroupStart]);

  const sourceBeatAt = playbackBeat => {
    if (!Number.isFinite(playbackBeat)) return NaN;
    if (!points.length) return playbackBeat;
    const index = pointIndex(points, 'playbackBeat', playbackBeat);
    if (index < 0) return points[0].sourceBeat + (playbackBeat - points[0].playbackBeat) * firstSlope;
    const current = points[index];
    const next = points[index + 1];
    if (!next) return current.sourceBeat + (playbackBeat - current.playbackBeat) * lastSlope;
    const fraction = (playbackBeat - current.playbackBeat) / (next.playbackBeat - current.playbackBeat);
    return current.sourceBeat + (next.sourceBeat - current.sourceBeat) * fraction;
  };

  const displayBeatAt = playbackBeat => {
    const sourceBeat = sourceBeatAt(playbackBeat);
    if (!Number.isFinite(sourceBeat) || !measures.length) return sourceBeat;
    const measure = measures[Math.max(0, pointIndex(measures, 'sourceBeat', sourceBeat))];
    return measure.displayBeat + sourceBeat - measure.sourceBeat;
  };

  return { sourceBeatAt, displayBeatAt };
}
