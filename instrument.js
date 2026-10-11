export const INSTRUMENTS = Object.freeze([
  { id: 'synth', name: 'Synthesized reed' },
  { id: 'fluid', name: 'FluidR3 harmonica' },
  { id: 'vcsl', name: 'Hohner Super64 (VCSL)' },
]);

const banksByContext = new WeakMap();
const assetsUrl = new URL('./assets/sounds/', import.meta.url);

export function isInstrument(id) {
  return INSTRUMENTS.some(instrument => instrument.id === id);
}

/** Decode each locally hosted sound bank once per AudioContext. Failed loads can retry. */
export function loadInstrument(context, id) {
  if (!isInstrument(id)) return Promise.reject(new Error('Choose a supported harmonica sound.'));
  if (id === 'synth') return Promise.resolve(null);
  let banks = banksByContext.get(context);
  if (!banks) {
    banks = new Map();
    banksByContext.set(context, banks);
  }
  if (banks.has(id)) return banks.get(id);
  const pending = (async () => {
    const [metadataResponse, audioResponse] = await Promise.all([
      fetch(new URL('samples.json', assetsUrl)),
      fetch(new URL(`${id}.wav`, assetsUrl)),
    ]);
    if (!metadataResponse.ok || !audioResponse.ok) throw new Error('The sound files could not be downloaded.');
    const [metadata, bytes] = await Promise.all([metadataResponse.json(), audioResponse.arrayBuffer()]);
    const buffer = await context.decodeAudioData(bytes);
    const samples = metadata[id]?.samples;
    if (!Array.isArray(samples) || !samples.length || samples.some(sample =>
      !Number.isFinite(sample.midi) || !Number.isFinite(sample.start) || !Number.isFinite(sample.loopStart) ||
      !Number.isFinite(sample.loopEnd) || sample.start < 0 || sample.start >= sample.loopStart ||
      sample.loopStart >= sample.loopEnd || sample.loopEnd > buffer.duration + 0.001)) {
      throw new Error('The sound files are incomplete.');
    }
    return { buffer, samples };
  })().catch(() => {
    banks.delete(id);
    throw new Error(`${INSTRUMENTS.find(instrument => instrument.id === id).name} could not load. Try again or choose another sound.`);
  });
  banks.set(id, pending);
  return pending;
}

/** Choose the nearest recorded pitch, keeping the largest shift within three semitones in the harmonica range. */
export function nearestSample(bank, midi) {
  return bank.samples.reduce((nearest, sample) =>
    Math.abs(sample.midi - midi) < Math.abs(nearest.midi - midi) ? sample : nearest);
}
