import { CanvasRenderer, CellFlags } from '/vendor/dist/ghostty-web.js';

/**
 * ghostty-web's block cursor is opaque, so it hides the character the operator
 * is about to overtype. Redrawing the glyph over it in the cursor accent makes
 * the cell read like selected text: the same two colours, swapped.
 *
 * Patched in place like box-select.js, and here rather than in patches/ because
 * an install that skipped patch-package would silently lose it — and a cursor
 * that swallows characters is not something a build log points out.
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
