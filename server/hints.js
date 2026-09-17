/**
 * Ctrl-B's field hints: one keyboard letter per editable field, shown over its
 * first cell, so typing it jumps the cursor straight there. A field right
 * after a word like "name:" is given that word's own first letter, 'n', so
 * long as nothing earlier on the screen has already claimed it — the whole
 * point being that the letter you'd guess is usually the one that works.
 */

const LOWER = 'qwertzuiopasdfghjklyxcvbnm';

/** @type {readonly string[]} lowercase first, then capitals for overflow. */
const SEQUENCE = [...LOWER, ...LOWER.toUpperCase()];

/** @type {ReadonlyMap<string, number>} a letter's place in {@link LOWER}. */
const RANK = new Map([...LOWER].map((ch, index) => [ch, index]));

/**
 * The word immediately before a field, on the same row — "name:  " and
 * "name:___" both give "name". Only protected text counts, and only back to
 * the previous field or the start of the row, so a field never borrows a
 * label that belongs to something else.
 *
 * @param {{ ch: string, editable: boolean }[]} cells row-major, length rows*cols
 * @param {number} cols
 * @param {number} pos the field's first cell
 * @returns {string | null} lowercase
 */
function fieldLabel(cells, cols, pos) {
  const rowStart = Math.floor(pos / cols) * cols;
  let start = pos;
  while (start > rowStart && !cells[start - 1].editable) start--;
  const text = cells.slice(start, pos).map((cell) => cell.ch).join('');
  const match = /([a-zA-Z]+)[^a-zA-Z]*$/.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/**
 * The order a field with this label tries its letters in: its own first
 * letter first, since that is the one an operator would guess, then the rest
 * of the label sorted by keyboard order — so if "name" loses 'n' to an
 * earlier field, it reaches for 'e' next rather than 'a', 'e' being the
 * earlier key.
 *
 * @param {string} label lowercase
 * @returns {string[]}
 */
function labelCandidates(label) {
  const first = label[0];
  const rest = [...new Set(label.slice(1))]
    .filter((ch) => ch !== first)
    .sort((a, b) => (RANK.get(a) ?? Infinity) - (RANK.get(b) ?? Infinity));
  return [first, ...rest];
}

/**
 * Assigns one letter to every editable field. Labelled fields get first
 * chance at their own mnemonic, resolved among themselves in screen order;
 * whatever is left over — an unlabelled field, or one whose whole label was
 * already claimed — takes the next free letter in keyboard order instead.
 *
 * @param {{ ch: string, editable: boolean }[]} cells row-major, length rows*cols
 * @param {number} cols
 * @returns {{ row: number, col: number, letter: string }[]} in screen order
 */
export function computeHints(cells, cols) {
  const total = cells.length;
  /** @type {number[]} */
  const starts = [];
  for (let pos = 0; pos < total; pos++) {
    if (cells[pos].editable && !cells[(pos - 1 + total) % total].editable) starts.push(pos);
  }

  const labels = starts.map((pos) => fieldLabel(cells, cols, pos));
  const used = new Set();
  /** @type {(string | null)[]} */
  const letters = new Array(starts.length).fill(null);

  starts.forEach((_pos, index) => {
    const label = labels[index];
    if (label === null) return;
    for (const candidate of labelCandidates(label)) {
      if (used.has(candidate)) continue;
      used.add(candidate);
      letters[index] = candidate;
      return;
    }
  });

  let next = 0;
  starts.forEach((_pos, index) => {
    if (letters[index] !== null) return;
    while (next < SEQUENCE.length && used.has(SEQUENCE[next])) next++;
    if (next >= SEQUENCE.length) return;
    letters[index] = SEQUENCE[next];
    used.add(SEQUENCE[next]);
    next++;
  });

  /** @type {{ row: number, col: number, letter: string }[]} */
  const hints = [];
  starts.forEach((pos, index) => {
    const letter = letters[index];
    if (letter === null) return;
    hints.push({ row: Math.floor(pos / cols), col: pos % cols, letter });
  });
  return hints;
}
