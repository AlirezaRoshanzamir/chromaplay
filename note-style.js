const PIXELS_PER_BEAT = 48;

/** Leave room for spaces and bar separators between four whole notes. */
export function editorBeatWidth(contentWidth) {
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return PIXELS_PER_BEAT;
  return Math.min(PIXELS_PER_BEAT, Math.max(1, (contentWidth - 80) / 16));
}

function luminance(rgb) {
  const channels = rgb.map(value => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

/** Hole number controls shade; slider and sounding pitch do not. */
export function noteColors(note) {
  let rgb;
  if (note.isRest || note.hole === 0) rgb = [224, 228, 220];
  else {
    const light = note.draw ? [248, 216, 209] : [220, 237, 206];
    const dark = note.draw ? [140, 40, 48] : [31, 91, 53];
    const amount = (Math.max(1, Math.min(12, note.hole)) - 1) / 11;
    rgb = light.map((value, index) => Math.round(value + (dark[index] - value) * amount));
  }
  const brightness = luminance(rgb);
  const whiteContrast = 1.05 / (brightness + 0.05);
  const blackContrast = (brightness + 0.05) / 0.05;
  return {
    background: `rgb(${rgb.join(', ')})`,
    foreground: whiteContrast >= blackContrast ? '#ffffff' : '#000000',
    border: `rgb(${rgb.map(value => Math.round(value * 0.83)).join(', ')})`,
  };
}

/** All geometry uses quarter-note beats, independent of tempo and meter. */
export function noteGeometry(note, pixelsPerBeat = PIXELS_PER_BEAT) {
  return {
    x: note.startBeat * pixelsPerBeat,
    width: note.beats * pixelsPerBeat,
    endX: note.endBeat * pixelsPerBeat,
  };
}

export function beatToX(beat, totalBeats) {
  const total = Number.isFinite(totalBeats) ? Math.max(0, totalBeats) : 0;
  const position = Number.isNaN(beat) ? 0 : beat;
  return Math.max(0, Math.min(total, position)) * PIXELS_PER_BEAT;
}

/** Relative playhead position works when inline notes wrap onto separate lines. */
export function progressForBeat(note, beat) {
  if (!Number.isFinite(note.startBeat) || !Number.isFinite(note.beats) || note.beats <= 0 || Number.isNaN(beat)) return 0;
  return Math.max(0, Math.min(1, (beat - note.startBeat) / note.beats));
}
