import { parseNotation } from './notation.js';
import { noteColors, noteGeometry, editorBeatWidth } from './note-style.js';

/** Keep the source unchanged while choosing which notes can become chips. */
export function editorSegments(source, activeRange = null) {
  const score = parseNotation(source);
  const segments = [];
  const appendText = (start, end) => {
    let cursor = start;
    let marker = source.indexOf('L', cursor);
    while (marker >= 0 && marker < end) {
      // Even an unfinished header stays plain text while it is being edited.
      if (score.directives.some(directive => marker >= directive.start && marker < directive.end)) {
        marker = source.indexOf('L', marker + 1);
        continue;
      }
      if (marker > cursor) segments.push({ type: 'text', text: source.slice(cursor, marker), start: cursor, end: marker });
      segments.push({ type: 'line-break', text: 'L', start: marker, end: marker + 1 });
      cursor = marker + 1;
      marker = source.indexOf('L', cursor);
    }
    if (cursor < end) segments.push({ type: 'text', text: source.slice(cursor, end), start: cursor, end });
  };
  let offset = 0;
  for (const note of score.notes) {
    const text = source.slice(note.start, note.end);
    const active = activeRange && note.start < activeRange.end && note.end > activeRange.start;
    if (active || /[\r\n]/.test(text)) continue;
    if (note.start > offset) appendText(offset, note.start);
    segments.push({ type: 'note', text, start: note.start, end: note.end, note });
    offset = note.end;
  }
  if (offset < source.length) appendText(offset, source.length);
  return { ...score, segments };
}

/** Source positions stay independent of chip labels and visual line wrapping. */
export function replaceNotation(source, start, end, inserted) {
  const from = Math.max(0, Math.min(source.length, Math.min(start, end)));
  const to = Math.max(from, Math.min(source.length, Math.max(start, end)));
  return { source: source.slice(0, from) + inserted + source.slice(to), caret: from + inserted.length };
}

function sourceLength(node) {
  if (node.nodeType === 3) return node.data.length;
  if (node.nodeType !== 1) return 0;
  if (node.hasAttribute('data-editor-sentinel') || node.hasAttribute('data-editor-line-break')) return 0;
  if (node.matches('.note-chip, .note-line-break')) return node.dataset.source.length;
  if (node.tagName === 'BR') return 1;
  return Array.from(node.childNodes).reduce((length, child) => length + sourceLength(child), 0);
}

function sourceText(node) {
  if (node.nodeType === 3) return node.data;
  if (node.nodeType !== 1 || node.hasAttribute('data-editor-sentinel') || node.hasAttribute('data-editor-line-break')) return '';
  if (node.matches('.note-chip, .note-line-break')) return node.dataset.source;
  if (node.tagName === 'BR') return '\n';
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 1 && /^(DIV|P)$/.test(child.tagName) && text && !text.endsWith('\n')) text += '\n';
    text += sourceText(child);
  }
  return text;
}

export class NoteEditor {
  constructor(root, { onChange, onEditStart } = {}) {
    this.root = root;
    this.editor = root.querySelector('#notation');
    this.playhead = root.querySelector('.editor-playhead');
    this.onChange = onChange;
    this.onEditStart = onEditStart;
    this.source = '';
    this.activeRange = null;
    this.score = parseNotation('');
    this.chips = new Map();
    this.position = -1;
    this.undoStack = [];
    this.redoStack = [];
    this.lastEdit = null;
    this.composing = false;
    this.editor.addEventListener('beforeinput', event => this.beforeInput(event));
    this.editor.addEventListener('input', () => this.nativeInput());
    this.editor.addEventListener('keydown', event => this.keyDown(event));
    this.editor.addEventListener('pointerdown', event => this.pointerDown(event));
    this.editor.addEventListener('paste', event => this.paste(event));
    this.editor.addEventListener('copy', event => this.copy(event));
    this.editor.addEventListener('cut', event => this.copy(event, true));
    this.editor.addEventListener('drop', event => event.preventDefault());
    this.editor.addEventListener('blur', () => { if (!this.composing) this.commit(); });
    this.editor.addEventListener('compositionstart', () => {
      this.onEditStart?.();
      this.compositionBefore = this.snapshot();
      this.composing = true;
    });
    this.editor.addEventListener('compositionend', () => {
      this.composing = false;
      this.nativeInput(this.compositionBefore);
      this.compositionBefore = null;
    });
    this.root.addEventListener('scroll', () => this.setPosition(this.position), { passive: true });
    this.editor.addEventListener('scroll', () => this.setPosition(this.position), { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.resizeChips());
    this.resizeObserver.observe(this.editor);
    this.render();
  }

  getValue() { return this.source; }

  setValue(source) {
    this.source = String(source);
    this.activeRange = null;
    this.undoStack = [];
    this.redoStack = [];
    this.lastEdit = null;
    this.render();
  }

  commit() {
    if (this.composing) return;
    const selection = this.selection();
    this.activeRange = null;
    this.lastEdit = null;
    this.render(selection);
  }

  offsetAt(node, offset) {
    if (!node || !this.editor.contains(node) && node !== this.editor) return null;
    let total = 0;
    let current = node;
    const chip = (node.nodeType === 1 ? node : node.parentElement)?.closest('.note-chip, .note-line-break');
    if (chip && this.editor.contains(chip)) {
      current = chip;
      total = offset === 0 ? 0 : sourceLength(chip);
    } else if (node.nodeType === 3) total = Math.min(offset, node.data.length);
    else total = Array.from(node.childNodes).slice(0, offset).reduce((sum, child) => sum + sourceLength(child), 0);
    while (current !== this.editor) {
      for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) total += sourceLength(sibling);
      current = current.parentNode;
    }
    return total;
  }

  selection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const anchor = this.offsetAt(selection.anchorNode, selection.anchorOffset);
    const focus = this.offsetAt(selection.focusNode, selection.focusOffset);
    return anchor === null || focus === null ? null : { anchor, focus };
  }

  pointAt(offset) {
    let remaining = Math.max(0, Math.min(this.source.length, offset));
    const nodes = Array.from(this.editor.childNodes);
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      // An L owns the source character; its BR only moves the next caret to a new row.
      if (node.nodeType === 1 && node.hasAttribute('data-editor-line-break')) continue;
      const length = sourceLength(node);
      if (node.nodeType === 3 && remaining <= length) return { node, offset: remaining };
      if (remaining === 0) return { node: this.editor, offset: index };
      if (remaining < length) return { node: this.editor, offset: index + (remaining >= length / 2 ? 1 : 0) };
      remaining -= length;
    }
    return { node: this.editor, offset: Math.max(0, nodes.length - 1) };
  }

  restoreSelection(selection, focus = false) {
    if (!selection) return;
    if (!focus && document.activeElement !== this.editor) return;
    if (focus) this.editor.focus({ preventScroll: true });
    const anchor = this.pointAt(selection.anchor);
    const end = this.pointAt(selection.focus);
    window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, end.node, end.offset);
  }

  snapshot() {
    return { source: this.source, activeRange: this.activeRange && { ...this.activeRange }, selection: this.selection() ?? { anchor: this.source.length, focus: this.source.length } };
  }

  resizeChips() {
    const style = getComputedStyle(this.editor);
    const width = this.editor.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const pixelsPerBeat = editorBeatWidth(width);
    if (pixelsPerBeat !== this.pixelsPerBeat) {
      this.pixelsPerBeat = pixelsPerBeat;
      for (const [index, chip] of this.chips) {
        const chipWidth = noteGeometry(this.score.notes[index], pixelsPerBeat).width;
        chip.style.width = `${chipWidth}px`;
        chip.classList.toggle('compact', chipWidth < 48);
      }
    }
    this.setPosition(this.position);
  }

  render(selection = null) {
    const result = editorSegments(this.source, this.activeRange);
    this.score = result;
    this.editor.dataset.empty = String(this.source.length === 0);
    this.editor.classList.toggle('has-line-markers', result.segments.some(segment => segment.type === 'line-break'));
    this.root.classList.toggle('has-errors', result.errors.length > 0);
    this.chips.clear();
    const fragment = document.createDocumentFragment();
    for (const segment of result.segments) {
      if (segment.type === 'text') { fragment.append(document.createTextNode(segment.text)); continue; }
      if (segment.type === 'line-break') {
        const marker = document.createElement('span');
        marker.className = 'note-line-break';
        marker.contentEditable = 'false';
        marker.dataset.source = 'L';
        marker.dataset.sourceStart = String(segment.start);
        marker.dataset.sourceEnd = String(segment.end);
        marker.textContent = 'L';
        marker.title = 'End of line. Click to select and replace or delete L.';
        marker.setAttribute('aria-label', 'L: end of line');
        const lineBreak = document.createElement('br');
        lineBreak.dataset.editorLineBreak = '';
        fragment.append(marker, lineBreak);
        continue;
      }
      const note = segment.note;
      const chip = document.createElement('span');
      chip.className = `note-chip ${note.isRest ? 'rest' : note.draw ? 'draw' : 'blow'}`;
      chip.contentEditable = 'false';
      chip.dataset.source = segment.text;
      chip.dataset.sourceStart = String(segment.start);
      chip.dataset.sourceEnd = String(segment.end);
      chip.dataset.noteIndex = String(note.index);
      const colors = noteColors(note);
      chip.style.setProperty('--note-bg', colors.background);
      chip.style.setProperty('--note-fg', colors.foreground);
      chip.style.setProperty('--note-border', colors.border);
      const action = note.isRest ? 'Rest' : `${note.draw ? 'Draw' : 'Blow'} hole ${note.hole}${note.slider ? ', slider in' : ''}`;
      chip.title = `${action}, ${note.beats} quarter-note beat${note.beats === 1 ? '' : 's'}. Click to edit ${note.token}.`;
      chip.setAttribute('aria-label', `${note.token}: ${action}. Click to edit.`);
      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = note.token;
      chip.append(label);
      fragment.append(chip);
      this.chips.set(note.index, chip);
    }
    // A final zero-length line gives the caret a home after a trailing newline.
    const sentinel = document.createElement('br');
    sentinel.dataset.editorSentinel = '';
    fragment.append(sentinel);
    this.editor.replaceChildren(fragment);
    this.pixelsPerBeat = null;
    this.resizeChips();
    this.restoreSelection(selection);
    this.setPosition(this.position);
  }

  activeAt(caret) {
    const notes = parseNotation(this.source).notes;
    const note = notes.find(candidate => candidate.start < caret && candidate.end >= caret);
    return note ? { start: note.start, end: note.end } : null;
  }

  applyEdit(start, end, text, { finish = false, kind = '' } = {}) {
    this.onEditStart?.();
    const before = this.snapshot();
    const update = replaceNotation(this.source, start, end, text);
    const now = Date.now();
    const grouped = kind === 'typing' && this.lastEdit?.kind === kind && now - this.lastEdit.time < 1000
      && start === end && start === this.lastEdit.caret;
    if (!grouped) this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.source = update.source;
    this.activeRange = finish ? null : this.activeAt(update.caret);
    this.lastEdit = kind && !finish ? { kind, time: now, caret: update.caret } : null;
    this.render({ anchor: update.caret, focus: update.caret });
    this.onChange?.(this.source);
    this.revealCaret();
  }

  beforeInput(event) {
    if (this.composing || event.isComposing || !event.cancelable) return;
    const selection = this.selection();
    if (!selection) return;
    let start = Math.min(selection.anchor, selection.focus);
    let end = Math.max(selection.anchor, selection.focus);
    const type = event.inputType;
    if (type === 'historyUndo' || type === 'historyRedo') {
      event.preventDefault();
      this.history(type === 'historyUndo' ? -1 : 1);
      return;
    }
    if (type === 'insertParagraph' || type === 'insertLineBreak') {
      event.preventDefault();
      this.applyEdit(start, end, '\n', { finish: true });
      return;
    }
    if (type.startsWith('insert') && event.data !== null) {
      event.preventDefault();
      const finish = /[\s|L]/.test(event.data);
      this.applyEdit(start, end, event.data, { finish, kind: finish ? '' : 'typing' });
      return;
    }
    if (type.startsWith('delete')) {
      event.preventDefault();
      if (start === end) {
        const backward = /Backward$/.test(type);
        const chipNote = this.score.notes.find(note => this.chips.has(note.index) && (backward ? note.end === start : note.start === end));
        if (chipNote && !/Word|Line/.test(type)) {
          this.openNote(chipNote, backward ? chipNote.end : chipNote.start);
          return;
        }
        if (type === 'deleteWordBackward') start = this.wordBoundary(start, -1);
        else if (type === 'deleteWordForward') end = this.wordBoundary(end, 1);
        else if (/LineBackward$/.test(type)) start = Math.max(this.source.lastIndexOf('\n', start - 1), this.source.lastIndexOf('L', start - 1)) + 1;
        else if (/LineForward$/.test(type)) {
          const lineEnd = this.source.slice(end).search(/[\nL]/);
          end = lineEnd < 0 ? this.source.length : end + lineEnd;
        }
        else if (backward) start = Math.max(0, start - 1);
        else end = Math.min(this.source.length, end + 1);
      }
      if (start !== end) this.applyEdit(start, end, '');
      return;
    }
    // Keep rich formatting and browser-generated HTML out of plain notation.
    if (type.startsWith('format') || type.startsWith('insert')) event.preventDefault();
  }

  wordBoundary(offset, direction) {
    let cursor = offset;
    if (direction < 0) {
      while (cursor > 0 && /[\sL]/.test(this.source[cursor - 1])) cursor -= 1;
      while (cursor > 0 && !/[\sL]/.test(this.source[cursor - 1])) cursor -= 1;
    } else {
      while (cursor < this.source.length && /[\sL]/.test(this.source[cursor])) cursor += 1;
      while (cursor < this.source.length && !/[\sL]/.test(this.source[cursor])) cursor += 1;
    }
    return cursor;
  }

  keyDown(event) {
    if (event.isComposing) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z' || event.ctrlKey && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.history(event.shiftKey || event.key.toLowerCase() === 'y' ? 1 : -1);
    } else if (modifier && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.restoreSelection({ anchor: 0, focus: this.source.length });
      this.lastEdit = null;
    } else if (event.key === 'Tab') {
      // Tab commits a note and keeps the normal keyboard focus order.
      this.commit();
    } else if (event.key === 'Escape') {
      this.commit();
    } else if (/^(Arrow|Home|End)/.test(event.key)) {
      this.lastEdit = null;
    }
  }

  openNote(note, caret = note.end) {
    this.onEditStart?.();
    this.lastEdit = null;
    this.activeRange = { start: note.start, end: note.end };
    this.render();
    this.restoreSelection({ anchor: caret, focus: caret }, true);
    this.revealCaret();
  }

  pointerDown(event) {
    if (event.button !== 0) return;
    const marker = event.target.closest('.note-line-break');
    if (marker && !event.shiftKey) {
      event.preventDefault();
      this.onEditStart?.();
      this.lastEdit = null;
      this.activeRange = null;
      const selection = { anchor: Number(marker.dataset.sourceStart), focus: Number(marker.dataset.sourceEnd) };
      this.render();
      this.restoreSelection(selection, true);
      return;
    }
    const chip = event.target.closest('.note-chip');
    this.lastEdit = null;
    if (chip && !event.shiftKey) {
      event.preventDefault();
      this.openNote(this.score.notes[Number(chip.dataset.noteIndex)]);
    }
  }

  paste(event) {
    event.preventDefault();
    const selection = this.selection();
    if (!selection) return;
    this.applyEdit(Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus), event.clipboardData.getData('text/plain'), { finish: true });
  }

  copy(event, cut = false) {
    const selection = this.selection();
    if (!selection || selection.anchor === selection.focus) return;
    event.preventDefault();
    const start = Math.min(selection.anchor, selection.focus);
    const end = Math.max(selection.anchor, selection.focus);
    event.clipboardData.setData('text/plain', this.source.slice(start, end));
    if (cut) this.applyEdit(start, end, '', { finish: true });
  }

  nativeInput(before = null) {
    if (this.composing) return;
    const source = sourceText(this.editor);
    if (source === this.source) return;
    const previous = before ?? this.snapshot();
    const selection = this.selection() ?? { anchor: source.length, focus: source.length };
    this.onEditStart?.();
    this.undoStack.push(previous);
    this.redoStack = [];
    this.source = source;
    this.activeRange = this.activeAt(selection.focus);
    this.lastEdit = null;
    this.render(selection);
    this.onChange?.(this.source);
    this.revealCaret();
  }

  history(direction) {
    const from = direction < 0 ? this.undoStack : this.redoStack;
    const to = direction < 0 ? this.redoStack : this.undoStack;
    if (!from.length) return;
    this.onEditStart?.();
    to.push(this.snapshot());
    const snapshot = from.pop();
    this.source = snapshot.source;
    this.activeRange = snapshot.activeRange;
    this.lastEdit = null;
    this.render(snapshot.selection);
    this.onChange?.(this.source);
    this.revealCaret();
  }

  revealCaret() {
    if (document.activeElement !== this.editor) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    let rect = Array.from(range.getClientRects()).find(candidate => candidate.height > 0);
    if (!rect && selection.focusNode === this.editor) {
      const next = this.editor.childNodes[selection.focusOffset];
      const previous = this.editor.childNodes[selection.focusOffset - 1];
      if (next?.nodeType === 1) rect = next.getBoundingClientRect();
      else if (previous?.nodeType === 1) {
        const previousRect = previous.getBoundingClientRect();
        rect = { left: previousRect.right, top: previousRect.top, bottom: previousRect.bottom, height: previousRect.height };
      }
    }
    if (!rect || !rect.height) return;
    const viewport = this.root.getBoundingClientRect();
    if (rect.left < viewport.left + 12) this.root.scrollLeft -= viewport.left + 12 - rect.left;
    else if (rect.left > viewport.right - 12) this.root.scrollLeft += rect.left - viewport.right + 12;
    if (rect.top < viewport.top + 12) this.root.scrollTop -= viewport.top + 12 - rect.top;
    else if (rect.bottom > viewport.bottom - 12) this.root.scrollTop += rect.bottom - viewport.bottom + 12;
  }

  noteRect(note, fraction) {
    const chip = this.chips.get(note.index);
    if (chip) {
      const rect = chip.getBoundingClientRect();
      return { left: rect.left + rect.width * fraction, top: rect.top, height: rect.height };
    }
    const start = this.pointAt(note.start);
    const end = this.pointAt(note.end);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const rectangles = Array.from(range.getClientRects()).filter(rect => rect.width > 0);
    let remaining = rectangles.reduce((sum, rect) => sum + rect.width, 0) * fraction;
    for (let index = 0; index < rectangles.length; index += 1) {
      const rect = rectangles[index];
      if (remaining <= rect.width || index === rectangles.length - 1) return { left: rect.left + Math.min(rect.width, remaining), top: rect.top, height: rect.height };
      remaining -= rect.width;
    }
    return null;
  }

  setPosition(beat, { follow = false } = {}) {
    this.position = beat;
    const valid = this.score.notes.length > 0 && this.score.errors.length === 0 && Number.isFinite(beat) && beat >= 0;
    const current = valid ? this.score.notes.find(note => beat >= note.startBeat && beat < note.endBeat) : null;
    for (const [index, chip] of this.chips) {
      const active = current?.index === index;
      chip.classList.toggle('active', active);
      if (active) chip.setAttribute('aria-current', 'true');
      else chip.removeAttribute('aria-current');
    }
    this.playhead.hidden = !valid;
    if (!valid) return;
    const note = current ?? this.score.notes.at(-1);
    const fraction = Math.max(0, Math.min(1, (beat - note.startBeat) / note.beats));
    let rect = this.noteRect(note, fraction);
    if (!rect) { this.playhead.hidden = true; return; }
    if (follow && document.activeElement !== this.editor) {
      const viewport = this.root.getBoundingClientRect();
      const inset = Math.min(32, viewport.width * 0.1);
      if (rect.left < viewport.left + inset) this.root.scrollLeft -= viewport.left + inset - rect.left;
      else if (rect.left > viewport.right - inset) this.root.scrollLeft += rect.left - viewport.right + inset;
      if (rect.top < viewport.top + 12) this.root.scrollTop -= viewport.top + 12 - rect.top;
      else if (rect.top + rect.height > viewport.bottom - 12) this.root.scrollTop += rect.top + rect.height - viewport.bottom + 12;
      rect = this.noteRect(note, fraction);
    }
    const rootRect = this.root.getBoundingClientRect();
    const left = rect.left - rootRect.left + this.root.scrollLeft - this.root.clientLeft;
    const top = rect.top - rootRect.top + this.root.scrollTop - this.root.clientTop;
    this.playhead.style.transform = `translate(${left}px, ${top}px)`;
    this.playhead.style.height = `${rect.height}px`;
  }
}
