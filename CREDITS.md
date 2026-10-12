# Credits

ChromaPlay's sheet renderer and sampled sounds are bundled with the app. Rendering and playback do not contact an external rendering service or sample CDN. The synthesized reed uses ChromaPlay's own Web Audio oscillator.

## OpenSheetMusicDisplay

The **Sheet music** panel uses [OpenSheetMusicDisplay 2.2.1](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/releases/tag/2.2.1), copyright 2019 PhonicScore, under the **BSD-3-Clause** license.

ChromaPlay includes the unmodified browser bundle from the official `opensheetmusicdisplay` npm package and serves it locally from `assets/vendor/osmd/opensheetmusicdisplay.min.js`. The app renders MusicXML in the browser without sending score data to another service.

- [OpenSheetMusicDisplay license](assets/vendor/osmd/LICENSE)
- [License and copyright notices for libraries included in the bundle](assets/vendor/osmd/opensheetmusicdisplay.min.js.LICENSE.txt), including JSZip under its MIT license option
- [Pinned source, release, package, and bundle checksum](assets/vendor/osmd/README.md)

## FluidR3 harmonica

FluidR3 GM soundfont by Frank Wen. MP3 recordings were rendered and published by Benjamin Gleitzman in [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts), which identifies FluidR3 samples as [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).

Source revision: `044fab8e1456bfafc5776e86dfd6bb8697149aef`, folder `FluidR3_GM/harmonica-mp3`. The selected source files are C4, E4, G4, C5, E5, G5, C6, E6, G6, and C7.

ChromaPlay converts the recordings to mono 22,050 Hz 16-bit PCM, trims leading silence and release tails, adjusts volume, adds crossfaded sustain loops, and combines them in `assets/sounds/fluid.wav`. See [the license text and upstream notices](assets/sounds/LICENSE-FluidR3.txt).

## Hohner Super64 (VCSL)

Hohner Super64 chromatic harmonica recordings from the [Versilian Community Sample Library](https://github.com/sgossner/VCSL), created by Versilian Studios LLC and released under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).

Source revision: `c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e`, folder `Aerophones/Free Aerophones/Harmonica-Hohner-Super64/Sustains/Normal`. The selected files are C3, E3, G3, C4, E4, G4, C5, E5, G5, and C6. VCSL uses an octave numbering convention where its C3 recording is scientific C4 (MIDI 60); ChromaPlay accounts for this when mapping pitches.

ChromaPlay converts the recordings to mono 22,050 Hz 16-bit PCM, trims leading silence and release tails, adjusts volume, adds crossfaded sustain loops, and combines them in `assets/sounds/vcsl.wav`. See [the full CC0 text](assets/sounds/LICENSE-VCSL.txt).

## Rebuilding the samples

The app plays the nearest recorded pitch with Web Audio playback-rate adjustment, covering every hole, breath, and slider combination. These are ten pitch recordings per instrument, not separate recordings of each hole and breath. Long notes repeat the prepared sustain loop until their scheduled release.

Run `python3 tools/prepare-samples.py` on macOS to regenerate the two WAV files and `samples.json`. The preparation tool uses Python's standard library and Apple's `afconvert`; it downloads audio from the pinned revisions above. None of these tools are needed to run or build the app.
