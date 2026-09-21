// Ctrl-B's field hints: one letter per editable field, preferring the first
// letter of the label in front of it.

const LOWER = "qwertzuiopasdfghjklyxcvbnm";

/** @type {readonly string[]} lowercase first, then capitals for overflow. */
const SEQUENCE = [...LOWER, ...LOWER.toUpperCase()];

/** @type {ReadonlyMap<string, number>} a letter's place in LOWER */
const RANK = new Map([...LOWER].map((ch, index) => [ch, index]));

/**
 * The protected word just before a field on the same row: "name:___" gives
 * "name". Never reaches past the previous field or the row start.
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
  const text = cells
    .slice(start, pos)
    .map((cell) => cell.ch)
    .join("");
  const match = /([a-zA-Z]+)[^a-zA-Z]*$/.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/**
 * The label's own first letter, then its remaining letters in keyboard order.
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
 * Labelled fields claim their mnemonic first, in screen order; the rest take
 * the next free letter in keyboard order.
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
    if (cells[pos].editable && !cells[(pos - 1 + total) % total].editable)
      starts.push(pos);
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
