/**
 * Loads ghostty-web's WASM VT parser in Node, with no DOM.
 *
 * @returns {Promise<import('ghostty-web').Ghostty>}
 */
export async function loadGhostty() {
  // The browser bundle touches `self` while loading.
  if (typeof globalThis.self === "undefined") {
    // @ts-expect-error installing a browser global for the bundle
    globalThis.self = globalThis;
  }
  // Via package.json: `exports` does not expose dist/ directly.
  const { Ghostty } = await import("ghostty-web");
  return Ghostty.load();
}

/**
 * @param {import('ghostty-web').Ghostty} ghostty
 * @param {number} cols
 * @param {number} rows
 * @param {string} bytes
 * @param {number[]} [palette] packed 0xRRGGBB, indices 0-15
 * @returns {{ text: string[], cell: (row: number, col: number) => import('ghostty-web').GhosttyCell, cursor: { x: number, y: number } }}
 */
export function render(ghostty, cols, rows, bytes, palette) {
  const terminal = ghostty.createTerminal(
    cols,
    rows,
    palette ? { palette } : undefined,
  );
  terminal.write(bytes);

  /** @type {import('ghostty-web').GhosttyCell[][]} */
  const grid = [];
  /** @type {string[]} */
  const text = [];
  for (let row = 0; row < rows; row++) {
    const line = terminal.getLine(row) ?? [];
    grid.push(line);
    let rendered = "";
    for (let col = 0; col < cols; col++) {
      const cell = line[col];
      const codepoint = cell ? cell.codepoint : 0;
      rendered += codepoint === 0 ? " " : String.fromCodePoint(codepoint);
    }
    text.push(rendered);
  }

  const cursor = terminal.getCursor();
  return {
    text,
    cell: (row, col) => {
      const cell = grid[row]?.[col];
      if (!cell) throw new Error(`no cell at row ${row} col ${col}`);
      return cell;
    },
    cursor: { x: cursor.x, y: cursor.y },
  };
}
