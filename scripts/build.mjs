import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'notation.js', 'project.js', 'audio.js', 'instrument.js', 'visualizer.js', 'note-editor.js', 'note-style.js', 'manual-play.js', 'favicon.svg', 'CREDITS.md']) {
  await copyFile(new URL(`../${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url));
}
await cp(new URL('../assets/', import.meta.url), new URL('../dist/assets/', import.meta.url), { recursive: true });
console.log('Built static app in dist/. No server runtime required.');
