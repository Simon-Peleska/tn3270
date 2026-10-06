import {
  FA_INTENSITY,
  FA_INT_ZERO_NSEL,
  FA_PROTECT,
} from "../3270/src/index.js";

/**
 * From the emulator's field attribute per cell (0 where a cell holds none).
 * Non-display intensity marks a password field. A field attribute holds until the next one, wrapping past the end of the
 * buffer, and its own cell is never typeable.
 *
 * @param {ArrayLike<number>} fa row-major, one per cell
 * @returns {{ editable: Uint8Array, hidden: Uint8Array, formatted: boolean }}
 *   `editable`/`hidden` are row-major, as long as `fa`, 1 where marked
 */
export function fieldMap(fa) {
  const size = fa.length;
  let last = -1;
  for (let i = size - 1; i >= 0 && last < 0; i--) if (fa[i]) last = i;

  const editable = new Uint8Array(size);
  const hidden = new Uint8Array(size);
  // An unformatted screen is all unprotected, but tinting every cell is wrong.
  if (last < 0) return { editable, hidden, formatted: false };

  let isProtected = (fa[last] & FA_PROTECT) !== 0;
  let isHidden = (fa[last] & FA_INTENSITY) === FA_INT_ZERO_NSEL;
  for (let i = 0; i < size; i++) {
    if (fa[i]) {
      isProtected = (fa[i] & FA_PROTECT) !== 0;
      isHidden = (fa[i] & FA_INTENSITY) === FA_INT_ZERO_NSEL;
      continue;
    }
    editable[i] = isProtected ? 0 : 1;
    hidden[i] = isHidden ? 1 : 0;
  }
  return { editable, hidden, formatted: true };
}
