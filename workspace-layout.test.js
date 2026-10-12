import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMN_GAP, DEFAULT_PANEL_IDS, LAYOUT_STORAGE_KEY, MAX_PANEL_HEIGHT, MIN_COLUMN_WIDTH, MIN_PANEL_HEIGHT,
  clampColumnRatio, clampPanelHeight, effectiveColumns, groupPanels, layoutRowHeight,
  normalizeLayoutSettings, readLayoutSettings, withRowHeight,
} from './workspace-layout.js';

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} should equal ${expected}`);

test('new layouts use one centered column and automatic panel heights', () => {
  assert.deepEqual(normalizeLayoutSettings(), {
    columns: 1, width: 'centered', split: 0.5, panelHeights: {}, rowHeights: {},
  });
  for (const value of [null, [], 'full', false, NaN]) assert.deepEqual(normalizeLayoutSettings(value), normalizeLayoutSettings());
});

test('stored settings retain supported values and discard unknown or malformed heights', () => {
  const row = DEFAULT_PANEL_IDS.slice(0, 2).join(':');
  const input = {
    columns: 2, width: 'full', split: 0.64,
    panelHeights: { 'visualization-panel': 470.4, 'waveforms-panel': -1, 'score-panel': '600', 'sheet-card': Infinity, unknown: 500 },
    rowHeights: { [row]: 620, 'score-panel:sheet-card': 4000, 'waveforms-panel:score-panel': 700 },
    unrelated: true,
  };
  assert.deepEqual(normalizeLayoutSettings(input), {
    columns: 2, width: 'full', split: 0.64,
    panelHeights: { 'visualization-panel': 470 },
    rowHeights: { [row]: 620, 'score-panel:sheet-card': MAX_PANEL_HEIGHT },
  });
  assert.equal(input.panelHeights['visualization-panel'], 470.4);
  assert.deepEqual(normalizeLayoutSettings({ columns: '2', width: 'wide', split: Infinity }), normalizeLayoutSettings());
});

test('missing, malformed, or blocked browser storage falls back without breaking layout', () => {
  const expected = normalizeLayoutSettings();
  for (const value of [null, '', '{broken', 'null', '[]']) {
    assert.deepEqual(readLayoutSettings({ getItem: () => value }), expected);
  }
  assert.deepEqual(readLayoutSettings(null), expected);
  assert.deepEqual(readLayoutSettings({ getItem() { throw new Error('Storage disabled'); } }), expected);
  let key;
  const restored = readLayoutSettings({ getItem(value) { key = value; return JSON.stringify({ columns: 2, width: 'full', split: 0.6 }); } });
  assert.equal(key, LAYOUT_STORAGE_KEY);
  assert.equal(restored.columns, 2);
  assert.equal(restored.width, 'full');
  assert.equal(restored.split, 0.6);
});

test('only explicit saved height properties are accepted', () => {
  const panelHeights = Object.create({ 'score-panel': 800 });
  panelHeights['sheet-card'] = 500;
  assert.deepEqual(normalizeLayoutSettings({ panelHeights }).panelHeights, { 'sheet-card': 500 });
});

test('panel pairing keeps the page order in both column modes and supports a final unpaired panel', () => {
  assert.deepEqual(groupPanels(DEFAULT_PANEL_IDS, 1), DEFAULT_PANEL_IDS.map(id => [id]));
  assert.deepEqual(groupPanels(DEFAULT_PANEL_IDS, 2), [DEFAULT_PANEL_IDS.slice(0, 2), DEFAULT_PANEL_IDS.slice(2)]);
  assert.deepEqual(groupPanels(['a', 'b', 'c'], 2), [['a', 'b'], ['c']]);
  assert.deepEqual(groupPanels([], 2), []);
  assert.deepEqual(groupPanels(['a', 'b'], 8), [['a'], ['b']]);
});

test('two columns fall back only when the available workspace is too narrow', () => {
  for (const width of [0, 390, 699, NaN, Infinity]) assert.equal(effectiveColumns(2, width), 1);
  assert.equal(effectiveColumns(2, 700), 2);
  assert.equal(effectiveColumns(2, 1440), 2);
  assert.equal(effectiveColumns(1, 1440), 1);
});

test('responsive fallback preserves the chosen two-column mode and its row heights', () => {
  const row = DEFAULT_PANEL_IDS.slice(0, 2);
  let settings = normalizeLayoutSettings({ columns: 2, width: 'full' });
  settings = withRowHeight(settings, row, 2, 650);
  settings = withRowHeight(settings, [row[0]], 1, 350);
  assert.equal(layoutRowHeight(settings, row, effectiveColumns(settings.columns, 900)), 650);
  assert.equal(layoutRowHeight(settings, [row[0]], effectiveColumns(settings.columns, 390)), 350);
  assert.equal(layoutRowHeight(settings, row, effectiveColumns(settings.columns, 900)), 650);
  assert.equal(settings.columns, 2);
});

test('panel and shared row heights remain separate across mode changes', () => {
  const row = DEFAULT_PANEL_IDS.slice(0, 2);
  const original = normalizeLayoutSettings();
  let settings = withRowHeight(original, [row[0]], 1, 450);
  settings = withRowHeight(settings, [row[1]], 1, 370);
  settings = withRowHeight(settings, row, 2, 680);
  assert.equal(layoutRowHeight(settings, [row[0]], 1), 450);
  assert.equal(layoutRowHeight(settings, [row[1]], 1), 370);
  assert.equal(layoutRowHeight(settings, row, 2), 680);
  assert.equal(layoutRowHeight(settings, ['score-panel'], 1), null);
  assert.deepEqual(original.panelHeights, {});
  const restored = normalizeLayoutSettings(JSON.parse(JSON.stringify(settings)));
  assert.deepEqual(restored, settings);
});

test('resetting one row restores automatic height without clearing another mode', () => {
  const row = DEFAULT_PANEL_IDS.slice(0, 2);
  let settings = withRowHeight(normalizeLayoutSettings(), [row[0]], 1, 450);
  settings = withRowHeight(settings, row, 2, 680);
  const reset = withRowHeight(settings, row, 2, null);
  assert.equal(layoutRowHeight(reset, row, 2), null);
  assert.equal(layoutRowHeight(reset, [row[0]], 1), 450);
  assert.equal(layoutRowHeight(settings, row, 2), 680);
  assert.equal(layoutRowHeight(withRowHeight(reset, [row[0]], 1, null), [row[0]], 1), null);
});

test('height constraints handle both drag extremes without storing fractions', () => {
  assert.equal(clampPanelHeight(-9999), MIN_PANEL_HEIGHT);
  assert.equal(clampPanelHeight(9999), MAX_PANEL_HEIGHT);
  assert.equal(clampPanelHeight(482.6), 483);
  assert.equal(clampPanelHeight(NaN), MIN_PANEL_HEIGHT);
  assert.equal(clampPanelHeight(Infinity), MIN_PANEL_HEIGHT);
});

test('column proportions stay between 30 and 70 percent on wide workspaces', () => {
  closeTo(clampColumnRatio(-2, 1500), 0.3);
  closeTo(clampColumnRatio(2, 1500), 0.7);
  closeTo(clampColumnRatio(0.6, 1500), 0.6);
  closeTo(clampColumnRatio(NaN, 1500), 0.5);
  closeTo(clampColumnRatio(Infinity), 0.5);
});

test('the column divider leaves each panel at least 320 pixels as the workspace narrows', () => {
  for (const width of [700, 800, 1000, 1200, 1440, 2000]) {
    for (const desired of [0, 0.3, 0.5, 0.7, 1]) {
      const ratio = clampColumnRatio(desired, width);
      const available = width - COLUMN_GAP;
      assert.ok(available * ratio >= MIN_COLUMN_WIDTH - 1e-9);
      assert.ok(available * (1 - ratio) >= MIN_COLUMN_WIDTH - 1e-9);
      assert.ok(ratio >= 0.3 && ratio <= 0.7);
    }
  }
  closeTo(clampColumnRatio(0.3, 700), 320 / 680);
  closeTo(clampColumnRatio(0.7, 700), 360 / 680);
  closeTo(clampColumnRatio(0.7, 0), 0.5);
});

test('a temporary width constraint does not overwrite the preferred divider position', () => {
  const settings = normalizeLayoutSettings({ columns: 2, split: 0.68 });
  assert.ok(clampColumnRatio(settings.split, 700) < 0.68);
  closeTo(clampColumnRatio(settings.split, 1500), 0.68);
  assert.equal(settings.split, 0.68);
});
