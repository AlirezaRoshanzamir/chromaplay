import { parseNotation, pitchFor, formatDuration, updateScoreTiming } from './notation.js';
import { PracticeAudio } from './audio.js';
import { HarmonicaVisualizer } from './visualizer.js';
import { NoteEditor } from './note-editor.js';
import { ManualHarmonica } from './manual-play.js';
import { createTimeline } from './timeline.js';
import { createScoreTiming } from './score-timing.js';
import { WaveformTimeline } from './waveform.js';
import { DEFAULT_PROJECT, validateProject, parseProjectFile, serializeProject } from './project.js';
import { deriveScoreFormats, switchScoreFormat } from './score-formats.js';
import { SheetMusic } from './sheet-music.js';
import { WorkspaceLayout } from './workspace-layout.js';

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
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>', check:'<path d="m5 12 4 4L19 6"/>',
  pencil:'<path d="m16 3 5 5-12 12-6 1 1-6Zm-3 3 5 5"/>',
  metronome:'<path d="m9 3-5 18h16L15 3ZM8 15h8m-4 0 6-9"/>',
  spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  wind:'<path d="M3 8h12a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M4 16h5a3 3 0 1 1-3 3"/>',
  'arrow-down':'<path d="M12 4v16m-6-6 6 6 6-6"/>', 'arrow-up':'<path d="M12 20V4m-6 6 6-6 6 6"/>',
  external:'<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  github:'<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.music}</svg>`; }
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });

const STORAGE_KEY = 'chromaplay.score.v1';
let project = { ...DEFAULT_PROJECT };
let storageWarning = false;
try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) project = validateProject(JSON.parse(saved), { allowInvalidNotation: true }); }
catch { storageWarning = true; }
let parsed = parseNotation(project.notation);
let sourceViews = null;
let sourceViewsKey = null;
let viewedFormat = project.scoreFormat || 'dsl';
let requestedFormat = null;
let scoreTiming = createScoreTiming(parsed);
let timeline = createTimeline({ notes: parsed.notes, timing: scoreTiming, bpm: parsed.tempo, noteOffset: project.noteOffset, backgroundOffset: project.backgroundOffset, metronome: project.metronome, metronomeOffset: project.metronomeOffset });
let position = 0;
let activeIndex = -2;
let pendingPlay = false;
let playRequest = 0;
let frame = null;
let toastTimer;
let backgroundRequest = 0;
let backgroundLoading = false;
let instrumentRequest = 0;
let manual;
const audio = new PracticeAudio({
  onStateChange: ({ isPlaying, beat }) => { position = beat; updateTransport(); if (isPlaying) startFrames(); else cancelFrames(); },
  onEnded: () => { position = timeline.endBeat; renderPosition(); if (project.loop) { position = timeline.startBeat; void startPlayback(); } },
  onError: error => { pausePlayback(); notify(error.message || 'Backing track playback failed. Try playing again.', true); },
});
const visualizer = new HarmonicaVisualizer($('visualizer'), { onSeek: beat => { void seekTo(transportBeatAtScoreBeat(beat)); } });
const waveforms = new WaveformTimeline($('waveform-timeline'), { onSeek: seconds => { void seekTo(seconds * project.tempo / 60); } });
const sheetMusic = new SheetMusic($('sheet-card'));
const noteEditor = new NoteEditor($('note-editor'), {
  onEditStart: () => { if (audio.isPlaying || pendingPlay) pausePlayback(); },
  onChange: source => { if (project.scoreFormat === 'musicxml') return; stopForEdit(); project.notation = source; refreshScore({ reset: true }); save(); },
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
  onStart: () => { if (audio.isPlaying || pendingPlay) pausePlayback(false); else playRequest++; },
  onChange: () => { activeIndex = -2; renderPosition(); updateTransport(); },
  onError: error => notify(error.message || 'Audio could not start in this browser.', true),
  isBlocked: () => $('guide-dialog').open || $('format-dialog').open,
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
function syncSourceViews() {
  const format = project.scoreFormat || 'dsl';
  const source = format === 'musicxml' ? project.musicxml : project.notation;
  if (!sourceViewsKey || sourceViewsKey.format !== format || sourceViewsKey.source !== source || sourceViewsKey.title !== project.title) {
    sourceViews = deriveScoreFormats(project);
    sheetMusic.setScore(sourceViews.musicxml, { error: sourceViews.error, notation: sourceViews.notation, warnings: sourceViews.warnings });
    sourceViewsKey = { format, source, title: project.title };
    if (format === 'musicxml') {
      project.notation = sourceViews.notation;
      if (noteEditor.getValue() !== project.notation) noteEditor.setValue(project.notation);
    }
    if ($('musicxml-source').value !== sourceViews.musicxml) $('musicxml-source').value = sourceViews.musicxml;
    $('conversion-warning-list').replaceChildren(...sourceViews.warnings.map(message => {
      const item = document.createElement('li');
      item.textContent = message;
      return item;
    }));
  }
  const xmlMain = format === 'musicxml';
  noteEditor.setReadOnly(xmlMain);
  $('musicxml-source').readOnly = !xmlMain;
  $('musicxml-source').setAttribute('aria-readonly', String(!xmlMain));
  $('main-format').value = format;
  $('dsl-badge').textContent = xmlMain ? 'Generated' : 'Main';
  $('musicxml-badge').textContent = xmlMain ? 'Main' : 'Generated';
  $('copy-notes').disabled = !project.notation;
  $('copy-musicxml').disabled = !sourceViews.musicxml;
  $('download-musicxml').disabled = !sourceViews.musicxml || Boolean(sourceViews.error);
  $('examples').disabled = xmlMain;
  $('musicxml-help').textContent = xmlMain
    ? 'Edit or paste MusicXML here, or use Import for a .musicxml or .xml file. Playback follows the converted DSL. Initial timing controls reflect this source; edit tempo and meter here.'
    : sourceViews.error ? `MusicXML could not be generated: ${sourceViews.error}` : 'Generated from DSL. Select MusicXML as the main format to edit it.';
  $('editor-help').textContent = xmlMain
    ? 'Generated from MusicXML. Notes and timing are read-only here. Select DSL as the main format to edit them. Playback follows this conversion.'
    : 'These controls set the initial tempo and time signature (defaults: 60 BPM and 4/4). Add TEMPO 120 or TSIG 6/8 anywhere between notes to change what follows. Click any box to edit. L starts a new line.';
  $('conversion-warnings').hidden = !sourceViews.warnings.length;
  $('conversion-warning-summary').textContent = `${sourceViews.warnings.length} conversion note${sourceViews.warnings.length === 1 ? '' : 's'} - review playback differences`;
  showScoreTab(viewedFormat);
}
function showScoreTab(format, focus = false) {
  viewedFormat = format;
  for (const name of ['dsl', 'musicxml']) {
    const selected = name === format;
    $(`${name}-tab`).setAttribute('aria-selected', String(selected));
    $(`${name}-tab`).tabIndex = selected ? 0 : -1;
    $(`${name}-panel`).hidden = !selected;
  }
  const main = project.scoreFormat || 'dsl';
  const label = format === 'dsl' ? 'DSL' : 'MusicXML';
  const mainLabel = main === 'dsl' ? 'DSL' : 'MusicXML';
  $('format-status').textContent = format === main ? `Editing ${label}. The other tab is generated automatically.`
    : `Generated from ${mainLabel}. Read-only - select ${label} as the main format to edit it.`;
  $('notation-hint').hidden = format !== 'dsl';
  $('duration-reference').hidden = format !== 'dsl';
  if (focus) $(`${format}-tab`).focus();
}
for (const name of ['dsl', 'musicxml']) {
  $(`${name}-tab`).addEventListener('click', () => { noteEditor.commit(); showScoreTab(name); renderPosition(); });
  $(`${name}-tab`).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 'dsl' : event.key === 'End' ? 'musicxml' : name === 'dsl' ? 'musicxml' : 'dsl';
    showScoreTab(target, true);
    renderPosition();
  });
}
$('musicxml-source').addEventListener('input', () => {
  if (project.scoreFormat !== 'musicxml') return;
  stopForEdit();
  project.musicxml = $('musicxml-source').value;
  refreshScore({ reset: true });
  save();
});
$('main-format').addEventListener('change', () => {
  const next = $('main-format').value;
  $('main-format').value = project.scoreFormat || 'dsl';
  if (next === (project.scoreFormat || 'dsl')) return;
  noteEditor.commit();
  syncSourceViews();
  if (sourceViews.error) { notify('Fix the main source before changing formats. ' + sourceViews.error, true); return; }
  requestedFormat = next;
  pausePlayback();
  const label = next === 'dsl' ? 'DSL' : 'MusicXML';
  $('format-dialog-title').textContent = `Make ${label} the main format?`;
  $('format-dialog-description').textContent = next === 'dsl'
    ? 'The converted DSL will replace the original MusicXML as the main source. Download the MusicXML first if you want to keep its original details.'
    : 'The generated MusicXML will become the main source. Future DSL content will be converted from it.';
  $('format-dialog').showModal();
  $('cancel-format').focus();
});
$('cancel-format').addEventListener('click', () => $('format-dialog').close());
$('format-dialog').addEventListener('close', () => { requestedFormat = null; $('main-format').focus(); });
$('confirm-format').addEventListener('click', () => {
  if (!requestedFormat) return;
  try {
    stopForEdit();
    project = switchScoreFormat(project, requestedFormat);
    viewedFormat = requestedFormat;
    noteEditor.setValue(project.notation);
    refreshScore({ reset: true });
    save();
    $('format-dialog').close();
  } catch (error) { notify(error.message, true); }
});
function applyProject() {
  $('score-title').value = project.title;
  viewedFormat = project.scoreFormat || 'dsl';
  noteEditor.setValue(project.notation);
  $('background-offset').value = project.backgroundOffset;
  $('note-offset').value = project.noteOffset;
  $('metronome-offset').value = project.metronomeOffset;
  $('metronome-volume').value = project.metronomeVolume;
  $('note-volume').value = project.noteVolume;
  $('background-volume').value = project.backgroundVolume;
  $('metronome').setAttribute('aria-pressed', String(project.metronome));
  $('loop').setAttribute('aria-pressed', String(project.loop));
  audio.setNoteVolume(project.noteVolume / 100);
  audio.setBackgroundVolume(project.backgroundVolume / 100);
  audio.setMetronomeVolume(project.metronomeVolume / 100);
  audio.setMetronome(project.metronome);
  $('instrument').value = project.instrument;
  void selectInstrument();
  updateVolumes();
  updatePlaybackSpeed();
  refreshScore({ reset: true });
}
function refreshScore({ reset = false } = {}) {
  syncSourceViews();
  parsed = parseNotation(project.notation);
  if (project.scoreFormat === 'musicxml' && sourceViews.error) parsed.errors.push({ start: 0, message: sourceViews.error });
  scoreTiming = createScoreTiming(parsed);
  project.tempo = parsed.tempo;
  project.numerator = parsed.numerator;
  project.denominator = parsed.denominator;
  syncTimingControls();
  audio.setTimeSignature(project.numerator, project.denominator);
  $('score-timing').textContent = `Initial: ${project.tempo} BPM / ${project.numerator}/${project.denominator}`;
  visualizer.setScore(parsed.errors.length ? [] : parsed.notes, { timing: scoreTiming });
  lastEditorPosition = null;
  const count = parsed.notes.filter(note => !note.isRest).length;
  const rests = parsed.notes.length - count;
  $('note-count').textContent = `${count} note${count === 1 ? '' : 's'}${rests ? ` + ${rests} rest${rests === 1 ? '' : 's'}` : ''}`;
  const bars = scoreTiming.totalBars;
  $('bar-count').textContent = `${bars} bar${bars === 1 ? '' : 's'}`;
  $('score-valid').innerHTML = parsed.errors.length ? 'Check notation' : parsed.notes.length ? `${icon('check')} Ready to play` : 'Add your first note';
  $('score-errors').hidden = !parsed.errors.length;
  $('score-errors').textContent = project.scoreFormat === 'musicxml' && sourceViews.error ? sourceViews.error : parsed.errors.slice(0, 3).map(error => `At character ${error.start + 1}: ${error.message}`).join(' ');
  $('empty-visualizer').hidden = Boolean(parsed.notes.length && !parsed.errors.length);
  $('empty-visualizer').querySelector('strong').textContent = parsed.errors.length ? 'One small fix before we play.' : audio.background ? 'Your backing track is ready.' : 'A blank score. A fresh start.';
  $('empty-visualizer').querySelector('span:last-child').textContent = parsed.errors.length ? 'Check the highlighted notation in your score.' : audio.background ? 'Press Play to listen, or add notes to practice along.' : 'Write a few notes in your score to begin.';
  timeline = audio.getTimeline({ notes: parsed.errors.length ? [] : parsed.notes, timing: scoreTiming, bpm: project.tempo, noteOffset: project.noteOffset, backgroundOffset: project.backgroundOffset, metronome: project.metronome, metronomeOffset: project.metronomeOffset });
  $('total-time').textContent = formatDuration(timeline.durationSeconds);
  $('seek').min = timeline.startBeat;
  $('seek').max = timeline.durationBeats ? timeline.endBeat : timeline.startBeat + 1;
  position = reset ? timeline.startBeat : Math.max(timeline.startBeat, Math.min(position, timeline.endBeat));
  refreshWaveforms();
  activeIndex = -2;
  updateTransport();
  renderPosition();
}
function refreshWaveforms() {
  $('track-lane').classList.toggle('is-empty', !timeline.hasBackground);
  $('track-mixer').hidden = !timeline.hasBackground;
  $('track-file').hidden = !timeline.hasBackground;
  $('track-waveform').hidden = !timeline.hasBackground;
  $('upload-background').hidden = timeline.hasBackground;
  $('metronome-lane').classList.toggle('is-off', !project.metronome);
  $('timeline-empty').hidden = timeline.hasNotes || timeline.hasBackground;
  $('timeline-help').hidden = !timeline.hasNotes && !timeline.hasBackground;
  $('waveform-ruler').parentElement.hidden = false;
  $('notes-lane-duration').textContent = formatDuration(timeline.scoreDuration);
  $('track-lane-duration').textContent = audio.background ? formatDuration(audio.background.duration) : '';
  $('track-lane-name').textContent = audio.background?.name || '';
  $('track-lane-name').title = audio.background?.name || '';
  waveforms.setData({ timeline, timing: scoreTiming, notes: parsed.errors.length ? [] : parsed.notes, bpm: project.tempo, instrument: project.instrument,
    instrumentData: audio.getInstrumentData(), backgroundBuffer: audio.getBackgroundBuffer(), noteVolume: project.noteVolume / 100, backgroundVolume: project.backgroundVolume / 100, metronome: project.metronome, metronomeVolume: project.metronomeVolume / 100, numerator: project.numerator, denominator: project.denominator });
  waveforms.setPosition(position * 60 / project.tempo);
}
function scoreBeatAtPosition(at = position) {
  const beat = scoreTiming.secondsToBeat(at * 60 / project.tempo - timeline.noteStartSeconds);
  // Keep a paused seek exactly on its note boundary after time conversions.
  return Math.round(beat * 1e9) / 1e9;
}
function transportBeatAtScoreBeat(beat) {
  return (timeline.noteStartSeconds + scoreTiming.beatToSeconds(beat)) * project.tempo / 60;
}
function currentNote() {
  const scoreBeat = scoreBeatAtPosition();
  if (parsed.errors.length || scoreBeat < 0) return null;
  // Binary search keeps highlighting quick even for long imported scores.
  let low = 0, high = parsed.notes.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1, note = parsed.notes[mid];
    if (scoreBeat < note.startBeat) high = mid - 1;
    else if (scoreBeat >= note.endBeat) low = mid + 1;
    else return note;
  }
  return null;
}
function renderPosition() {
  const scoreBeat = scoreBeatAtPosition();
  const seconds = position * 60 / project.tempo;
  visualizer.setPosition(scoreBeat);
  noteEditor.setPosition(scoreBeat, { follow: audio.isPlaying || position !== lastEditorPosition });
  waveforms.setPosition(seconds, { follow: audio.isPlaying || position !== lastEditorPosition });
  sheetMusic.setPosition(scoreBeat, { follow: audio.isPlaying || position !== lastEditorPosition });
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
  } else if (timeline.hasNotes && scoreBeat < 0) {
    $('current-note-title').textContent = 'Getting ready for the notes';
    $('current-note-detail').textContent = `Your first note in ${((timeline.noteStartSeconds - seconds) / project.playbackRate).toFixed(1)} seconds`;
    $('current-direction').innerHTML = icon('headphones');
  } else if (note) {
    const length = { w:'Whole', h:'Half', q:'Quarter', e:'Eighth', s:'Sixteenth' }[note.duration];
    $('current-note-title').textContent = note.isRest ? 'Take a breath' : `${note.draw ? 'Draw' : 'Blow'} hole ${note.hole} ${note.slider ? ' / Slider in' : ''}`;
    $('current-note-detail').textContent = `${note.isRest ? 'Rest' : note.pitch} / ${note.dotted ? 'Dotted ' + length.toLowerCase() : length} note / ${note.token}`;
    $('current-direction').innerHTML = icon(note.isRest ? 'wind' : note.draw ? 'arrow-down' : 'arrow-up');
    $('current-direction').style.color = note.draw ? '#eab09a' : '#b4edb1';
  } else if (timeline.hasBackground && seconds < timeline.backgroundEndSeconds) {
    const waiting = seconds < timeline.backgroundStartSeconds;
    $('current-note-title').textContent = waiting ? 'Getting ready for the track' : 'Backing track';
    $('current-note-detail').textContent = waiting ? `Track starts in ${((timeline.backgroundStartSeconds - seconds) / project.playbackRate).toFixed(1)} seconds` : audio.background.name;
    $('current-direction').innerHTML = icon('headphones');
  } else if (timeline.hasMetronome && seconds < timeline.metronomeEndSeconds) {
    const meter = scoreTiming.settingsAtBeat(scoreTiming.secondsToBeat(seconds - timeline.metronomeStartSeconds));
    $('current-note-title').textContent = 'Metronome';
    $('current-note-detail').textContent = seconds < timeline.metronomeStartSeconds ? `Clicks start in ${((timeline.metronomeStartSeconds - seconds) / project.playbackRate).toFixed(1)} seconds` : `${Number((meter.tempo * project.playbackRate).toFixed(2))} BPM / ${meter.numerator}/${meter.denominator}`;
    $('current-direction').innerHTML = icon('metronome');
  } else {
    const finished = timeline.durationBeats > 0 && position >= timeline.endBeat;
    $('current-note-title').textContent = finished ? 'Nicely played. Go again?' : "Let's play something";
    $('current-note-detail').textContent = finished ? 'Restart to take it from the top' : 'Write a melody or add a backing track';
    $('current-direction').innerHTML = icon('wind');
  }
  const totalBars = Math.max(1, scoreTiming.totalBars);
  const currentBar = Math.min(totalBars, scoreTiming.barAtBeat(Math.max(0, scoreBeat)));
  $('measure-label').innerHTML = timeline.hasNotes ? `BAR ${String(currentBar).padStart(2,'0')} <span>/ ${String(totalBars).padStart(2,'0')}</span>` : 'TRACK';
  $('elapsed').textContent = formatDuration(Math.max(0, seconds - timeline.startSeconds));
  $('seek').value = position;
  $('seek').setAttribute('aria-valuetext', `${$('elapsed').textContent} of ${$('total-time').textContent}`);
  setRangeFill($('seek'));
}
function updateTransport() {
  const playing = audio.isPlaying;
  $('play').querySelector('[data-icon]').innerHTML = icon(playing ? 'pause' : 'play');
  const playLabel = playing ? 'Pause' : pendingPlay ? 'Cancel' : 'Play';
  $('play-label').textContent = playLabel;
  $('play').setAttribute('aria-label', playLabel);
  const invalid = !!parsed.errors.length || timeline.durationBeats <= 0;
  $('play').disabled = invalid || backgroundLoading;
  ['restart','seek'].forEach(id => { $(id).disabled = invalid; });
  ['previous','next'].forEach(id => { $(id).disabled = invalid || !timeline.hasNotes; });
  $('play-status').textContent = manual?.note ? 'LIVE PLAY' : playing ? 'FIND YOUR FLOW' : position >= timeline.endBeat && timeline.durationBeats > 0 ? 'ONE MORE TIME?' : position > timeline.startBeat ? 'TAKE YOUR TIME' : 'READY WHEN YOU ARE';
  $('play-status-dot').classList.toggle('playing', playing || Boolean(manual?.note));
}
function startFrames() {
  if (frame !== null) return;
  const tick = () => { frame = null; if (!audio.isPlaying) return; position = audio.getPosition(); renderPosition(); frame = requestAnimationFrame(tick); };
  frame = requestAnimationFrame(tick);
}
function cancelFrames() { if (frame !== null) cancelAnimationFrame(frame); frame = null; }
function pausePlayback(stopManual = true) { if (stopManual) manual?.stop(); const beat = audio.isPlaying ? audio.getPosition() : position; playRequest++; pendingPlay = false; audio.pause(); position = beat; renderPosition(); }
async function startPlayback() {
  noteEditor.commit();
  if (backgroundLoading || parsed.errors.length || timeline.durationBeats <= 0) return;
  manual.stop();
  const request = ++playRequest;
  if (position >= timeline.endBeat) position = timeline.startBeat;
  pendingPlay = true;
  updateTransport();
  if (project.instrument !== 'synth') {
    $('instrument-status').textContent = 'Preparing sound...';
    $('instrument-status').classList.remove('error');
  }
  try {
    await audio.play({ notes: parsed.notes, timing: scoreTiming, bpm: project.tempo, playbackRate: project.playbackRate, fromBeat: position, noteOffset: project.noteOffset, backgroundOffset: project.backgroundOffset, metronome: project.metronome, metronomeOffset: project.metronomeOffset });
    if (request === playRequest && project.instrument !== 'synth') $('instrument-status').textContent = 'Ready';
  } catch (error) {
    if (request === playRequest) {
      if (project.instrument !== 'synth') {
        $('instrument-status').textContent = 'Could not play. Try again or choose another sound.';
        $('instrument-status').classList.add('error');
      }
      notify(error.message || 'Audio could not start in this browser.', true);
      updateTransport();
    }
  }
  finally { if (request === playRequest) { pendingPlay = false; updateTransport(); } }
}
async function togglePlayback() { if (audio.isPlaying || pendingPlay) pausePlayback(); else await startPlayback(); }
async function seekTo(beat) {
  const wasPlaying = audio.isPlaying || pendingPlay;
  pausePlayback();
  position = Math.max(timeline.startBeat, Math.min(beat, timeline.endBeat));
  renderPosition(); updateTransport();
  if (wasPlaying && position < timeline.endBeat) await startPlayback();
}
function stepNote(direction) {
  if (!parsed.notes.length || parsed.errors.length) return;
  const beat = scoreBeatAtPosition(audio.isPlaying ? audio.getPosition() : position);
  let target;
  if (direction > 0) target = parsed.notes.find(note => note.startBeat > beat + 0.025)?.startBeat;
  else target = [...parsed.notes].reverse().find(note => note.startBeat < beat - 0.08)?.startBeat;
  void seekTo(target === undefined ? (direction > 0 ? timeline.endBeat : timeline.startBeat) : transportBeatAtScoreBeat(target));
}
function stopForEdit() {
  pausePlayback(); position = timeline.startBeat;
}
$('play').addEventListener('click', () => { void togglePlayback(); });
$('restart').addEventListener('click', () => { void seekTo(timeline.startBeat); });
$('previous').addEventListener('click', () => stepNote(-1));
$('next').addEventListener('click', () => stepNote(1));
let resumeAfterScrub = false;
$('seek').addEventListener('pointerdown', () => { resumeAfterScrub = audio.isPlaying || pendingPlay; pausePlayback(); });
$('seek').addEventListener('input', () => { if (audio.isPlaying) pausePlayback(); position = Number($('seek').value); renderPosition(); updateTransport(); });
$('seek').addEventListener('change', () => { if (resumeAfterScrub && position < timeline.endBeat) void startPlayback(); resumeAfterScrub = false; });
$('score-title').addEventListener('input', () => { project.title = $('score-title').value; syncSourceViews(); save(); });

function syncTimingControls() {
  for (const [id, value] of [['tempo', project.tempo], ['time-numerator', project.numerator], ['time-denominator', project.denominator]]) {
    if ($(id).value !== String(value)) $(id).value = value;
  }
  const readOnly = project.scoreFormat === 'musicxml';
  ['tempo', 'time-numerator', 'time-denominator'].forEach(id => { $(id).disabled = readOnly; });
  $('tempo-down').disabled = readOnly || project.tempo <= 30;
  $('tempo-up').disabled = readOnly || project.tempo >= 300;
}
function editScoreTiming(patch) {
  if (project.scoreFormat === 'musicxml') return;
  try {
    const source = noteEditor.getValue();
    const updated = updateScoreTiming(source, patch);
    if (updated !== source) {
      // Apply only the changed range so timing edits share the score's undo history.
      let start = 0, end = source.length, updatedEnd = updated.length;
      while (start < end && start < updatedEnd && source[start] === updated[start]) start++;
      while (end > start && updatedEnd > start && source[end - 1] === updated[updatedEnd - 1]) { end--; updatedEnd--; }
      noteEditor.applyEdit(start, end, updated.slice(start, updatedEnd), { finish: true });
    }
  } catch (error) {
    notify(error.message || 'Check the timing lines in your score.', true);
  }
  syncTimingControls();
}
for (const [id, key] of [['tempo', 'tempo'], ['time-numerator', 'numerator']]) {
  const input = $(id);
  input.addEventListener('input', () => {
    if (input.value !== '' && input.validity.valid) editScoreTiming({ [key]: Number(input.value) });
  });
  input.addEventListener('change', () => {
    if (input.value !== '') {
      const value = Math.min(Number(input.max), Math.max(Number(input.min), Math.round(Number(input.value))));
      editScoreTiming({ [key]: value });
    } else syncTimingControls();
  });
  input.addEventListener('blur', syncTimingControls);
}
$('tempo-down').addEventListener('click', () => editScoreTiming({ tempo: Math.max(30, project.tempo - 5) }));
$('tempo-up').addEventListener('click', () => editScoreTiming({ tempo: Math.min(300, project.tempo + 5) }));
$('time-denominator').addEventListener('change', () => editScoreTiming({ denominator: Number($('time-denominator').value) }));

async function changeTiming(update) {
  const wasPlaying = audio.isPlaying || pendingPlay;
  pausePlayback();
  const atStart = position === timeline.startBeat;
  update();
  refreshScore({ reset: atStart }); save();
  if (wasPlaying && position < timeline.endBeat) await startPlayback();
}
function updatePlaybackSpeed() {
  const rate = project.playbackRate;
  $('playback-rate').value = rate;
  $('playback-rate').setAttribute('aria-valuetext', `${rate} times normal speed`);
  $('playback-rate-value').textContent = `${rate}x`;
  $('speed-down').disabled = rate <= 0.25;
  $('speed-up').disabled = rate >= 2;
  $('speed-reset').disabled = rate === 1;
  setRangeFill($('playback-rate'));
}
async function changePlaybackSpeed(value) {
  const rate = Math.round(Math.min(2, Math.max(0.25, Number(value) || 1)) * 100) / 100;
  if (rate === project.playbackRate) return;
  const wasPlaying = audio.isPlaying || pendingPlay;
  pausePlayback();
  project.playbackRate = rate;
  updatePlaybackSpeed();
  renderPosition();
  save();
  if (wasPlaying && position < timeline.endBeat) await startPlayback();
}
$('playback-rate').addEventListener('input', () => { void changePlaybackSpeed($('playback-rate').value); });
$('speed-down').addEventListener('click', () => { void changePlaybackSpeed(project.playbackRate - 0.05); });
$('speed-up').addEventListener('click', () => { void changePlaybackSpeed(project.playbackRate + 0.05); });
$('speed-reset').addEventListener('click', () => { void changePlaybackSpeed(1); });
async function selectInstrument(resume = false) {
  const request = ++instrumentRequest;
  const playbackRequest = playRequest;
  if (resume) { pendingPlay = true; updateTransport(); }
  $('instrument-status').textContent = project.instrument === 'synth' ? '' : 'Loading sound...';
  $('instrument-status').classList.remove('error');
  $('instrument').setAttribute('aria-busy', 'true');
  try {
    await audio.setInstrument(project.instrument);
    if (request !== instrumentRequest) return;
    $('instrument-status').textContent = project.instrument === 'synth' ? '' : 'Ready';
    refreshWaveforms();
    if (resume && playbackRequest === playRequest && position < timeline.endBeat) await startPlayback();
  } catch (error) {
    if (request !== instrumentRequest) return;
    $('instrument-status').textContent = 'Could not load. Choose a sound to retry.';
    $('instrument-status').classList.add('error');
    notify(error.message || 'This sound could not load. Try again or choose Synthesized reed.', true);
  } finally {
    if (request === instrumentRequest) {
      $('instrument').setAttribute('aria-busy', 'false');
      if (resume && playbackRequest === playRequest) { pendingPlay = false; updateTransport(); }
    }
  }
}
$('instrument').addEventListener('change', () => {
  const wasPlaying = audio.isPlaying || pendingPlay;
  pausePlayback();
  project.instrument = $('instrument').value;
  save();
  void selectInstrument(wasPlaying);
});
for (const [id, field] of [['background-offset', 'backgroundOffset'], ['note-offset', 'noteOffset'], ['metronome-offset', 'metronomeOffset']]) {
  const input = $(id);
  const setOffset = () => {
    const value = Math.min(600, Math.max(-600, Number(input.value) || 0));
    input.value = value;
    if (value !== project[field]) void changeTiming(() => { project[field] = value; });
  };
  input.addEventListener('input', () => { if (input.validity.valid && input.value !== '') setOffset(); });
  input.addEventListener('change', setOffset);
}
$('metronome').addEventListener('click', () => { void changeTiming(() => { project.metronome = !project.metronome; audio.setMetronome(project.metronome); $('metronome').setAttribute('aria-pressed', String(project.metronome)); }); });
$('loop').addEventListener('click', () => { project.loop = !project.loop; $('loop').setAttribute('aria-pressed', String(project.loop)); save(); });
function updateVolumes() {
  ['note','background','metronome'].forEach(type => { $(`${type}-volume-value`).textContent = `${$(`${type}-volume`).value}%`; setRangeFill($(`${type}-volume`)); });
}
$('note-volume').addEventListener('input', () => { project.noteVolume = Number($('note-volume').value); audio.setNoteVolume(project.noteVolume / 100); updateVolumes(); refreshWaveforms(); save(); });
$('background-volume').addEventListener('input', () => { project.backgroundVolume = Number($('background-volume').value); audio.setBackgroundVolume(project.backgroundVolume / 100); updateVolumes(); refreshWaveforms(); save(); });

$('metronome-volume').addEventListener('input', () => { project.metronomeVolume = Number($('metronome-volume').value); audio.setMetronomeVolume(project.metronomeVolume / 100); updateVolumes(); refreshWaveforms(); save(); });

const examples = {
  warmup: { ...DEFAULT_PROJECT },
  chromatic: { ...DEFAULT_PROJECT, title:'Chromatic steps', notation:'TEMPO 75\nTSIG 4/4\n1q 1#q -1q -1#q |\n2q -2q -2#q 3q |\n3#q -3q -3#q -4q |\n4h 0h' },
  waltz: { ...DEFAULT_PROJECT, title:'A little 6/8', notation:'TEMPO 70\nTSIG 6/8\n1q. 2e 3e 2e |\n-1q. -2q. |\n2e 3e 4e -4e -3e 3e |\n2h. |\n1q. 2e 3e 2e |\n-1e 2e -2e 3q. |\n4q. -4q. |\n4h 0q' },
  changes: { ...DEFAULT_PROJECT, title:'Tempo and meter changes', notation:'TEMPO 60 TSIG 4/4\n1q -1q 2q -2q\nTEMPO 90 3q -3q -4q 4q\nTSIG 6/8 4q. -4q. | 3q. -3q.\nTEMPO 60 TSIG 4/4 2h 1h' },
  blank: { ...DEFAULT_PROJECT, title:'Untitled melody', notation:'' },
};
$('examples').addEventListener('change', () => {
  if (project.scoreFormat === 'musicxml') return;
  const example = examples[$('examples').value];
  if (!example) return;
  stopForEdit();
  project = { ...example, instrument: project.instrument, playbackRate: project.playbackRate, noteVolume: project.noteVolume, backgroundVolume:project.backgroundVolume, backgroundOffset: project.backgroundOffset, noteOffset: project.noteOffset, metronome: project.metronome, metronomeOffset: project.metronomeOffset, metronomeVolume: project.metronomeVolume };
  applyProject(); save(); $('examples').value = '';
});
$('import-button').addEventListener('click', () => $('import-file').click());
async function copyScoreText(source, button, label) {
  if (!source) return;
  try {
    await navigator.clipboard.writeText(source);
    notify(`${label} copied as text.`);
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
    button.focus({ preventScroll: true });
    notify(copied ? `${label} copied as text.` : 'Copy was blocked. Select the text and use your keyboard to copy.', !copied);
  }
}
$('copy-notes').addEventListener('click', () => { void copyScoreText(project.notation, $('copy-notes'), 'DSL'); });
$('copy-musicxml').addEventListener('click', () => { void copyScoreText(sourceViews.musicxml, $('copy-musicxml'), 'MusicXML'); });
$('download-musicxml').addEventListener('click', () => {
  if (sourceViews.error || !sourceViews.musicxml) return;
  const url = URL.createObjectURL(new Blob([sourceViews.musicxml], { type: 'application/vnd.recordare.musicxml+xml' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${(project.title.trim() || 'my-score').replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-').toLowerCase() || 'my-score'}.musicxml`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0];
  if (!file) return;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error('Choose a score smaller than 16 MB. MusicXML source is limited to 2 million characters.');
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
  backgroundLoading = true;
  pausePlayback();
  $('upload-background').disabled = true;
  $('replace-background').disabled = true;
  $('upload-background').querySelector('strong').textContent = 'Opening your track...';
  try {
    const track = await audio.setBackground(file);
    if (request !== backgroundRequest || !track) return;
    pausePlayback();
    refreshScore({ reset: true });
    notify('Track loaded. Adjust its volume and delay beside the waveform.');
  } catch {
    if (request === backgroundRequest) {
      pausePlayback();
      if (!audio.background) refreshScore({ reset: true });
      notify('This audio file could not be opened. Try an MP3 or WAV file.', true);
    }
  }
  finally {
    if (request === backgroundRequest) { backgroundLoading = false; updateTransport(); $('upload-background').disabled = false; $('replace-background').disabled = false; $('upload-background').querySelector('strong').textContent = 'Add backing track'; }
  }
}
['upload-background', 'replace-background'].forEach(id => $(id).addEventListener('click', () => $('background-file').click()));
$('background-file').addEventListener('change', () => { void loadBackground($('background-file').files[0]); $('background-file').value = ''; });
$('remove-background').addEventListener('click', () => { backgroundRequest++; backgroundLoading = false; pausePlayback(); audio.clearBackground(); $('upload-background').disabled = false; $('replace-background').disabled = false; $('upload-background').querySelector('strong').textContent = 'Add backing track'; refreshScore({ reset: true }); });
['dragenter','dragover'].forEach(name => $('track-lane').addEventListener(name, event => { event.preventDefault(); $('track-lane').classList.add('drag-over'); }));
['dragleave','drop'].forEach(name => $('track-lane').addEventListener(name, event => { event.preventDefault(); $('track-lane').classList.remove('drag-over'); }));
$('track-lane').addEventListener('drop', event => { void loadBackground(event.dataTransfer.files[0]); });
window.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });

const guide = $('guide-dialog');
['guide-button','hint-help'].forEach(id => $(id).addEventListener('click', () => guide.showModal()));
$('close-guide').addEventListener('click', () => guide.close());
guide.addEventListener('click', event => { const rect = guide.getBoundingClientRect(); if (event.target === guide && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) guide.close(); });
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || guide.open || $('format-dialog').open || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input,textarea,select,button,[role=textbox],[role=slider],[role=separator]')) return;
  if (event.code === 'ArrowRight') { event.preventDefault(); stepNote(1); }
  if (event.code === 'Home') { event.preventDefault(); void seekTo(timeline.startBeat); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && audio.isPlaying) { position = audio.getPosition(); renderPosition(); } });
window.addEventListener('pagehide', () => { audio.stop(); cancelFrames(); });

document.querySelectorAll('[data-panel-toggle]').forEach(button => {
  const content = $(button.getAttribute('aria-controls'));
  const panel = button.closest('[data-panel]');
  const update = () => {
    const action = content.hidden ? 'Show' : 'Hide';
    button.textContent = action;
    button.setAttribute('aria-expanded', String(!content.hidden));
    button.setAttribute('aria-label', `${action} ${button.dataset.panelName}`);
    panel.classList.toggle('is-collapsed', content.hidden);
  };
  button.addEventListener('click', () => {
    content.hidden = !content.hidden;
    update();
    if (!content.hidden) requestAnimationFrame(() => renderPosition());
  });
  update();
});
const playbackDock = $('playback-dock');
const updateDockHeight = () => {
  document.documentElement.style.setProperty('--playback-dock-height', `${Math.ceil(playbackDock.getBoundingClientRect().height)}px`);
};
new ResizeObserver(updateDockHeight).observe(playbackDock);
updateDockHeight();
const workspace = $('workspace');
workspace.addEventListener('workspace-layout-change', () => requestAnimationFrame(() => renderPosition()));
new WorkspaceLayout({
  workspace,
  captureSelection: () => document.activeElement === noteEditor.editor ? {
    selection: noteEditor.selection(),
    activeRange: noteEditor.activeRange && { ...noteEditor.activeRange },
  } : null,
  restoreSelection: saved => {
    // Moving a focused editor commits its chips on blur. Restore source offsets
    // and the open chip after the panels have reached their new rows.
    noteEditor.activeRange = saved.activeRange;
    noteEditor.render(saved.selection);
    noteEditor.restoreSelection(saved.selection, true);
  },
});
applyProject();
if (storageWarning) notify('Your saved score could not be restored. You can import a backup.', true);
