import { CanvasRenderer, CellFlags } from '/vendor/dist/ghostty-web.js';

/**
 * ghostty-web's block cursor is opaque and hides the character under it, so the
 * glyph is redrawn in the cursor accent. Patched here, not in patches/, because
 * an install skipping patch-package would drop it silently.
 */
export function installCursorGlyph() {
  CanvasRenderer.prototype['renderCursor'] = function renderCursor(
    /** @type {number} */ col,
    /** @type {number} */ row,
  ) {
    const { width, height, baseline } = this['metrics'];
    const x = col * width;
    const y = row * height;
    const ctx = this['ctx'];
    const theme = this['theme'];
    ctx.fillStyle = theme.cursor;

    if (this['cursorStyle'] === 'underline') {
      const thickness = Math.max(2, Math.floor(height * 0.15));
      ctx.fillRect(x, y + height - thickness, width, thickness);
      return;
    }
    if (this['cursorStyle'] === 'bar') {
      const thickness = Math.max(2, Math.floor(width * 0.15));
      ctx.fillRect(x, y, thickness, height);
      return;
    }

    ctx.fillRect(x, y, width, height);

    const buffer = this['currentBuffer'];
    const cell = buffer?.getLine(row)?.[col];
    if (cell === undefined || cell.width === 0) return;

    const glyph = cell.grapheme_len > 0 && buffer?.getGraphemeString !== undefined
      ? buffer.getGraphemeString(row, col)
      : String.fromCodePoint(cell.codepoint || 32);
    const weight = (cell.flags & CellFlags.BOLD) !== 0 ? 'bold ' : '';
    ctx.font = `${weight}${this['fontSize']}px ${this['fontFamily']}`;
    ctx.fillStyle = theme.cursorAccent;
    ctx.fillText(glyph, x, y + baseline);
  };
}
