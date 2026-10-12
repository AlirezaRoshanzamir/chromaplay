export const LAYOUT_STORAGE_KEY = 'chromaplay.layout.v1';
export const MIN_PANEL_HEIGHT = 200;
export const MAX_PANEL_HEIGHT = 1600;
export const MIN_COLUMN_WIDTH = 320;
export const COLUMN_GAP = 20;
export const TWO_COLUMN_MIN_WIDTH = 700;
export const DEFAULT_PANEL_IDS = ['visualization-panel', 'waveforms-panel', 'score-panel', 'sheet-card'];

const finiteNumber = value => typeof value === 'number' && Number.isFinite(value);
const rowKey = ids => ids.join(':');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function clampPanelHeight(value) {
  return Math.round(Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, finiteNumber(value) ? value : MIN_PANEL_HEIGHT)));
}

export function clampColumnRatio(value, width = Infinity) {
  const ratio = finiteNumber(value) ? value : 0.5;
  const available = finiteNumber(width) ? Math.max(0, width - COLUMN_GAP) : Infinity;
  const minimum = available > 0 ? Math.min(0.5, Math.max(0.3, MIN_COLUMN_WIDTH / available)) : 0.5;
  return Math.max(minimum, Math.min(1 - minimum, ratio));
}

export function groupPanels(ids, columns) {
  const size = columns === 2 ? 2 : 1;
  return Array.from({ length: Math.ceil(ids.length / size) }, (_, index) => ids.slice(index * size, (index + 1) * size));
}

export function effectiveColumns(preferredColumns, width) {
  return preferredColumns === 2 && finiteNumber(width) && width >= TWO_COLUMN_MIN_WIDTH ? 2 : 1;
}

export function normalizeLayoutSettings(value, panelIds = DEFAULT_PANEL_IDS) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const columns = input.columns === 2 ? 2 : 1;
  const heights = (record, keys) => Object.fromEntries(keys.flatMap(key => (
    record && typeof record === 'object' && own(record, key) && finiteNumber(record[key]) && record[key] > 0
      ? [[key, clampPanelHeight(record[key])]] : []
  )));
  return {
    columns,
    width: ['full', 'centered'].includes(input.width) ? input.width : columns === 2 ? 'full' : 'centered',
    split: clampColumnRatio(input.split),
    panelHeights: heights(input.panelHeights, panelIds),
    rowHeights: heights(input.rowHeights, groupPanels(panelIds, 2).map(rowKey)),
  };
}

export function readLayoutSettings(storage, panelIds = DEFAULT_PANEL_IDS) {
  try { return normalizeLayoutSettings(JSON.parse(storage?.getItem(LAYOUT_STORAGE_KEY) ?? 'null'), panelIds); }
  catch { return normalizeLayoutSettings(null, panelIds); }
}

export function layoutRowHeight(settings, ids, columns) {
  return (columns === 2 ? settings.rowHeights[rowKey(ids)] : settings.panelHeights[ids[0]]) ?? null;
}

export function withRowHeight(settings, ids, columns, height) {
  const field = columns === 2 ? 'rowHeights' : 'panelHeights';
  const key = columns === 2 ? rowKey(ids) : ids[0];
  const result = { ...settings, [field]: { ...settings[field] } };
  if (height === null) delete result[field][key];
  else result[field][key] = clampPanelHeight(height);
  return result;
}

export class WorkspaceLayout {
  constructor({ workspace, panels, columnsControl, widthControl, resetControl, hint, storage, captureSelection, restoreSelection } = {}) {
    if (!workspace) throw new Error('WorkspaceLayout needs a workspace element.');
    this.workspace = workspace;
    this.document = workspace.ownerDocument;
    this.window = this.document.defaultView;
    const find = id => this.document.getElementById(id);
    this.panels = panels ?? DEFAULT_PANEL_IDS.map(find).filter(Boolean);
    this.panelIds = this.panels.map(panel => panel.id);
    this.columnsControl = columnsControl ?? find('layout-columns');
    this.widthControl = widthControl ?? find('layout-width');
    this.resetControl = resetControl ?? find('layout-reset');
    this.hint = hint ?? find('layout-hint');
    this.captureSelection = captureSelection;
    this.restoreSelection = restoreSelection;
    try { this.storage = storage === undefined ? this.window.localStorage : storage; }
    catch { this.storage = null; }
    this.settings = readLayoutSettings(this.storage, this.panelIds);
    this.rows = [];
    this.cleanups = [];
    this.rowCleanups = [];
    this.drag = null;
    this.columns = null;
    this.pendingFrame = null;
    this.divider = this.document.createElement('div');
    this.divider.id = 'column-divider';
    this.divider.className = 'column-divider';
    this.divider.setAttribute('role', 'separator');
    this.divider.setAttribute('aria-orientation', 'vertical');
    this.divider.setAttribute('aria-label', 'Resize columns');
    this.divider.setAttribute('aria-controls', this.panelIds.join(' '));
    this.divider.tabIndex = 0;
    this.divider.title = 'Drag to resize columns. Use Left or Right, or Home to reset.';
    this.divider.append(this.document.createElement('span'));
    this.workspace.append(this.divider);
    this._listen(this.columnsControl, 'change', () => this._setPreference('columns', Number(this.columnsControl.value)));
    this._listen(this.widthControl, 'change', () => this._setPreference('width', this.widthControl.value));
    this._listen(this.resetControl, 'click', () => this.reset());
    this._listen(this.divider, 'pointerdown', event => this._startDrag(event, 'column'));
    this._listen(this.divider, 'keydown', event => this._columnKey(event));
    this._listen(this.divider, 'dblclick', () => this._setSplit(0.5, true));
    this._listen(this.window, 'blur', () => this._finishDrag(false));
    this._listen(this.window, 'resize', () => this._render());
    this.resizeObserver = new this.window.ResizeObserver(() => this._render());
    this.resizeObserver.observe(workspace);
    this.collapseObserver = new this.window.MutationObserver(() => {
      this._applyHeights();
      this._emit();
    });
    for (const panel of this.panels) this.collapseObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });
    this._render();
  }

  _listen(element, type, listener, list = this.cleanups) {
    if (!element) return;
    element.addEventListener(type, listener);
    list.push(() => element.removeEventListener(type, listener));
  }

  _save() {
    try { this.storage?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(this.settings)); }
    catch { /* Layout controls still work when browser storage is unavailable. */ }
  }

  _emit() {
    if (this.pendingFrame !== null) return;
    this.pendingFrame = this.window.requestAnimationFrame(() => {
      this.pendingFrame = null;
      this.workspace.dispatchEvent(new this.window.CustomEvent('workspace-layout-change', { bubbles: true }));
    });
  }

  _setPreference(key, value) {
    this._finishDrag(false);
    const settings = { ...this.settings, [key]: value };
    if (key === 'columns') settings.width = value === 2 ? 'full' : 'centered';
    this.settings = normalizeLayoutSettings(settings, this.panelIds);
    this._save();
    this._render();
  }

  _render() {
    this.document.documentElement.dataset.layoutWidth = this.settings.width;
    const width = this.workspace.getBoundingClientRect().width;
    const columns = effectiveColumns(this.settings.columns, width);
    const changed = columns !== this.columns;
    if (changed) {
      this._finishDrag(false);
      this.columns = columns;
      this.workspace.dataset.columns = String(columns);
      this._buildRows();
    }
    const ratio = clampColumnRatio(this.settings.split, width);
    const leftWidth = Math.max(0, width - COLUMN_GAP) * ratio;
    const geometryChanged = this.lastWidth !== width || this.lastRatio !== ratio;
    if (geometryChanged) {
      this.workspace.style.setProperty('--column-ratio', String(ratio));
      this.workspace.style.setProperty('--left-column-width', `${leftWidth}px`);
      this.lastWidth = width;
      this.lastRatio = ratio;
    }
    this.divider.hidden = columns !== 2;
    const minRatio = clampColumnRatio(0, width);
    this.divider.setAttribute('aria-valuemin', String(Math.round(minRatio * 100)));
    this.divider.setAttribute('aria-valuemax', String(Math.round((1 - minRatio) * 100)));
    this.divider.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    this.divider.setAttribute('aria-valuetext', `${Math.round(ratio * 100)}% left, ${Math.round((1 - ratio) * 100)}% right`);
    if (this.columnsControl) this.columnsControl.value = String(this.settings.columns);
    if (this.widthControl) this.widthControl.value = this.settings.width;
    if (this.hint) this.hint.textContent = this.settings.columns === 2 && columns === 1
      ? 'Two columns resume on a wider screen.'
      : columns === 2 ? 'Drag below a row to resize its panels. Drag the divider to adjust columns.'
        : 'Drag below a panel to change its height.';
    this._applyHeights();
    if (changed || geometryChanged) this._emit();
  }

  _buildRows() {
    for (const cleanup of this.rowCleanups.splice(0)) cleanup();
    const editorSelection = this.captureSelection?.();
    const active = this.document.activeElement;
    const restoreFocus = this.panels.some(panel => panel.contains(active));
    const selection = restoreFocus && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    const documentSelection = this.document.getSelection?.();
    let contentSelection = null;
    if (documentSelection?.rangeCount && this.workspace.contains(documentSelection.anchorNode)
      && this.workspace.contains(documentSelection.focusNode)) {
      const range = documentSelection.getRangeAt(0).cloneRange();
      // Live ranges move their endpoints when panels are reparented.
      contentSelection = {
        range, startNode: range.startContainer, startOffset: range.startOffset,
        endNode: range.endContainer, endOffset: range.endOffset,
        anchorNode: documentSelection.anchorNode, anchorOffset: documentSelection.anchorOffset,
        focusNode: documentSelection.focusNode, focusOffset: documentSelection.focusOffset,
      };
    }
    const oldRows = this.rows;
    this.rows = groupPanels(this.panels, this.columns).map((panels, index) => {
      const element = this.document.createElement('div');
      element.className = 'workspace-row';
      element.dataset.row = String(index);
      const ids = panels.map(panel => panel.id);
      element.dataset.rowKey = rowKey(ids);
      const handle = this.document.createElement('div');
      handle.className = 'row-resize';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'horizontal');
      const names = panels.map(panel => this.document.getElementById(panel.getAttribute('aria-labelledby'))?.textContent.trim() || panel.id);
      handle.setAttribute('aria-label', `Resize ${names.join(' and ')}`);
      handle.setAttribute('aria-controls', ids.join(' '));
      handle.setAttribute('aria-valuemin', String(MIN_PANEL_HEIGHT));
      handle.setAttribute('aria-valuemax', String(MAX_PANEL_HEIGHT));
      handle.tabIndex = 0;
      handle.title = 'Drag to change height. Use Up or Down, or Home to reset.';
      handle.append(this.document.createElement('span'));
      const row = { element, panels, ids, handle };
      this._listen(handle, 'pointerdown', event => this._startDrag(event, 'row', row), this.rowCleanups);
      this._listen(handle, 'keydown', event => this._rowKey(event, row), this.rowCleanups);
      this._listen(handle, 'dblclick', () => this._setHeight(row, null, true), this.rowCleanups);
      element.append(...panels, handle);
      this.workspace.insertBefore(element, this.divider);
      return row;
    });
    for (const row of oldRows) row.element.remove();
    if (restoreFocus && active.isConnected) {
      active.focus({ preventScroll: true });
      if (selection) active.setSelectionRange(...selection);
    }
    if (contentSelection && this.workspace.contains(contentSelection.startNode)
      && this.workspace.contains(contentSelection.endNode)) {
      const saved = contentSelection;
      const currentSelection = this.document.getSelection?.();
      try {
        saved.range.setStart(saved.startNode, saved.startOffset);
        saved.range.setEnd(saved.endNode, saved.endOffset);
        if (currentSelection?.setBaseAndExtent) {
          currentSelection.setBaseAndExtent(saved.anchorNode, saved.anchorOffset, saved.focusNode, saved.focusOffset);
        } else if (currentSelection) {
          currentSelection.removeAllRanges();
          currentSelection.addRange(saved.range);
        }
      } catch { /* Selection may have been replaced by an editor's focus handler. */ }
    }
    if (editorSelection != null) this.restoreSelection?.(editorSelection);
  }

  _rowHeight(row) {
    return Math.max(...row.panels.map(panel => panel.getBoundingClientRect().height), MIN_PANEL_HEIGHT);
  }

  _applyHeights() {
    for (const row of this.rows) {
      const collapsed = row.panels.every(panel => panel.classList.contains('is-collapsed'));
      const height = layoutRowHeight(this.settings, row.ids, this.columns);
      row.element.dataset.allCollapsed = String(collapsed);
      row.element.dataset.resized = String(!collapsed && height !== null);
      if (!collapsed && height !== null) row.element.style.setProperty('--row-height', `${height}px`);
      else row.element.style.removeProperty('--row-height');
      row.handle.hidden = collapsed;
      row.handle.setAttribute('aria-disabled', String(collapsed));
      row.handle.setAttribute('aria-valuenow', String(clampPanelHeight(height ?? this._rowHeight(row))));
      row.handle.setAttribute('aria-valuetext', height === null ? 'Automatic height' : `${height} pixels`);
    }
  }

  _setHeight(row, height, save = false) {
    this.settings = withRowHeight(this.settings, row.ids, this.columns, height);
    this._applyHeights();
    if (save) this._save();
    this._emit();
  }

  _setSplit(ratio, save = false) {
    this.settings = { ...this.settings, split: clampColumnRatio(ratio, this.workspace.getBoundingClientRect().width) };
    this._render();
    if (save) this._save();
  }

  _rowKey(event, row) {
    if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') this._setHeight(row, null, true);
    else {
      const height = layoutRowHeight(this.settings, row.ids, this.columns) ?? this._rowHeight(row);
      this._setHeight(row, height + (event.key === 'ArrowUp' ? -1 : 1) * (event.shiftKey ? 60 : 20), true);
    }
  }

  _columnKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    const ratio = clampColumnRatio(this.settings.split, this.workspace.getBoundingClientRect().width);
    this._setSplit(event.key === 'Home' ? 0.5 : ratio + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 0.1 : 0.02), true);
  }

  _startDrag(event, type, row = null) {
    if (event.button !== 0 || this.drag || (row && row.handle.hidden) || (type === 'column' && this.divider.hidden)) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.focus({ preventScroll: true });
    const drag = {
      type, row, handle, pointerId: event.pointerId,
      startY: event.clientY, height: row ? this._rowHeight(row) : null,
      initial: this.settings, cleanups: [],
    };
    this.drag = drag;
    this.workspace.dataset.dragging = type;
    this._listen(handle, 'pointermove', move => {
      if (move.pointerId !== drag.pointerId) return;
      if (type === 'row') this._setHeight(row, drag.height + move.clientY - drag.startY);
      else {
        const rect = this.workspace.getBoundingClientRect();
        this._setSplit((move.clientX - rect.left - COLUMN_GAP / 2) / Math.max(1, rect.width - COLUMN_GAP));
      }
    }, drag.cleanups);
    this._listen(handle, 'pointerup', end => { if (end.pointerId === drag.pointerId) this._finishDrag(false); }, drag.cleanups);
    this._listen(handle, 'pointercancel', end => { if (end.pointerId === drag.pointerId) this._finishDrag(true); }, drag.cleanups);
    this._listen(handle, 'lostpointercapture', () => this._finishDrag(false), drag.cleanups);
    try { handle.setPointerCapture(event.pointerId); } catch { this._finishDrag(true); }
  }

  _finishDrag(cancel) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    for (const cleanup of drag.cleanups) cleanup();
    delete this.workspace.dataset.dragging;
    try { if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId); } catch { /* The browser may have already released capture. */ }
    if (cancel) {
      this.settings = drag.initial;
      this._render();
      this._emit();
    } else this._save();
  }

  reset() {
    this._finishDrag(false);
    this.settings = normalizeLayoutSettings(null, this.panelIds);
    this._save();
    this._render();
    this._emit();
  }

  destroy() {
    this._finishDrag(false);
    this.resizeObserver.disconnect();
    this.collapseObserver.disconnect();
    for (const cleanup of [...this.cleanups, ...this.rowCleanups]) cleanup();
    if (this.pendingFrame !== null) this.window.cancelAnimationFrame(this.pendingFrame);
  }
}
