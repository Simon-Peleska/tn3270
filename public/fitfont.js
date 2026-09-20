/**
 * The grid is the 3270 model's — fixed rows and columns — so the text size is
 * the only thing free to move when a screen has to fill a pane. This is the
 * search for it, kept apart from the terminal it drives so it can be tested
 * against measurements that are not a browser's.
 */

/** @type {number} Below this the screen is unreadable anyway. */
export const MIN_FONT_SIZE = 6;

/** @type {number} */
export const MAX_FONT_SIZE = 64;

/**
 * The largest text size at which the whole grid still fits the box.
 *
 * A cell measures `ceil(text size x something)`, and that rounding is why the
 * search walks both ways: the ratio between the box and the cells it holds now
 * is a good guess, but a quantised one, and it lands below the answer as
 * readily as above it. Walking down alone — which is what this used to do —
 * left the screen a step or two small, and only grew it when something else
 * asked for a refit, from the bigger size it had by then.
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
