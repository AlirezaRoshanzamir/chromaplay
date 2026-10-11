import { parseNotation, pitchFor, formatDuration } from './notation.js';
import { PracticeAudio } from './audio.js';
import { HarmonicaVisualizer } from './visualizer.js';
import { NoteEditor } from './note-editor.js';
import { ManualHarmonica } from './manual-play.js';
import { DEFAULT_PROJECT, validateProject, parseProjectFile, serializeProject } from './project.js';

const $ = (id) => document.getElementById(id);
const icons = {
  play:'<path d="m8 5 11 7-11 7Z"/>', pause:'<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>',
  previous:'<path d="M5 5v14m13-14L8 12l10 7Z"/>', next:'<path d="M19 5v14M6 5l10 7-10 7Z"/>',
  restart:'<path d="M3 10a9 9 0 1 1 1.7 8M3 4v6h6"/>', loop:'<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3"/>',
  upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  download:'<path d="M12 3v13m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  book:'<path d="M12 5v15M3 4c3-1 6-1 9 1 3-2 6-2 9-1v15c-3-1-6-1-9 1-3-2-6-2-9-1Z"/>',
  notes:'<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/>',
  music:'<path d="M9 18V5l10-2v13M9 8l10-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="16" cy="16" rx="3" ry="2"/>',
  headphones:'<path d="M3 14v-3a9 9 0 0 1 18 0v3M3 13h4v8H5a2 2 0 0 1-2-2Zm18 0h-4v8h2a2 2 0 0 0 2-2Z"/>',
  audio:'<path d="M12 3v18M8 7v10M4 10v4m12-7v10m4-7v4"/>',
  volume:'<path d="m11 4-6 5H2v6h3l6 5Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted:'<path d="m11 4-6 5H2v6h3l6 5ZM16 9l6 6m0-6-6 6"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>', check:'<path d="m5 12 4 4L19 6"/>',
  pencil:'<path d="m16 3 5 5-12 12-6 1 1-6Zm-3 3 5 5"/>',
  metronome:'<path d="m9 3-5 18h16L15 3ZM8 15h8m-4 0 6-9"/>',
  spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  wind:'<path d="M3 8h12a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M4 16h5a3 3 0 1 1-3 3"/>',
  'arrow-down':'<path d="M12 4v16m-6-6 6 6 6-6"/>', 'arrow-up':'<path d="M12 20V4m-6 6 6-6 6 6"/>',
  external:'<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.music}</svg>`; }
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });

const STORAGE_KEY = 'chromaplay.score.v1';
let project = { ...DEFAULT_PROJECT };
let storageWarning = false;
try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) project = validateProject(JSON.parse(saved), { allowInvalidNotation: true }); }
catch { storageWarning = true; }
let parsed = parseNotation(project.notation);
let position = 0;
let activeIndex = -2;
let pendingPlay = false;
let playRequest = 0;
let frame = null;
let toastTimer;
let backgroundRequest = 0;
let manual;
const audio = new PracticeAudio({
  onStateChange: ({ isPlaying, beat }) => { position = beat; updateTransport(); if (isPlaying) startFrames(); else cancelFrames(); },
  onEnded: () => { position = parsed.totalBeats; renderPosition(); if (project.loop) { position = 0; void startPlayback(true); } },
});
const visualizer = new HarmonicaVisualizer($('visualizer'), { onSeek: beat => { void seekTo(beat); } });
const VISUALIZER_HEIGHT_KEY = 'chromaplay.visualizerHeight.v1';
const resizeHandle = $('visualizer-resize');
function applyVisualizerHeight(value) {
  const height = Math.min(640, Math.max(180, Math.round(Number(value) || 320)));
  resizeHandle.setAttribute('aria-valuenow', height);
  resizeHandle.setAttribute('aria-valuetext', `${height} pixels`);
  $('visualizer').parentElement.style.setProperty('--visualizer-height', `${height}px`);
}
try { applyVisualizerHeight(localStorage.getItem(VISUALIZER_HEIGHT_KEY)); }
catch { applyVisualizerHeight(320); }
function saveVisualizerHeight() {
  try { localStorage.setItem(VISUALIZER_HEIGHT_KEY, resizeHandle.getAttribute('aria-valuenow')); }
  catch { /* The height still works when browser storage is unavailable. */ }
}
let resizing = null;
resizeHandle.addEventListener('pointerdown', event => {
  if (event.button !== 0 || resizing) return;
  event.preventDefault();
  resizeHandle.focus({ preventScroll: true });
  resizing = { pointerId: event.pointerId, y: event.clientY, height: $('visualizer').getBoundingClientRect().height };
  resizeHandle.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing-visualizer');
});
resizeHandle.addEventListener('pointermove', event => {
  if (resizing?.pointerId !== event.pointerId) return;
  applyVisualizerHeight(resizing.height + event.clientY - resizing.y);
});
function finishVisualizerResize(event) {
  if (!resizing || (event.pointerId != null && event.pointerId !== resizing.pointerId)) return;
  const { pointerId } = resizing;
  resizing = null;
  if (resizeHandle.hasPointerCapture(pointerId)) resizeHandle.releasePointerCapture(pointerId);
  document.body.classList.remove('resizing-visualizer');
  saveVisualizerHeight();
}
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => resizeHandle.addEventListener(name, finishVisualizerResize));
window.addEventListener('blur', finishVisualizerResize);
resizeHandle.addEventListener('keydown', event => {
  const height = Number(resizeHandle.getAttribute('aria-valuenow'));
  const next = { ArrowUp: height - 10, ArrowDown: height + 10, Home: 180, End: 640 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  applyVisualizerHeight(next);
  saveVisualizerHeight();
});
const noteEditor = new NoteEditor($('note-editor'), {
  onEditStart: () => { if (audio.isPlaying || pendingPlay) pausePlayback(); },
  onChange: source => { stopForEdit(); project.notation = source; refreshScore(); save(); },
});
let lastEditorPosition = null;
const holeElements = Array.from({ length: 12 }, (_, index) => {
  const hole = document.createElement('button');
  hole.type = 'button';
  hole.dataset.hole = String(index + 1);
  hole.className = 'hole';
  hole.innerHTML = `<strong>${index + 1}</strong><small>${pitchFor(index + 1).pitch.replace(/\d/, '')}</small>`;
  hole.setAttribute('aria-label', `Hole ${index + 1}`);
  $('harmonica').append(hole);
  return hole;
});
manual = new ManualHarmonica($('harmonica'), {
  audio,
  drawButton: $('manual-draw'),
  sliderButton: $('manual-slider'),
  onStart: () => { if (audio.isPlaying || pendingPlay) pausePlayback(false); },
  onChange: () => { activeIndex = -2; renderPosition(); updateTransport(); },
  onError: error => notify(error.message || 'Audio could not start in this browser.', true),
  isBlocked: () => $('guide-dialog').open,
});
const alignHoles = () => {
  const canvasRect = $('visualizer').getBoundingClientRect();
  const parentRect = $('harmonica').getBoundingClientRect();
  $('harmonica').style.paddingLeft = `${canvasRect.left - parentRect.left + (canvasRect.width < 420 ? 25 : 34)}px`;
  $('harmonica').style.paddingRight = `${parentRect.right - canvasRect.right + 12}px`;
};
new ResizeObserver(alignHoles).observe($('visualizer'));

function notify(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 4000);
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    $('saved-status').innerHTML = '<span class="status-dot"></span> Saved here';
  } catch {
    $('saved-status').textContent = 'Export to save';
    if (!storageWarning) { notify('Browser storage is unavailable. Export your score to keep it.', true); storageWarning = true; }
  }
}
function setRangeFill(element) {
  const percentage = (Number(element.value) - Number(element.min)) / (Number(element.max) - Number(element.min)) * 100;
  element.style.setProperty('--progress', `${Math.max(0, Math.min(100, percentage || 0))}%`);
}
function applyProject() {
  $('score-title').value = project.title;
  noteEditor.setValue(project.notation);
  $('tempo').value = project.tempo;
  $('time-numerator').value = project.numerator;
  $('time-denominator').value = project.denominator;
  $('background-offset').value = project.backgroundOffset;
  $('note-volume').value = project.noteVolume;
  $('background-volume').value = project.backgroundVolume;
  $('metronome').setAttribute('aria-pressed', String(project.metronome));
  $('loop').setAttribute('aria-pressed', String(project.loop));
  audio.setNoteVolume(project.noteVolume / 100);
  audio.setBackgroundVolume(project.backgroundVolume / 100);
  audio.setNoteMuted(project.noteMuted);
  audio.setBackgroundMuted(project.backgroundMuted);
  audio.setMetronome(project.metronome);
  audio.setTimeSignature(project.numerator, project.denominator);
  updateVolumes();
  updateMutes();
  refreshScore();
}
function refreshScore() {
  parsed = parseNotation(project.notation);
  $('copy-notes').disabled = project.notation.length === 0;
  const barBeats = project.numerator * 4 / project.denominator;
  visualizer.setScore(parsed.errors.length ? [] : parsed.notes, { beatsPerBar: barBeats });
  lastEditorPosition = null;
  const count = parsed.notes.filter(note => !note.isRest).length;
  const rests = parsed.notes.length - count;
  $('note-count').textContent = `${count} note${count === 1 ? '' : 's'}${rests ? ` + ${rests} rest${rests === 1 ? '' : 's'}` : ''}`;
  const bars = parsed.totalBeats / barBeats;
  $('bar-count').textContent = `${Number(bars.toFixed(2))} bar${bars === 1 ? '' : 's'}`;
  $('score-valid').innerHTML = parsed.errors.length ? 'Check notation' : parsed.notes.length ? `${icon('check')} Ready to play` : 'Add your first note';
  $('score-errors').hidden = !parsed.errors.length;
  $('score-errors').textContent = parsed.errors.slice(0, 3).map(error => `At character ${error.start + 1}: ${error.message}`).join(' ');
  $('empty-visualizer').hidden = Boolean(parsed.notes.length && !parsed.errors.length);
  $('empty-visualizer').querySelector('strong').textContent = parsed.errors.length ? 'One small fix before we play.' : 'A blank score. A fresh start.';
  $('empty-visualizer').querySelector('span:last-child').textContent = parsed.errors.length ? 'Check the highlighted notation in your score.' : 'Write a few notes in your score to begin.';
  $('total-time').textContent = formatDuration(parsed.totalBeats * 60 / project.tempo);
  $('seek').max = parsed.totalBeats || 1;
  position = Math.max(0, Math.min(position, parsed.totalBeats));
  activeIndex = -2;
  updateTransport();
  renderPosition();
}
function currentNote() {
  if (parsed.errors.length || position < 0) return null;
  // Binary search keeps highlighting quick even for long imported scores.
  let low = 0, high = parsed.notes.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1, note = parsed.notes[mid];
    if (position < note.startBeat) high = mid - 1;
    else if (position >= note.endBeat) low = mid + 1;
    else return note;
  }
  return null;
}
function renderPosition() {
  visualizer.setPosition(position);
  noteEditor.setPosition(position, { follow: audio.isPlaying || position !== lastEditorPosition });
  lastEditorPosition = position;
  const liveNote = manual?.note;
  const note = liveNote || currentNote();
  const index = liveNote ? `live-${liveNote.token}` : note?.index ?? -1;
  if (index !== activeIndex) {
    activeIndex = index;
    visualizer.setActive(note);
    holeElements.forEach((hole, i) => { hole.className = `hole${note && !note.isRest && note.hole === i + 1 ? ` active ${note.draw ? 'draw' : 'blow'}${note.slider ? ' slider' : ''}` : ''}`; });
  }
  if (liveNote) {
    $('current-note-title').textContent = `${note.draw ? 'Draw' : 'Blow'} hole ${note.hole}${note.slider ? ' / Slider in' : ''}`;
    $('current-note-detail').textContent = `${note.pitch} / Live play / ${note.token}`;
    $('current-direction').innerHTML = icon(note.draw ? 'arrow-down' : 'arrow-up');
    $('current-direction').style.color = note.draw ? '#eab09a' : '#b4edb1';
  } else if (position < 0) {
    $('current-note-title').textContent = 'Backing track lead-in';
    $('current-note-detail').textContent = `Your first note in ${Math.max(0, -position * 60 / project.tempo).toFixed(1)} seconds`;
    $('current-direction').innerHTML = icon('headphones');
  } else if (note) {
    const length = { w:'Whole', h:'Half', q:'Quarter', e:'Eighth', s:'Sixteenth' }[note.duration];
    $('current-note-title').textContent = note.isRest ? 'Take a breath' : `${note.draw ? 'Draw' : 'Blow'} hole ${note.hole} ${note.slider ? ' / Slider in' : ''}`;
    $('current-note-detail').textContent = `${note.isRest ? 'Rest' : note.pitch} / ${note.dotted ? 'Dotted ' + length.toLowerCase() : length} note / ${note.token}`;
    $('current-direction').innerHTML = icon(note.isRest ? 'wind' : note.draw ? 'arrow-down' : 'arrow-up');
    $('current-direction').style.color = note.draw ? '#eab09a' : '#b4edb1';
  } else {
    $('current-note-title').textContent = position >= parsed.totalBeats && parsed.notes.length ? 'Nicely played. Go again?' : "Let's play something";
    $('current-note-detail').textContent = position >= parsed.totalBeats && parsed.notes.length ? 'Restart to take it from the top' : 'Write a melody, then press play';
    $('current-direction').innerHTML = icon('wind');
  }
  const totalBars = Math.max(1, Math.ceil(parsed.totalBeats / (project.numerator * 4 / project.denominator)));
  const currentBar = Math.min(totalBars, Math.floor(Math.max(0, position) / (project.numerator * 4 / project.denominator)) + 1);
  $('measure-label').innerHTML = `BAR ${String(currentBar).padStart(2,'0')} <span>/ ${String(totalBars).padStart(2,'0')}</span>`;
  $('elapsed').textContent = `${position < 0 ? '-' : ''}${formatDuration(Math.abs(position) * 60 / project.tempo)}`;
  $('seek').value = Math.max(0, position);
  $('seek').setAttribute('aria-valuetext', `${formatDuration(Math.max(0, position) * 60 / project.tempo)} of ${$('total-time').textContent}`);
  setRangeFill($('seek'));
}
function updateTransport() {
  const playing = audio.isPlaying;
  $('play').querySelector('[data-icon]').innerHTML = icon(playing ? 'pause' : 'play');
  $('play-label').textContent = playing ? 'Pause' : 'Play';
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const invalid = !!parsed.errors.length || !parsed.notes.length;
  $('play').disabled = invalid;
  ['restart','previous','next','seek'].forEach(id => { $(id).disabled = invalid; });
  $('play-status').textContent = manual?.note ? 'LIVE PLAY' : playing ? 'FIND YOUR FLOW' : position >= parsed.totalBeats && parsed.notes.length ? 'ONE MORE TIME?' : position > 0 ? 'TAKE YOUR TIME' : 'READY WHEN YOU ARE';
  $('play-status-dot').classList.toggle('playing', playing || Boolean(manual?.note));
}
function startFrames() {
  if (frame !== null) return;
  const tick = () => { frame = null; if (!audio.isPlaying) return; position = audio.getPosition(); renderPosition(); frame = requestAnimationFrame(tick); };
  frame = requestAnimationFrame(tick);
}
function cancelFrames() { if (frame !== null) cancelAnimationFrame(frame); frame = null; }
function pausePlayback(stopManual = true) { if (stopManual) manual?.stop(); const beat = audio.isPlaying ? audio.getPosition() : position; playRequest++; pendingPlay = false; audio.pause(); position = beat; renderPosition(); }
async function startPlayback(includeLeadIn = false) {
  if (parsed.errors.length || !parsed.notes.length) return;
  manual.stop();
  noteEditor.commit();
  const request = ++playRequest;
  if (position >= parsed.totalBeats) { position = 0; includeLeadIn = true; }
  pendingPlay = true;
  try {
    await audio.play({ notes: parsed.notes, bpm: project.tempo, fromBeat: position, backgroundOffset: project.backgroundOffset, includeLeadIn });
  } catch (error) { if (request === playRequest) { notify(error.message || 'Audio could not start in this browser.', true); updateTransport(); } }
  finally { if (request === playRequest) pendingPlay = false; }
}
async function togglePlayback() { if (audio.isPlaying || pendingPlay) pausePlayback(); else await startPlayback(position === 0); }
async function seekTo(beat, leadIn = false) {
  const wasPlaying = audio.isPlaying || pendingPlay;
  pausePlayback();
  position = Math.max(0, Math.min(beat, parsed.totalBeats));
  renderPosition(); updateTransport();
  if (wasPlaying && position < parsed.totalBeats) await startPlayback(leadIn);
}
function stepNote(direction) {
  if (!parsed.notes.length || parsed.errors.length) return;
  const beat = audio.isPlaying ? audio.getPosition() : position;
  let target;
  if (direction > 0) target = parsed.notes.find(note => note.startBeat > beat + 0.025)?.startBeat ?? parsed.totalBeats;
  else target = [...parsed.notes].reverse().find(note => note.startBeat < beat - 0.08)?.startBeat ?? 0;
  void seekTo(target);
}
function stopForEdit() {
  pausePlayback(); position = 0;
}
$('play').addEventListener('click', () => { void togglePlayback(); });
$('restart').addEventListener('click', () => { void seekTo(0, true); });
$('previous').addEventListener('click', () => stepNote(-1));
$('next').addEventListener('click', () => stepNote(1));
let resumeAfterScrub = false;
$('seek').addEventListener('pointerdown', () => { resumeAfterScrub = audio.isPlaying || pendingPlay; pausePlayback(); });
$('seek').addEventListener('input', () => { if (audio.isPlaying) pausePlayback(); position = Number($('seek').value); renderPosition(); updateTransport(); });
$('seek').addEventListener('change', () => { if (resumeAfterScrub && position < parsed.totalBeats) void startPlayback(); resumeAfterScrub = false; });
$('score-title').addEventListener('input', () => { project.title = $('score-title').value; save(); });

async function changeTiming(update) {
  const wasPlaying = audio.isPlaying || pendingPlay;
  pausePlayback();
  const leadInSeconds = position < 0 ? position * 60 / project.tempo : null;
  update();
  audio.setTimeSignature(project.numerator, project.denominator);
  refreshScore(); save();
  if (leadInSeconds !== null) { position = Math.max(leadInSeconds, Math.min(0, project.backgroundOffset)) * project.tempo / 60; renderPosition(); }
  if (wasPlaying && position < parsed.totalBeats) await startPlayback();
}
function setTempo(value) {
  const tempo = Math.min(300, Math.max(30, Math.round(Number(value) || project.tempo)));
  $('tempo').value = tempo;
  if (tempo === project.tempo) return;
  void changeTiming(() => { project.tempo = tempo; });
}
$('tempo').addEventListener('input', () => { if ($('tempo').validity.valid && $('tempo').value !== '') setTempo($('tempo').value); });
$('tempo').addEventListener('change', () => setTempo($('tempo').value));
$('tempo-down').addEventListener('click', () => setTempo(project.tempo - 5));
$('tempo-up').addEventListener('click', () => setTempo(project.tempo + 5));
function setNumerator() { const value = Math.min(32, Math.max(1, Math.round(Number($('time-numerator').value) || project.numerator))); $('time-numerator').value = value; if (value !== project.numerator) void changeTiming(() => { project.numerator = value; }); }
$('time-numerator').addEventListener('input', () => { if ($('time-numerator').validity.valid && $('time-numerator').value !== '') setNumerator(); });
$('time-numerator').addEventListener('change', setNumerator);
$('time-denominator').addEventListener('change', () => { void changeTiming(() => { project.denominator = Number($('time-denominator').value); }); });
function setOffset() { const value = Math.min(600, Math.max(-600, Number($('background-offset').value) || 0)); $('background-offset').value = value; if (value !== project.backgroundOffset) void changeTiming(() => { project.backgroundOffset = value; }); }
$('background-offset').addEventListener('input', () => { if ($('background-offset').validity.valid && $('background-offset').value !== '') setOffset(); });
$('background-offset').addEventListener('change', setOffset);
$('metronome').addEventListener('click', () => { project.metronome = !project.metronome; audio.setMetronome(project.metronome); $('metronome').setAttribute('aria-pressed', String(project.metronome)); save(); });
$('loop').addEventListener('click', () => { project.loop = !project.loop; $('loop').setAttribute('aria-pressed', String(project.loop)); save(); });
function updateMutes() {
  for (const [type, label] of [['note', 'Notes'], ['background', 'Backing track']]) {
    const muted = project[`${type}Muted`];
    const button = $(`${type}-mute`);
    button.setAttribute('aria-pressed', String(muted));
    button.querySelector('[data-mute-icon]').innerHTML = icon(muted ? 'muted' : 'volume');
    button.querySelector('.mute-state').textContent = muted ? 'Muted' : 'On';
    button.title = `${muted ? 'Unmute' : 'Mute'} ${label.toLowerCase()}${type === 'note' ? ' and metronome' : ''}`;
  }
}
$('note-mute').addEventListener('click', () => { project.noteMuted = !project.noteMuted; audio.setNoteMuted(project.noteMuted); updateMutes(); save(); });
$('background-mute').addEventListener('click', () => { project.backgroundMuted = !project.backgroundMuted; audio.setBackgroundMuted(project.backgroundMuted); updateMutes(); save(); });
function updateVolumes() {
  ['note','background'].forEach(type => { $(`${type}-volume-value`).textContent = `${$(`${type}-volume`).value}%`; setRangeFill($(`${type}-volume`)); });
}
$('note-volume').addEventListener('input', () => { project.noteVolume = Number($('note-volume').value); audio.setNoteVolume(project.noteVolume / 100); updateVolumes(); save(); });
$('background-volume').addEventListener('input', () => { project.backgroundVolume = Number($('background-volume').value); audio.setBackgroundVolume(project.backgroundVolume / 100); updateVolumes(); save(); });

const examples = {
  warmup: { ...DEFAULT_PROJECT },
  chromatic: { ...DEFAULT_PROJECT, title:'Chromatic steps', tempo:75, notation:'1q 1#q -1q -1#q |\n2q -2q -2#q 3q |\n3#q -3q -3#q -4q |\n4h 0h' },
  waltz: { ...DEFAULT_PROJECT, title:'A little 6/8', tempo:70, numerator:6, denominator:8, notation:'1q. 2e 3e 2e |\n-1q. -2q. |\n2e 3e 4e -4e -3e 3e |\n2h. |\n1q. 2e 3e 2e |\n-1e 2e -2e 3q. |\n4q. -4q. |\n4h 0q' },
  blank: { ...DEFAULT_PROJECT, title:'Untitled melody', notation:'' },
};
$('examples').addEventListener('change', () => {
  const example = examples[$('examples').value];
  if (!example) return;
  stopForEdit();
  project = { ...example, noteVolume: project.noteVolume, backgroundVolume:project.backgroundVolume, backgroundOffset: project.backgroundOffset };
  applyProject(); save(); $('examples').value = '';
});
$('import-button').addEventListener('click', () => $('import-file').click());
$('copy-notes').addEventListener('click', async () => {
  const source = noteEditor.getValue();
  if (!source) return;
  try {
    await navigator.clipboard.writeText(source);
    notify('Notes copied as text.');
  } catch {
    // Older browsers may only support copying from a selected text field.
    const field = document.createElement('textarea');
    field.value = source;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Show the manual option below. */ }
    field.remove();
    $('copy-notes').focus({ preventScroll: true });
    notify(copied ? 'Notes copied as text.' : 'Copy was blocked. Select the notes and use your keyboard to copy.', !copied);
  }
});
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('Choose a score smaller than 1 MB.');
    const imported = parseProjectFile(await file.text(), file.name);
    stopForEdit(); project = imported; applyProject(); save();
    notify('Score imported. Backing tracks are loaded separately.');
  } catch (error) { notify(error.message || 'This score could not be imported.', true); }
  $('import-file').value = '';
});
$('export-button').addEventListener('click', () => {
  try {
    const data = serializeProject(project);
    const url = URL.createObjectURL(new Blob([data], { type:'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `${(project.title.trim() || 'my-score').replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g,'-').toLowerCase() || 'my-score'}.chroma.json`;
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('Score exported with tempo, timing, and mixer settings.');
  } catch (error) { notify(error.message, true); }
});
async function loadBackground(file) {
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) { notify('Choose an audio file smaller than 100 MB.', true); return; }
  const request = ++backgroundRequest;
  $('upload-background').disabled = true;
  $('upload-background').querySelector('strong').textContent = 'Opening your track...';
  try {
    const track = await audio.setBackground(file);
    if (request !== backgroundRequest || !track) return;
    $('track-name').textContent = track.name;
    $('track-name').title = track.name;
    $('track-duration').textContent = `${formatDuration(track.duration)} / Loaded in this tab`;
    $('upload-background').hidden = true; $('loaded-track').hidden = false;
    notify('Track loaded. Restart to include its lead-in.');
  } catch { if (request === backgroundRequest) notify('This audio file could not be opened. Try an MP3 or WAV file.', true); }
  finally {
    if (request === backgroundRequest) { $('upload-background').disabled = false; $('upload-background').querySelector('strong').textContent = 'Add a backing track'; }
  }
}
$('upload-background').addEventListener('click', () => $('background-file').click());
$('background-file').addEventListener('change', () => { void loadBackground($('background-file').files[0]); $('background-file').value = ''; });
$('remove-background').addEventListener('click', () => { backgroundRequest++; audio.clearBackground(); $('loaded-track').hidden = true; $('upload-background').hidden = false; $('upload-background').disabled = false; $('upload-background').querySelector('strong').textContent = 'Add a backing track'; if (position < 0) void seekTo(0); });
['dragenter','dragover'].forEach(name => $('upload-background').addEventListener(name, event => { event.preventDefault(); $('upload-background').classList.add('drag-over'); }));
['dragleave','drop'].forEach(name => $('upload-background').addEventListener(name, event => { event.preventDefault(); $('upload-background').classList.remove('drag-over'); }));
$('upload-background').addEventListener('drop', event => { void loadBackground(event.dataTransfer.files[0]); });
window.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });

const guide = $('guide-dialog');
['guide-button','hint-help'].forEach(id => $(id).addEventListener('click', () => guide.showModal()));
$('close-guide').addEventListener('click', () => guide.close());
guide.addEventListener('click', event => { const rect = guide.getBoundingClientRect(); if (event.target === guide && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) guide.close(); });
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || guide.open || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input,textarea,select,button,[contenteditable=true]')) return;
  if (event.code === 'ArrowRight') { event.preventDefault(); stepNote(1); }
  if (event.code === 'Home') { event.preventDefault(); void seekTo(0, true); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && audio.isPlaying) { position = audio.getPosition(); renderPosition(); } });
window.addEventListener('pagehide', () => { audio.stop(); cancelFrames(); });
applyProject();
if (storageWarning) notify('Your saved score could not be restored. You can import a backup.', true);
