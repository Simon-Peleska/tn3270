import { CanvasRenderer, CellFlags } from "./vendor/dist/ghostty-web.js";

/**
 * ghostty-web's block cursor is opaque and hides the character under it, so the
 * glyph is redrawn in the cursor accent. Patched here, not in patches/, because
 * an install skipping patch-package would drop it silently.
 */
export function installCursorGlyph() {
  CanvasRenderer.prototype["renderCursor"] = function renderCursor(
    /** @type {number} */ col,
    /** @type {number} */ row,
  ) {
    const { width, height, baseline } = this["metrics"];
    // A cell edge falls between two device pixels at a fractional
    // devicePixelRatio, and the antialiased edge lets the field under the
    // cursor show through as a hairline. The renderer snaps its own fills the
    // same way; see patches/ghostty-web+0.4.0.patch.
    const ratio = this["devicePixelRatio"];
    const snap = (/** @type {number} */ value) =>
      Math.round(value * ratio) / ratio;
    const x = snap(col * width);
    const y = snap(row * height);
    const right = snap((col + 1) * width);
    const bottom = snap((row + 1) * height);
    const ctx = this["ctx"];
    const theme = this["theme"];
    ctx.fillStyle = theme.cursor;

    if (this["cursorStyle"] === "underline") {
      const thickness = Math.max(2, Math.floor(height * 0.15));
      ctx.fillRect(x, bottom - thickness, right - x, thickness);
      return;
    }
    if (this["cursorStyle"] === "bar") {
      const thickness = Math.max(2, Math.floor(width * 0.15));
      ctx.fillRect(x, y, thickness, bottom - y);
      return;
    }

    ctx.fillRect(x, y, right - x, bottom - y);

    const buffer = this["currentBuffer"];
    const cell = buffer?.getLine(row)?.[col];
    if (cell === undefined || cell.width === 0) return;

    const glyph =
      cell.grapheme_len > 0 && buffer?.getGraphemeString !== undefined
        ? buffer.getGraphemeString(row, col)
        : String.fromCodePoint(cell.codepoint || 32);
    const weight = (cell.flags & CellFlags.BOLD) !== 0 ? "bold " : "";
    ctx.font = `${weight}${this["fontSize"]}px ${this["fontFamily"]}`;
    ctx.fillStyle = theme.cursorAccent;
    ctx.fillText(glyph, x, y + baseline);
  };
}
