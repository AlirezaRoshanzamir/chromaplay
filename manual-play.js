import { pitchFor } from './notation.js';

const MIN_TAP_MS = 220;
const HOLE_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

function holeForKey(code) {
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1] === '0' ? 10 : Number(digit[1]);
  return code === 'Minus' ? 11 : code === 'Equal' ? 12 : null;
}

/** Mouse/touch instrument with held keyboard modifiers and optional toggles. */
export class ManualHarmonica {
  constructor(root, { audio, drawButton, sliderButton, onStart, onChange, onError, isBlocked }) {
    Object.assign(this, { root, audio, drawButton, sliderButton, onStart, onChange, onError, isBlocked });
    this.held = new Set();
    this.latched = { draw: false, slider: false };
    this.note = null;
    this.pointerId = null;
    this.heldNotes = new Map();
    this.request = 0;
    this.releaseTimer = null;
    root.addEventListener('pointerdown', event => {
      const button = event.target.closest('[data-hole]');
      if (!button || event.button !== 0 || !event.isPrimary || this.pointerId !== null) return;
      event.preventDefault();
      button.focus({ preventScroll: true });
      button.setPointerCapture(event.pointerId);
      this.pointerId = event.pointerId;
      this.heldNotes.clear();
      this.start(Number(button.dataset.hole));
    });
    root.addEventListener('pointerup', event => {
      if (event.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.release();
    });
    for (const name of ['pointercancel', 'lostpointercapture']) {
      root.addEventListener(name, event => {
        if (event.pointerId === this.pointerId) this.stop();
      });
    }
    // Assistive technology can activate buttons without pointer or key events.
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-hole]');
      if (button && event.detail === 0 && !this.heldNotes.size) {
        this.start(Number(button.dataset.hole));
        this.release();
      }
    });
    for (const [name, button] of [['draw', drawButton], ['slider', sliderButton]]) {
      button.addEventListener('click', () => {
        this.latched[name] = !this.latched[name];
        this.updateModes();
      });
    }
    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || this.blocked(event.target)) return;
      const mode = this.modeForKey(event.code);
      if (mode) {
        event.preventDefault();
        if (!this.held.has(event.code)) { this.held.add(event.code); this.updateModes(); }
        return;
      }
      const button = event.target.closest('[data-hole]');
      const hole = holeForKey(event.code) ?? (button && event.code === 'Enter' ? Number(button.dataset.hole) : null);
      if (hole) {
        event.preventDefault();
        if (!event.repeat && !this.heldNotes.has(event.code)) {
          this.pointerId = null;
          this.heldNotes.set(event.code, hole);
          this.start(hole);
        }
      }
    });
    document.addEventListener('keyup', event => {
      const mode = this.modeForKey(event.code);
      if (mode && this.held.delete(event.code)) { event.preventDefault(); this.updateModes(); }
      const lastKey = [...this.heldNotes.keys()].at(-1);
      if (this.heldNotes.delete(event.code)) {
        event.preventDefault();
        if (event.code !== lastKey) return;
        const previousHole = [...this.heldNotes.values()].at(-1);
        if (previousHole) this.start(previousHole);
        else this.release();
      }
    });
    document.addEventListener('focusin', event => {
      if (this.blocked(event.target)) this.resetHeld();
    });
    window.addEventListener('blur', () => this.resetHeld());
    window.addEventListener('pagehide', () => this.resetHeld());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.resetHeld(); });
    this.updateModes();
  }

  blocked(target) {
    return this.isBlocked?.() || target.closest('input, textarea, select, [role="textbox"], [role="slider"], [contenteditable]:not([contenteditable="false"]), dialog');
  }

  modeForKey(code) { return ['KeyD', 'Space'].includes(code) ? 'draw' : ['KeyS', 'ArrowLeft'].includes(code) ? 'slider' : null; }
  mode(name) { return this.latched[name] || [...this.held].some(code => this.modeForKey(code) === name); }

  updateModes() {
    const draw = this.mode('draw'), slider = this.mode('slider');
    this.drawButton.setAttribute('aria-pressed', String(draw));
    this.sliderButton.setAttribute('aria-pressed', String(slider));
    for (const button of this.root.querySelectorAll('[data-hole]')) {
      const hole = Number(button.dataset.hole);
      const { pitch } = pitchFor(hole, draw, slider);
      button.querySelector('small').textContent = pitch.replace(/\d/, '');
      button.setAttribute('aria-label', `Play hole ${hole}: ${draw ? 'draw' : 'blow'}${slider ? ', slider in' : ''}, ${pitch}`);
      button.setAttribute('aria-keyshortcuts', HOLE_KEYS[hole - 1]);
      button.title = `${draw ? 'Draw' : 'Blow'} hole ${hole}${slider ? ' with slider' : ''} (${pitch}). Click or hold key ${HOLE_KEYS[hole - 1]} to play.`;
    }
    if (this.note && (draw !== this.note.draw || slider !== this.note.slider)) this.sound(this.note.hole);
  }

  start(hole) {
    clearTimeout(this.releaseTimer);
    this.onStart?.();
    this.startedAt = performance.now();
    this.sound(hole);
  }

  async sound(hole) {
    const request = ++this.request;
    const draw = this.mode('draw'), slider = this.mode('slider');
    this.note = { hole, draw, slider, isRest: false, ...pitchFor(hole, draw, slider), token: `${draw ? '-' : ''}${hole}${slider ? '#' : ''}` };
    this.onChange?.(this.note);
    try {
      await this.audio.startManualNote(this.note.midi);
    } catch (error) {
      if (request !== this.request) return;
      this.stop();
      this.onError?.(error);
    }
  }

  release() {
    clearTimeout(this.releaseTimer);
    const remaining = Math.max(0, MIN_TAP_MS - (performance.now() - this.startedAt));
    if (remaining) this.releaseTimer = setTimeout(() => this.stop(), remaining);
    else this.stop();
  }

  stop() {
    clearTimeout(this.releaseTimer);
    this.request++;
    this.pointerId = null;
    this.heldNotes.clear();
    this.audio.stopManualNote();
    if (this.note) { this.note = null; this.onChange?.(null); }
  }

  resetHeld() {
    this.stop();
    this.held.clear();
    this.updateModes();
  }
}
