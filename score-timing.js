// The score uses quarter-note beats. This map converts them to source seconds;
// global playback speed belongs to the player and does not change this map.
const EPSILON = 1e-9;
const beatsPerBar = segment => segment.numerator * 4 / segment.denominator;

/** Index of the final segment whose position is at or before value. */
function segmentIndex(segments, key, value) {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle][key] <= value) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

/** Build an invertible tempo map and a bar map from parsed score directives. */
export function createScoreTiming({ tempo = 60, numerator = 4, denominator = 4, directives = [], totalBeats = 0 } = {}) {
  const tempoSegments = [{ beat: 0, seconds: 0, tempo }];
  const meterSegments = [{ beat: 0, numerator, denominator, bar: 1 }];
  const ordered = directives.filter(directive => directive.valid && Number.isFinite(directive.beat) && directive.beat >= 0)
    .map((directive, index) => ({ ...directive, order: index }))
    .sort((first, second) => first.beat - second.beat || first.order - second.order);

  for (const directive of ordered) {
    if (directive.kind === 'tempo') {
      const previous = tempoSegments.at(-1);
      if (directive.beat === previous.beat) previous.tempo = directive.tempo;
      else tempoSegments.push({
        beat: directive.beat,
        seconds: previous.seconds + (directive.beat - previous.beat) * 60 / previous.tempo,
        tempo: directive.tempo,
      });
    } else if (directive.kind === 'time-signature') {
      const previous = meterSegments.at(-1);
      if (directive.beat === previous.beat) {
        previous.numerator = directive.numerator;
        previous.denominator = directive.denominator;
      } else meterSegments.push({
        beat: directive.beat,
        numerator: directive.numerator,
        denominator: directive.denominator,
        // A new signature begins a new bar, including after a partial bar.
        bar: previous.bar + Math.ceil((directive.beat - previous.beat) / beatsPerBar(previous) - EPSILON),
      });
    }
  }

  const beatToSeconds = beat => {
    const segment = tempoSegments[segmentIndex(tempoSegments, 'beat', beat)];
    return segment.seconds + (beat - segment.beat) * 60 / segment.tempo;
  };
  const secondsToBeat = seconds => {
    const segment = tempoSegments[segmentIndex(tempoSegments, 'seconds', seconds)];
    return segment.beat + (seconds - segment.seconds) * segment.tempo / 60;
  };
  const settingsAtBeat = beat => {
    const tempoSegment = tempoSegments[segmentIndex(tempoSegments, 'beat', beat)];
    const meterSegment = meterSegments[segmentIndex(meterSegments, 'beat', beat)];
    return { tempo: tempoSegment.tempo, numerator: meterSegment.numerator, denominator: meterSegment.denominator };
  };
  const barAtBeat = beat => {
    const segment = meterSegments[segmentIndex(meterSegments, 'beat', beat)];
    return Math.max(1, segment.bar + Math.floor((beat - segment.beat) / beatsPerBar(segment)));
  };

  // Iterate only the meter segments and pulse/bar indices in the requested
  // window. A long score does not require precomputing every beat or bar.
  const marksBetween = (fromBeat, toBeat, bars, fromSeconds, toSeconds) => {
    if (!Number.isFinite(fromBeat) || !Number.isFinite(toBeat) || toBeat <= Math.max(0, fromBeat)) return [];
    const from = Math.max(0, fromBeat);
    const marks = [];
    for (let index = segmentIndex(meterSegments, 'beat', from); index < meterSegments.length; index += 1) {
      const segment = meterSegments[index];
      if (segment.beat >= toBeat) break;
      const segmentEnd = meterSegments[index + 1]?.beat ?? Infinity;
      const step = bars ? beatsPerBar(segment) : 4 / segment.denominator;
      const first = Math.max(0, Math.ceil((from - segment.beat) / step - EPSILON));
      for (let mark = first; ; mark += 1) {
        const beat = segment.beat + mark * step;
        if (beat >= segmentEnd || beat > toBeat + EPSILON) break;
        if (bars) {
          if (beat >= toBeat) break;
          if (beat >= from) marks.push({ beat, bar: segment.bar + mark });
        } else {
          // Compare in the caller's units. An inverse conversion may land a
          // fraction either side of a pulse due to floating-point rounding.
          const seconds = beatToSeconds(beat);
          if (seconds >= toSeconds) break;
          if (seconds >= fromSeconds) marks.push({ seconds, beat, accent: mark % segment.numerator === 0 });
        }
      }
    }
    return marks;
  };

  /** Metronome clicks in [fromSeconds,toSeconds), continuing past score end. */
  const pulsesBetween = (fromSeconds, toSeconds) => {
    if (!Number.isFinite(fromSeconds) || !Number.isFinite(toSeconds) || toSeconds <= Math.max(0, fromSeconds)) return [];
    return marksBetween(secondsToBeat(Math.max(0, fromSeconds)), secondsToBeat(toSeconds), false, Math.max(0, fromSeconds), toSeconds);
  };
  /** Bar lines in [fromBeat,toBeat), continuing past score end. */
  const barsBetween = (fromBeat, toBeat) => marksBetween(fromBeat, toBeat, true);
  let totalBars = 0;
  if (Number.isFinite(totalBeats) && totalBeats > 0) {
    // Ignore a signature marker placed exactly at the end of the last note.
    let index = segmentIndex(meterSegments, 'beat', totalBeats);
    if (index > 0 && meterSegments[index].beat === totalBeats) index -= 1;
    const segment = meterSegments[index];
    totalBars = segment.bar - 1 + Math.ceil((totalBeats - segment.beat) / beatsPerBar(segment) - EPSILON);
  }

  return { tempoSegments, meterSegments, beatToSeconds, secondsToBeat, settingsAtBeat, barAtBeat, totalBars, pulsesBetween, barsBetween };
}
