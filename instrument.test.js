import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { INSTRUMENTS, isInstrument, nearestSample } from './instrument.js';

test('sound choices are explicit and nearest recordings cover every harmonica pitch', async () => {
  assert.deepEqual(INSTRUMENTS.map(instrument => instrument.id), ['synth', 'fluid', 'vcsl']);
  assert.equal(isInstrument('unavailable'), false);
  const metadata = JSON.parse(await readFile(new URL('./assets/sounds/samples.json', import.meta.url), 'utf8'));
  for (const bank of Object.values(metadata)) {
    for (let midi = 60; midi <= 98; midi += 1) {
      assert.ok(Math.abs(nearestSample(bank, midi).midi - midi) <= 2);
    }
    assert.equal(nearestSample(bank, 72).midi, 72);
  }
});

test('bundled WAV recordings contain audible, unclipped samples and continuous sustain loop boundaries', async () => {
  const metadata = JSON.parse(await readFile(new URL('./assets/sounds/samples.json', import.meta.url), 'utf8'));
  let totalBytes = 0;
  for (const [id, bank] of Object.entries(metadata)) {
    const wav = await readFile(new URL(`./assets/sounds/${id}.wav`, import.meta.url));
    totalBytes += wav.byteLength;
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(20), 1, 'standard PCM');
    assert.equal(wav.readUInt16LE(22), 1, 'mono');
    assert.equal(wav.readUInt16LE(34), 16, '16-bit');
    const rate = wav.readUInt32LE(24);
    const frames = wav.readUInt32LE(40) / 2;
    const at = frame => wav.readInt16LE(44 + frame * 2) / 32768;
    for (const sample of bank.samples) {
      const start = Math.round(sample.start * rate);
      const loopStart = Math.round(sample.loopStart * rate);
      const loopEnd = Math.round(sample.loopEnd * rate);
      assert.ok(start >= 0 && start < loopStart && loopStart < loopEnd && loopEnd <= frames);
      assert.ok((loopEnd - loopStart) / rate > 1);
      let sum = 0;
      let largestDelta = 0;
      for (let frame = start; frame < loopEnd; frame += 1) {
        const value = at(frame);
        assert.ok(Math.abs(value) < 0.95, `${id} ${sample.midi} clips`);
        if (frame >= loopStart) sum += value * value;
        if (frame > loopStart) largestDelta = Math.max(largestDelta, Math.abs(value - at(frame - 1)));
      }
      const rms = Math.sqrt(sum / (loopEnd - loopStart));
      assert.ok(rms > 0.03 && rms <= 0.161, `${id} ${sample.midi} has unexpected volume ${rms}`);
      assert.ok(Math.abs(at(loopStart) - at(loopEnd - 1)) <= largestDelta + 1e-4, `${id} ${sample.midi} has a loop discontinuity`);
    }
  }
  assert.ok(totalBytes < 1_500_000, `sound downloads are ${totalBytes} bytes`);
});
