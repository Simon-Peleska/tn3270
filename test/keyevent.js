/**
 * The frontend only ever reads a handful of fields off a keyboard event, so a
 * plain object is a faithful stand-in and none of the key tests need a browser.
 *
 * @param {{ key?: string, code?: string, ctrlKey?: boolean, altKey?: boolean,
 *   metaKey?: boolean, shiftKey?: boolean, repeat?: boolean }} init
 * @returns {KeyboardEvent}
 */
export function key(init) {
  return /** @type {KeyboardEvent} */ ({
    key: init.key ?? "",
    code: init.code ?? "",
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    repeat: init.repeat ?? false,
  });
}
