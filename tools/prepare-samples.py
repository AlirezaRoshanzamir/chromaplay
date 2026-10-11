#!/usr/bin/env python3
"""Rebuild the bundled harmonica samples on macOS using Python and afconvert.

Downloads audio only from pinned upstream revisions. No downloaded code is run.
The application does not need Python or afconvert.
"""
import concurrent.futures
import json
import math
from pathlib import Path
import struct
import subprocess
import tempfile
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'assets' / 'sounds'
RATE = 22050
FLUID_REV = '044fab8e1456bfafc5776e86dfd6bb8697149aef'
VCSL_REV = 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e'
PITCHES = [(60, 'C4'), (64, 'E4'), (67, 'G4'), (72, 'C5'), (76, 'E5'),
           (79, 'G5'), (84, 'C6'), (88, 'E6'), (91, 'G6'), (96, 'C7')]


def fetch_sample(item):
    kind, midi, pitch, work = item
    if kind == 'fluid':
        url = f'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/{FLUID_REV}/FluidR3_GM/harmonica-mp3/{pitch}.mp3'
    else:
        # VCSL labels middle C as C3; the actual pitch is scientific C4 / MIDI 60.
        original = pitch[0] + str(int(pitch[1]) - 1)
        url = f'https://raw.githubusercontent.com/sgossner/VCSL/{VCSL_REV}/Aerophones/Free%20Aerophones/Harmonica-Hohner-Super64/Sustains/Normal/Hohner-Super64_Normal%20_{original}.wav'
    source = work / f'{kind}-{pitch}.{url.rsplit(".", 1)[1]}'
    source.write_bytes(urllib.request.urlopen(url, timeout=30).read())
    decoded = work / f'{kind}-{pitch}-mono.wav'
    subprocess.run(['afconvert', str(source), str(decoded), '-f', 'WAVE', '-d', f'LEI16@{RATE}', '-c', '1'], check=True)
    with wave.open(str(decoded)) as stream:
        values = list(struct.unpack('<' + 'h' * stream.getnframes(), stream.readframes(stream.getnframes())))

    # Remove leading silence, retain the natural attack, and use a steady region.
    block = RATE // 200
    energies = [sum(x * x for x in values[i:i + block]) / block for i in range(0, len(values) - block, block)]
    onset = next(i for i, energy in enumerate(energies) if energy > max(energies) * 0.0036)
    values = values[max(0, (onset - 1) * block):]
    loop_start = round(0.5 * RATE)
    target_end = round(1.6 * RATE)
    period = RATE / (440 * 2 ** ((midi - 69) / 12))
    # Choose matching phase before crossfading, so the splice does not thump.
    width = round(0.05 * RATE)
    candidates = range(target_end - math.ceil(period), target_end + math.ceil(period) + 1)
    loop_end = min(candidates, key=lambda end: sum((values[end - width + i] - values[loop_start - width + i]) ** 2 for i in range(width)))
    values = values[:loop_end]
    for i in range(width):
        mix = (i / (width - 1)) ** 2 * (3 - 2 * i / (width - 1))
        values[loop_end - width + i] = values[loop_end - width + i] * (1 - mix) + values[loop_start - width + i] * mix
    rms = math.sqrt(sum(x * x for x in values[loop_start:]) / (loop_end - loop_start))
    scale = min(0.16 * 32767 / rms, 0.94 * 32767 / max(abs(x) for x in values))
    values = [round(x * scale) for x in values]
    return kind, midi, values, loop_start, loop_end


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='chromaplay-samples-') as folder:
        tasks = [(kind, midi, pitch, Path(folder)) for kind in ['fluid', 'vcsl'] for midi, pitch in PITCHES]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            results = list(executor.map(fetch_sample, tasks))
    manifest = {}
    for kind in ['fluid', 'vcsl']:
        sprite = []
        entries = []
        for _, midi, values, loop_start, loop_end in [result for result in results if result[0] == kind]:
            offset = len(sprite)
            entries.append({'midi': midi, 'start': offset / RATE, 'loopStart': (offset + loop_start) / RATE, 'loopEnd': (offset + loop_end) / RATE})
            sprite.extend(values)
        with wave.open(str(OUTPUT / f'{kind}.wav'), 'wb') as stream:
            stream.setparams((1, 2, RATE, len(sprite), 'NONE', 'not compressed'))
            stream.writeframes(struct.pack('<' + 'h' * len(sprite), *sprite))
        manifest[kind] = {'file': f'{kind}.wav', 'samples': entries}
    (OUTPUT / 'samples.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Wrote two sound sprites and samples.json to', OUTPUT)


if __name__ == '__main__':
    main()
