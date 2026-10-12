import { convertSheetToMusicXml, validateSheetFile } from './legato.js';
import { parseProjectFile } from './project.js';
import { deriveScoreFormats } from './score-formats.js';
import { parseNotation } from './notation.js';

/** Keep recognition separate from the current score until the user imports it. */
export class SheetImport {
  constructor({ dialog, openButton, onOpen, onUse }) {
    this.dialog = dialog;
    this.openButton = openButton;
    this.onUse = onUse;
    this.find = id => dialog.querySelector(`#${id}`);
    this.fileInput = this.find('sheet-import-file');
    this.status = this.find('sheet-import-status');
    this.convertButton = this.find('convert-sheet');
    this.useButton = this.find('use-sheet-result');
    this.downloadButton = this.find('download-sheet-result');
    this.cancelButton = this.find('cancel-sheet-conversion');
    this.attempt = 0;
    this.file = null;
    this.result = null;
    this.imported = null;
    this.controller = null;
    openButton.addEventListener('click', () => {
      onOpen?.();
      dialog.showModal();
      this.fileInput.focus();
    });
    this.find('close-sheet-import').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      this.cancel();
      openButton.focus({ preventScroll: true });
    });
    this.fileInput.addEventListener('change', () => this.selectFile());
    this.convertButton.addEventListener('click', () => { void this.convert(); });
    this.cancelButton.addEventListener('click', () => this.cancel());
    this.downloadButton.addEventListener('click', () => this.download());
    this.useButton.addEventListener('click', () => {
      if (!this.imported || this.controller) return;
      try {
        this.onUse(this.imported);
        dialog.close();
      } catch (error) { this.setStatus(error.message || 'This score could not be imported.', true); }
    });
    window.addEventListener('pagehide', () => this.cancel());
  }

  setStatus(message, error = false) {
    this.status.textContent = message;
    this.status.classList.toggle('sheet-import-error', error);
  }

  setBusy(busy) {
    this.fileInput.disabled = busy;
    this.convertButton.disabled = busy || !this.file;
    this.cancelButton.hidden = !busy;
    this.useButton.disabled = busy || !this.imported;
    this.dialog.setAttribute('aria-busy', String(busy));
  }

  clearResult() {
    this.result = null;
    this.imported = null;
    this.find('sheet-import-result').hidden = true;
    this.find('sheet-import-source').value = '';
    this.find('sheet-import-warning-list').replaceChildren();
    this.find('sheet-import-warnings').hidden = true;
    this.useButton.hidden = true;
    this.downloadButton.hidden = true;
    this.convertButton.textContent = 'Convert';
  }

  selectFile() {
    this.cancel();
    this.clearResult();
    this.file = null;
    const file = this.fileInput.files[0];
    try {
      if (file) this.file = validateSheetFile(file);
      this.setStatus(file ? `${file.name} is ready to convert.` : 'Choose a file to start.');
    } catch (error) { this.setStatus(error.message, true); }
    this.setBusy(false);
  }

  cancel() {
    if (!this.controller) return;
    this.attempt++;
    this.controller.abort();
    this.controller = null;
    this.setBusy(false);
    this.setStatus('Conversion canceled here. LEGATO may finish a job it already received.');
  }

  async convert() {
    if (!this.file || this.controller) return;
    this.clearResult();
    const attempt = ++this.attempt;
    const controller = new AbortController();
    this.controller = controller;
    this.setBusy(true);
    this.setStatus('Connecting to LEGATO...');
    try {
      const result = await convertSheetToMusicXml(this.file, {
        signal: controller.signal,
        onProgress: message => { if (attempt === this.attempt) this.setStatus(message); },
      });
      if (attempt !== this.attempt || controller.signal.aborted) return;
      this.result = result;
      this.find('sheet-import-source').value = result.musicxml;
      this.find('sheet-import-result').hidden = false;
      this.downloadButton.hidden = false;
      this.convertButton.textContent = 'Convert again';
      try {
        this.imported = parseProjectFile(result.musicxml, this.resultName());
        const parsed = parseNotation(this.imported.notation);
        const warnings = deriveScoreFormats(this.imported).warnings;
        this.find('sheet-import-summary').textContent = `${parsed.notes.length} notes and rests in the harmonica conversion.`;
        this.find('sheet-import-warning-list').replaceChildren(...warnings.map(message => {
          const item = this.dialog.ownerDocument.createElement('li');
          item.textContent = message;
          return item;
        }));
        this.find('sheet-import-warnings').hidden = warnings.length === 0;
        this.useButton.hidden = false;
        this.setStatus('MusicXML is ready. Your current score has not changed.');
      } catch (error) {
        this.imported = null;
        this.find('sheet-import-summary').textContent = 'You can download the MusicXML and correct it in a notation editor.';
        this.setStatus(`MusicXML was generated, but ChromaPlay could not read it: ${error.message}`, true);
      }
    } catch (error) {
      if (attempt !== this.attempt) return;
      this.setStatus(error.name === 'AbortError' ? 'Conversion canceled.' : error.message || 'Conversion failed. Try again or open the LEGATO demo.', error.name !== 'AbortError');
    } finally {
      if (attempt === this.attempt) {
        this.controller = null;
        this.setBusy(false);
      }
    }
  }

  resultName() {
    const name = (this.file?.name || 'Recognized score').replace(/\.[^.]+$/, '').replace(/[\\/]/g, '-');
    return `${name.slice(0, 100) || 'Recognized score'}.musicxml`;
  }

  download() {
    if (!this.result) return;
    const url = URL.createObjectURL(new Blob([this.result.musicxml], { type: 'application/vnd.recordare.musicxml+xml' }));
    const anchor = this.dialog.ownerDocument.createElement('a');
    anchor.href = url;
    anchor.download = this.resultName();
    this.dialog.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
