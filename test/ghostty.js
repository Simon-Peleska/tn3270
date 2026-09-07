/**
 * Loads ghostty-web's WASM VT parser in Node, with no DOM.
 *
 * This is what makes the round-trip test possible: our VT output is checked
 * against the very parser the browser will run, without needing a browser.
 *
 * @returns {Promise<import('ghostty-web').Ghostty>}
 */
export async function loadGhostty() {
  // The bundle is built for the browser and touches `self` while loading.
  if (typeof globalThis.self === 'undefined') {
    // @ts-expect-error deliberately installing a browser global for the bundle
    globalThis.self = globalThis;
  }
  // Resolved through package.json rather than as a subpath: the package's
  // `exports` map does not expose dist/ directly.
  const { Ghostty } = await import('ghostty-web');
  return Ghostty.load();
}

/**
 * Feed VT bytes to a fresh terminal and read the resulting grid back.
 *
 * @param {import('ghostty-web').Ghostty} ghostty
 * @param {number} cols
 * @param {number} rows
 * @param {string} bytes
 * @param {number[]} [palette] packed 0xRRGGBB, indices 0-15, as ghostty-web
 *   expects — lets a test control what each ANSI slot resolves to instead of
 *   depending on ghostty's built-in default.
 * @returns {{ text: string[], cell: (row: number, col: number) => import('ghostty-web').GhosttyCell, cursor: { x: number, y: number } }}
 */
export function render(ghostty, cols, rows, bytes, palette) {
  const terminal = ghostty.createTerminal(cols, rows, palette ? { palette } : undefined);
  terminal.write(bytes);

  /** @type {import('ghostty-web').GhosttyCell[][]} */
  const grid = [];
  /** @type {string[]} */
  const text = [];
  for (let row = 0; row < rows; row++) {
    const line = terminal.getLine(row) ?? [];
    grid.push(line);
    let rendered = '';
    for (let col = 0; col < cols; col++) {
      const cell = line[col];
      const codepoint = cell ? cell.codepoint : 0;
      rendered += codepoint === 0 ? ' ' : String.fromCodePoint(codepoint);
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
