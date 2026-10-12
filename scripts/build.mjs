import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, cp, rm } from 'node:fs/promises';

const files = ['index.html', 'styles.css', 'app.js', 'notation.js', 'project.js', 'audio.js', 'background-player.js', 'instrument.js', 'timeline.js', 'waveform.js', 'visualizer.js', 'note-editor.js', 'note-style.js', 'manual-play.js', 'favicon.svg', 'CREDITS.md'];
const sources = new Map(await Promise.all(files.map(async file => [file, await readFile(new URL(`../${file}`, import.meta.url), 'utf8')])));
const revision = createHash('sha256').update(JSON.stringify([...sources])).digest('hex').slice(0, 12);
const versioned = new Map(files.filter(file => /\.(js|css)$/.test(file)).map(file => [file, file.replace(/\.(js|css)$/, `.${revision}.$1`)]));

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
for (const file of files) {
  await copyFile(new URL(`../${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url));
}
// New pages must not load scripts or styles cached from an older deployment.
// Give the whole module graph one revision, while keeping the original URLs usable.
for (const file of ['index.html', ...versioned.keys()]) {
  const source = sources.get(file).replace(/(["'])\.\/([^"']+\.(?:js|css))\1/g,
    (match, quote, dependency) => versioned.has(dependency) ? `${quote}./${versioned.get(dependency)}${quote}` : match);
  await writeFile(new URL(`../dist/${versioned.get(file) || file}`, import.meta.url), source);
}
await cp(new URL('../assets/', import.meta.url), new URL('../dist/assets/', import.meta.url), { recursive: true });
console.log('Built static app in dist/. No server runtime required.');
