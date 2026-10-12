import { musicXmlToDsl } from './musicxml.js';
import { parseNotation } from './notation.js';
import { createSheetBeatMap } from './sheet-timing.js';

let libraryPromise;
function loadLibrary() {
  if (globalThis.opensheetmusicdisplay) return Promise.resolve(globalThis.opensheetmusicdisplay);
  if (!libraryPromise) libraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./assets/vendor/osmd/opensheetmusicdisplay.min.js?v=2.2.1', import.meta.url).href;
    script.onload = () => globalThis.opensheetmusicdisplay ? resolve(globalThis.opensheetmusicdisplay) : reject(new Error('The sheet music library did not load.'));
    script.onerror = () => { script.remove(); reject(new Error('The sheet music library could not be loaded. Try again.')); };
    document.head.append(script);
  }).catch(error => { libraryPromise = null; throw error; });
  return libraryPromise;
}

// OSMD reads partwise XML with unprefixed element names. Rebuild only the XML
// tree, retaining score details while excluding external images and links.
export function prepareSheetDocument(xml) {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.querySelector('parsererror')) throw new Error('Fix the MusicXML source to show its sheet music.');
  const source = parsed.documentElement;
  const document = parsed.implementation.createDocument(null, 'score-partwise');
  const root = document.documentElement;
  const copyAttributes = (from, to) => {
    for (const attribute of from.attributes) {
      if (attribute.name.startsWith('xmlns') || attribute.name.includes(':')) continue;
      to.setAttribute(attribute.name, attribute.value);
    }
  };
  const copy = node => {
    if (node.nodeType === 3 || node.nodeType === 4) return document.createTextNode(node.textContent);
    if (node.nodeType !== 1 || ['credit-image', 'image', 'link', 'bookmark'].includes(node.localName)) return null;
    const result = document.createElement(node.localName);
    copyAttributes(node, result);
    for (const child of node.childNodes) { const next = copy(child); if (next) result.append(next); }
    return result;
  };
  copyAttributes(source, root);
  if (source.localName === 'score-timewise') {
    const measures = [...source.children].filter(node => node.localName === 'measure');
    for (const child of source.children) if (child.localName !== 'measure') { const next = copy(child); if (next) root.append(next); }
    const ids = [...new Set(measures.flatMap(measure => [...measure.children].filter(node => node.localName === 'part').map(part => part.getAttribute('id'))))];
    for (const id of ids) {
      const part = document.createElement('part'); part.setAttribute('id', id);
      for (const measure of measures) {
        const next = document.createElement('measure'); copyAttributes(measure, next);
        const original = [...measure.children].find(node => node.localName === 'part' && node.getAttribute('id') === id);
        for (const child of original?.childNodes || []) { const item = copy(child); if (item) next.append(item); }
        part.append(next);
      }
      root.append(part);
    }
  } else {
    for (const child of source.childNodes) { const next = copy(child); if (next) root.append(next); }
  }
  if (root.getElementsByTagName('note').length > 2500 || root.getElementsByTagName('measure').length > 600) {
    throw new Error('This score is too large for the sheet preview (2,500 notes or 600 measures). Score editing and playback are still available.');
  }
  const parts = [...root.children].filter(node => node.localName === 'part');
  let totalStaves = 0;
  for (const part of parts) {
    const counts = [...part.getElementsByTagName('staves')].map(node => Number(node.textContent));
    const staffNumbers = [...part.getElementsByTagName('staff')].map(node => Number(node.textContent));
    if ([...counts, ...staffNumbers].some(value => !Number.isInteger(value) || value < 1 || value > 16)) {
      throw new Error('The sheet preview supports up to 16 staves per part. Score editing and playback are still available.');
    }
    totalStaves += Math.max(1, ...counts, ...staffNumbers);
  }
  if (parts.length > 32 || totalStaves > 64 || [...root.getElementsByTagName('staff-lines')].some(node => !Number.isInteger(Number(node.textContent)) || Number(node.textContent) < 1 || Number(node.textContent) > 12)) {
    throw new Error('This score has too many staves or staff lines for the sheet preview. Score editing and playback are still available.');
  }
  return document;
}

export class SheetMusic {
  constructor(card) {
    const find = id => card.querySelector(`#${id}`);
    this.card = card;
    this.body = find('sheet-body');
    this.viewport = find('sheet-viewport');
    this.container = find('sheet-notation');
    this.playhead = find('sheet-playhead');
    this.status = find('sheet-status');
    this.help = find('sheet-help');
    this.retry = find('sheet-retry');
    this.follow = find('sheet-follow');
    this.zoomOut = find('sheet-zoom-out');
    this.zoomIn = find('sheet-zoom-in');
    this.zoomValue = find('sheet-zoom-value');
    this.zoom = 1;
    this.position = 0;
    this.revision = 0;
    this.totalBeats = 0;
    this.ready = false;
    this.collapsed = false;
    this.retry.addEventListener('click', () => this.schedule());
    this.zoomOut.addEventListener('click', () => this.setZoom(this.zoom - 0.1));
    this.zoomIn.addEventListener('click', () => this.setZoom(this.zoom + 0.1));
    this.follow.addEventListener('change', () => this.setPosition(this.position, { follow: this.follow.checked }));
    find('sheet-toggle').addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.body.hidden = this.collapsed;
      find('sheet-toggle').textContent = this.collapsed ? 'Show' : 'Hide';
      find('sheet-toggle').setAttribute('aria-expanded', String(!this.collapsed));
      if (!this.collapsed) { if (!this.ready) this.schedule(); else this.relayout(); }
    });
    let width = 0;
    this.observer = new ResizeObserver(entries => {
      const next = Math.round(entries[0].contentRect.width);
      if (next > 0 && next !== width) { width = next; clearTimeout(this.resizeTimer); this.resizeTimer = setTimeout(() => this.relayout(), 120); }
    });
    this.observer.observe(this.viewport);
  }

  setScore(xml, { error = null, notation = '', warnings = [] } = {}) {
    this.xml = xml;
    this.error = error;
    this.totalBeats = parseNotation(notation).totalBeats;
    this.help.textContent = warnings.length
      ? 'Original MusicXML. Playback follows the converted melody; see Conversion notes in Your score for any differences.'
      : 'From your MusicXML. The line follows Notes playback.';
    this.revision++;
    this.ready = false;
    this.playhead.hidden = true;
    this.container.replaceChildren();
    this.retry.hidden = true;
    clearTimeout(this.timer);
    if (error) { this.message('Fix the score to update the sheet music.'); return; }
    if (!xml || !this.totalBeats) { this.message('Write or import notes to see the sheet music.'); return; }
    this.message('Updating sheet music...');
    if (!this.collapsed) this.schedule();
  }

  message(text) { this.status.textContent = text; this.status.hidden = !text; }
  schedule() {
    clearTimeout(this.timer);
    if (!this.xml || this.error || !this.totalBeats || this.collapsed) return;
    const revision = ++this.revision;
    this.timer = setTimeout(() => { void this.render(revision); }, 250);
  }

  async render(revision) {
    this.ready = false;
    this.playhead.hidden = true;
    this.retry.hidden = true;
    this.message('Updating sheet music...');
    let renderer;
    try {
      const converted = musicXmlToDsl(this.xml);
      const doc = prepareSheetDocument(this.xml);
      const library = await loadLibrary();
      if (revision !== this.revision || this.collapsed) return;
      this.library = library;
      // Keep old asynchronous loads away from the active container.
      const target = document.createElement('div');
      this.container.replaceChildren(target);
      this.osmd?.clear();
      renderer = new library.OpenSheetMusicDisplay(target, {
        autoResize: false, backend: 'svg', pageFormat: 'Endless', drawTitle: true,
        drawSubtitle: false, drawComposer: false, drawLyricist: false,
        drawPartNames: doc.documentElement.getElementsByTagName('part').length > 1,
        drawPartAbbreviations: doc.documentElement.getElementsByTagName('part').length > 1,
        drawCredits: false, disableCursor: true,
        autoGenerateMultipleRestMeasuresFromRestMeasures: false,
        renderSingleHorizontalStaffline: false,
        newSystemFromXML: true, newSystemFromNewPageInXML: true, newPageFromXML: false,
      });
      renderer.setLogLevel('error');
      renderer.EngravingRules.CursorIgnoreRepetitions = true;
      renderer.EngravingRules.RenderMultipleRestMeasures = false;
      await renderer.load(doc);
      if (revision !== this.revision || this.collapsed) { renderer.clear(); return; }
      this.osmd = renderer;
      this.converted = converted;
      this.osmd.Zoom = 0.8 * this.zoom;
      this.osmd.render();
      this.updateBeatMap();
      this.ready = true;
      this.message('');
      this.setPosition(this.position);
    } catch (error) {
      renderer?.clear();
      if (revision !== this.revision) return;
      this.container.replaceChildren();
      this.ready = false;
      this.message(error.message || 'This MusicXML score could not be displayed. Editing and playback are still available.');
      this.retry.hidden = false;
    }
  }

  updateBeatMap() {
    const displayStarts = this.osmd.Sheet.SourceMeasures.map(measure => measure.AbsoluteTimestamp.RealValue * 4);
    this.beatMap = createSheetBeatMap(this.converted.beatMap, this.converted.sourceMeasureStarts, displayStarts);
  }

  setZoom(value) {
    this.zoom = Math.min(1.5, Math.max(0.6, Math.round(value * 10) / 10));
    this.zoomValue.textContent = `${Math.round(this.zoom * 100)}%`;
    this.zoomOut.disabled = this.zoom <= 0.6;
    this.zoomIn.disabled = this.zoom >= 1.5;
    this.relayout();
  }

  relayout() {
    if (!this.ready || this.collapsed) return;
    try {
      this.osmd.Zoom = 0.8 * this.zoom;
      this.osmd.render();
      this.updateBeatMap();
      this.setPosition(this.position);
    } catch {
      this.ready = false;
      this.playhead.hidden = true;
      this.message('The sheet could not be resized. Try rendering it again.');
      this.retry.hidden = false;
    }
  }

  setPosition(beat, { follow = false } = {}) {
    this.position = beat;
    if (!this.ready || this.collapsed || beat < 0 || beat > this.totalBeats + 1e-7) { this.playhead.hidden = true; return; }
    try {
      const displayBeat = this.beatMap.displayBeatAt(beat);
      const [x, system] = this.osmd.GraphicSheet.calculateXPositionFromTimestamp(new this.library.Fraction(displayBeat, 4, 0, false));
      if (!system?.StaffLines.length) { this.playhead.hidden = true; return; }
      const scale = 10 * this.osmd.Zoom;
      const y = system.PositionAndShape.AbsolutePosition.y + system.StaffLines[0].PositionAndShape.RelativePosition.y;
      const last = system.StaffLines.at(-1);
      const height = system.PositionAndShape.AbsolutePosition.y + last.PositionAndShape.RelativePosition.y + last.StaffHeight - y;
      if (![x, y, height].every(Number.isFinite)) { this.playhead.hidden = true; return; }
      this.playhead.style.transform = `translate(${x * scale}px, ${y * scale - 8}px)`;
      this.playhead.style.height = `${height * scale + 16}px`;
      this.playhead.hidden = false;
      if (follow && this.follow.checked) {
        const top = y * scale - 20, bottom = (y + height) * scale + 20;
        if (top < this.viewport.scrollTop || bottom > this.viewport.scrollTop + this.viewport.clientHeight) this.viewport.scrollTop = Math.max(0, top - 24);
        const left = x * scale;
        if (left < this.viewport.scrollLeft + 20 || left > this.viewport.scrollLeft + this.viewport.clientWidth - 20) this.viewport.scrollLeft = Math.max(0, left - this.viewport.clientWidth * 0.25);
      }
    } catch { this.playhead.hidden = true; }
  }
}
