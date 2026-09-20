/**
 * The 3270 grid is fixed, so font size is the only way to fill a pane. Kept
 * apart from the terminal so it can be tested without a browser.
 */

/** @type {number} */
export const MIN_FONT_SIZE = 6;

/** @type {number} */
export const MAX_FONT_SIZE = 64;

/**
 * Largest size at which the grid still fits the box. Cell sizes are rounded up,
 * so the scaled guess can land either side of the answer and the search walks both ways.
 *
 * @param {object} fit
 * @param {(size: number) => { width: number, height: number }} fit.measure one
 *   cell at that text size
 * @param {number} fit.cols
 * @param {number} fit.rows
 * @param {{ width: number, height: number }} fit.box the room to fill
 * @param {number} fit.start the size in force, as the first guess
 * @returns {number}
 */
export function chooseFontSize({ measure, cols, rows, box, start }) {
  const fits = (/** @type {number} */ size) => {
    const cell = measure(size);
    return cell.width * cols <= box.width && cell.height * rows <= box.height;
  };

  const current = measure(start);
  const scale = Math.min(box.width / (current.width * cols), box.height / (current.height * rows));
  let size = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.floor(start * scale) + 1));

  while (size > MIN_FONT_SIZE && !fits(size)) size -= 1;
  while (size < MAX_FONT_SIZE && fits(size + 1)) size += 1;
  return size;
}
