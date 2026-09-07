import { CanvasRenderer, SelectionManager } from '/vendor/dist/ghostty-web.js';

/**
 * ghostty-web only knows stream selection (first row from the click to end of
 * line, last row from start of line, everything between fully selected) —
 * normal for a shell, wrong for a fixed 3270 grid where users copy a column
 * out of a form. This replaces its two selection primitives with a
 * rectangular one: same column range on every row. There is no option for
 * this in the library, so the prototypes are patched in place rather than
 * forking a vendored dependency.
 */
// ghostty-web marks these fields `private` in its .d.ts, but it is plain JS
// underneath with no real access enforcement. Bracket notation reaches them
// without TypeScript's private-field check (which only fires on dot access),
// so the patch can stay `any`-free.

export function installBoxSelection() {
  CanvasRenderer.prototype['isInSelection'] = function isInSelection(
    /** @type {number} */ col,
    /** @type {number} */ row,
  ) {
    const coords = this['currentSelectionCoords'];
    if (!coords) return false;
    const { startCol, startRow, endCol, endRow } = coords;
    const loCol = Math.min(startCol, endCol);
    const hiCol = Math.max(startCol, endCol);
    return row >= startRow && row <= endRow && col >= loCol && col <= hiCol;
  };

  SelectionManager.prototype.getSelection = function getSelection() {
    const start = this['selectionStart'];
    const end = this['selectionEnd'];
    if (!start || !end) return '';
    let startRow = start.absoluteRow;
    let endRow = end.absoluteRow;
    if (startRow > endRow) [startRow, endRow] = [endRow, startRow];
    const loCol = Math.min(start.col, end.col);
    const hiCol = Math.max(start.col, end.col);

    const wasmTerm = this['wasmTerm'];
    const scrollbackLength = wasmTerm.getScrollbackLength();
    const lines = [];
    for (let row = startRow; row <= endRow; row++) {
      const line = row < scrollbackLength
        ? wasmTerm.getScrollbackLine(row)
        : wasmTerm.getLine(row - scrollbackLength);
      if (!line) {
        lines.push('');
        continue;
      }

      let text = '';
      let lastNonBlank = -1;
      for (let col = loCol; col <= hiCol && col < line.length; col++) {
        const cell = line[col];
        if (cell && cell.codepoint !== 0) {
          const glyph = cell.grapheme_len > 0
            ? (row < scrollbackLength
              ? wasmTerm.getScrollbackGraphemeString(row, col)
              : wasmTerm.getGraphemeString(row - scrollbackLength, col))
            : String.fromCodePoint(cell.codepoint);
          text += glyph;
          if (glyph.trim()) lastNonBlank = text.length;
        } else {
          text += ' ';
        }
      }
      lines.push(lastNonBlank >= 0 ? text.substring(0, lastNonBlank) : '');
    }
    return lines.join('\n');
  };
}
