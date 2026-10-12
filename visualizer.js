const COLORS = {
  background: '#121b1a',
  grid: '#25322f',
  measure: '#3a4b44',
  muted: '#789187',
  blow: '#b4edb1',
  draw: '#eab09a',
  line: '#c5efba',
};

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** A time-based, twelve-lane score preview. All beat values are quarter notes. */
export class HarmonicaVisualizer {
  constructor(canvas, { onSeek } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = typeof onSeek === 'function' ? onSeek : null;
    this.notes = [];
    this.noteEndBounds = [];
    this.beat = 0;
    this.beatsPerBar = 4;
    this.visibleBeats = 8;
    this.activeNote = null;
    this.hitAreas = [];
    this.width = 0;
    this.height = 0;
    this.destroyed = false;

    this.handleClick = (event) => {
      const hit = this.hitTest(event);
      if (hit && this.onSeek) this.onSeek(hit.startBeat);
    };
    this.handlePointerMove = (event) => {
      this.canvas.style.cursor = this.onSeek && this.hitTest(event) ? 'pointer' : 'default';
    };
    this.handlePointerLeave = () => { this.canvas.style.cursor = 'default'; };
    this.handleResize = () => this.resize();

    canvas.addEventListener('click', this.handleClick);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerleave', this.handlePointerLeave);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(canvas);
    } else {
      window.addEventListener('resize', this.handleResize);
    }
    this.resize();
  }

  setScore(notes, { beatsPerBar = 4, timing = null } = {}) {
    this.notes = Array.isArray(notes) ? notes.map((note) => {
      const startBeat = finite(note.startBeat);
      const duration = Math.max(0, finite(note.beats ?? note.durationBeats, 1));
      return {
        source: note,
        hole: finite(note.hole),
        draw: Boolean(note.draw ?? note.isDraw ?? (note.direction === 'draw')),
        slider: Boolean(note.slider ?? note.slide ?? note.isSlide),
        isRest: Boolean(note.isRest || Number(note.hole) === 0),
        startBeat,
        endBeat: Math.max(startBeat, finite(note.endBeat, startBeat + duration)),
      };
    }).sort((a, b) => a.startBeat - b.startBeat) : [];
    let latestEnd = -Infinity;
    this.noteEndBounds = this.notes.map((note) => {
      latestEnd = Math.max(latestEnd, note.endBeat);
      return latestEnd;
    });
    this.beatsPerBar = Math.max(0.125, finite(beatsPerBar, 4));
    this.timing = timing;
    this.render();
  }

  setPosition(beat) {
    this.beat = finite(beat);
    this.render();
  }

  setActive(note) {
    if (this.activeNote === note) return;
    this.activeNote = note ?? null;
    this.render();
  }

  resize() {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.max(1, Math.round(this.width * this.pixelRatio));
    const height = Math.max(1, Math.round(this.height * this.pixelRatio));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.render();
  }

  hitTest(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * this.width / Math.max(1, rect.width);
    const y = (event.clientY - rect.top) * this.height / Math.max(1, rect.height);
    return this.hitAreas.findLast
      ? this.hitAreas.findLast((area) => x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height)
      : [...this.hitAreas].reverse().find((area) => x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height);
  }

  firstVisibleNoteIndex() {
    let low = 0;
    let high = this.noteEndBounds.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.noteEndBounds[middle] <= this.beat) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  render() {
    if (this.destroyed || !this.ctx || !this.width || !this.height) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const left = w < 420 ? 25 : 34;
    const right = 12;
    const top = 30;
    const lineY = Math.max(top + 10, h - 21);
    const laneWidth = Math.max(1, (w - left - right) / 12);
    const fieldWidth = laneWidth * 12;
    // Keep a sixteenth-note slot at least 15px high, so shrinking the canvas
    // shows less time instead of squeezing consecutive labels together.
    const beatHeight = Math.max(60, (lineY - top) / this.visibleBeats);
    const visibleBeats = (lineY - top) / beatHeight;
    const yForBeat = (beat) => lineY - (beat - this.beat) * beatHeight;
    this.hitAreas = [];

    ctx.setTransform(this.pixelRatio || 1, 0, 0, this.pixelRatio || 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, fieldWidth, lineY - top);
    ctx.clip();
    for (let lane = 0; lane < 12; lane += 1) {
      if (lane % 2 === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.016)';
        ctx.fillRect(left + lane * laneWidth, top, laneWidth, lineY - top);
      }
      ctx.beginPath();
      ctx.moveTo(left + lane * laneWidth + 0.5, top);
      ctx.lineTo(left + lane * laneWidth + 0.5, lineY);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(left + fieldWidth - 0.5, top);
    ctx.lineTo(left + fieldWidth - 0.5, lineY);
    ctx.strokeStyle = COLORS.grid;
    ctx.stroke();

    const earliest = Math.max(0, Math.floor(this.beat));
    const latest = this.beat + visibleBeats + 1;
    for (let beat = earliest; beat <= latest; beat += 1) {
      const y = yForBeat(beat);
      ctx.beginPath();
      ctx.moveTo(left, y + 0.5);
      ctx.lineTo(left + fieldWidth, y + 0.5);
      ctx.strokeStyle = 'rgba(88, 112, 99, 0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const firstBarBeat = Math.max(0, this.beat);
    const barLines = this.timing ? this.timing.barsBetween(firstBarBeat, latest) : [];
    if (!this.timing) {
      for (let bar = Math.max(0, Math.ceil(this.beat / this.beatsPerBar)); bar * this.beatsPerBar <= latest; bar += 1) barLines.push({ beat: bar * this.beatsPerBar, bar: bar + 1 });
    }
    for (const { beat } of barLines) {
      const y = yForBeat(beat);
      ctx.beginPath();
      ctx.moveTo(left, y + 0.5);
      ctx.lineTo(left + fieldWidth, y + 0.5);
      ctx.strokeStyle = COLORS.measure;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    for (let index = this.firstVisibleNoteIndex(); index < this.notes.length; index += 1) {
      const note = this.notes[index];
      if (note.startBeat > latest) break;
      if (note.endBeat <= this.beat) continue;
      const bottom = yForBeat(note.startBeat);
      const blockTop = yForBeat(note.endBeat);
      if (bottom < top || blockTop > lineY) continue;
      const active = note.startBeat <= this.beat && note.endBeat > this.beat;
      const highlighted = active || (this.activeNote && (note.source === this.activeNote || (note.source.id != null && note.source.id === this.activeNote.id)));

      if (note.isRest) {
        const restTop = Math.max(blockTop, top);
        const restBottom = Math.min(bottom, lineY);
        const labelY = Math.max(top + 5, Math.min(lineY - 5, (restTop + restBottom) / 2));
        this.drawRest(ctx, note, left, labelY, fieldWidth, top, lineY, highlighted);
        continue;
      }
      if (note.hole < 1 || note.hole > 12) continue;
      const gap = laneWidth < 28 ? 5 : 10;
      const x = left + (note.hole - 1) * laneWidth + gap / 2;
      const blockWidth = Math.max(6, laneWidth - gap);
      const naturalHeight = Math.max(5, bottom - blockTop - 3);
      const y = blockTop + 1.5;
      const color = note.draw ? COLORS.draw : COLORS.blow;
      const alpha = highlighted ? 0.3 : 0.14;
      const visibleTop = Math.max(y, top);
      const visibleBottom = Math.min(y + naturalHeight, lineY);
      this.hitAreas.push({ x, y: visibleTop, width: blockWidth, height: Math.max(0, visibleBottom - visibleTop), startBeat: note.startBeat });

      ctx.save();
      roundedRect(ctx, x, y, blockWidth, naturalHeight, Math.min(6, blockWidth / 4));
      ctx.fillStyle = note.draw ? `rgba(234, 176, 154, ${alpha})` : `rgba(180, 237, 177, ${alpha})`;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.globalAlpha = highlighted ? 1 : 0.8;
      ctx.lineWidth = highlighted ? 1.5 : 1;
      ctx.stroke();

      // A small leading edge makes adjacent notes of the same hole distinct.
      const edgeY = Math.min(bottom - 2.5, lineY - 1);
      if (edgeY >= top) {
        ctx.beginPath();
        ctx.moveTo(x + 4, edgeY);
        ctx.lineTo(x + blockWidth - 4, edgeY);
        ctx.strokeStyle = color;
        ctx.lineWidth = highlighted ? 3 : 2;
        ctx.stroke();
      }

      const available = visibleBottom - visibleTop;
      if (available > 0 || active) {
        const labelY = Math.max(top + 6, Math.min(lineY - 6, (visibleTop + visibleBottom) / 2));
        this.drawNoteLabel(ctx, x, labelY, blockWidth, note, color, available);
      }
      ctx.restore();
    }
    ctx.restore();

    ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.muted;
    for (const { beat, bar } of barLines) {
      const y = yForBeat(beat);
      if (y > top + 5 && y < lineY - 9) ctx.fillText(String(bar).padStart(2, '0'), left - 9, y);
    }
    ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8a9e93';
    for (let hole = 1; hole <= 12; hole += 1) {
      ctx.fillText(String(hole), left + (hole - 0.5) * laneWidth, 15);
    }

    const glow = ctx.createLinearGradient(0, lineY - 22, 0, lineY);
    glow.addColorStop(0, 'rgba(180, 237, 177, 0)');
    glow.addColorStop(1, 'rgba(180, 237, 177, 0.09)');
    ctx.fillStyle = glow;
    ctx.fillRect(left, lineY - 22, fieldWidth, 22);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(left, lineY + 0.5);
    ctx.lineTo(left + fieldWidth, lineY + 0.5);
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = COLORS.line;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = COLORS.line;
    ctx.beginPath();
    ctx.moveTo(left - 7, lineY - 3.5);
    ctx.lineTo(left - 2.5, lineY);
    ctx.lineTo(left - 7, lineY + 3.5);
    ctx.closePath();
    ctx.fill();
  }

  drawNoteLabel(ctx, x, y, width, note, color, height) {
    const compact = width < 32;
    const short = height < 17;
    const fontSize = short ? 9 : compact ? 10 : 12;
    const center = x + width / 2;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 1;
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    const label = `${compact ? note.draw ? '-' : '+' : ''}${note.hole}${note.slider ? '#' : ''}`;
    ctx.fillText(label, center + (compact ? 0 : 4), y, Math.max(1, width - (compact ? 3 : 13)));
    if (!compact) {
      const arrowX = center - (note.slider ? 12 : 9);
      const direction = note.draw ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(arrowX, y - direction * 3.5);
      ctx.lineTo(arrowX, y + direction * 3.5);
      ctx.moveTo(arrowX - 2.5, y + direction * 1);
      ctx.lineTo(arrowX, y + direction * 3.5);
      ctx.lineTo(arrowX + 2.5, y + direction * 1);
      ctx.lineWidth = 1.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  drawRest(ctx, note, x, y, width, top, bottom, active) {
    if (y < top + 5 || y > bottom - 5) return;
    ctx.save();
    ctx.globalAlpha = active ? 0.9 : 0.55;
    ctx.strokeStyle = '#8ba498';
    ctx.setLineDash([3, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 8, y);
    ctx.lineTo(x + width / 2 - 25, y);
    ctx.moveTo(x + width / 2 + 25, y);
    ctx.lineTo(x + width - 8, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '600 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#a2b3a8';
    ctx.fillText('REST', x + width / 2, y);
    ctx.restore();
    this.hitAreas.push({ x, y: y - 9, width, height: 18, startBeat: note.startBeat });
  }

  destroy() {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.handleResize);
    this.canvas.removeEventListener('click', this.handleClick);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.style.cursor = '';
    this.hitAreas = [];
  }
}
