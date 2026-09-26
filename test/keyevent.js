/**
 * The frontend only ever reads a handful of fields off a keyboard event, so a
 * plain object is a faithful stand-in and none of the key tests need a browser.
 * A key that prints no character reports the same name as its position, so only
 * a letter or a digit has to be given both.
 *
 * @param {{ key?: string, code?: string, ctrlKey?: boolean, altKey?: boolean,
 *   metaKey?: boolean, shiftKey?: boolean, repeat?: boolean, altGraph?: boolean }} init
 * @returns {KeyboardEvent}
 */
export function key(init) {
  const pressed = init.key ?? "";
  return /** @type {KeyboardEvent} */ ({
    key: pressed,
    code: init.code ?? ([...pressed].length === 1 ? "" : pressed),
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    repeat: init.repeat ?? false,
    getModifierState: (name) => name === "AltGraph" && init.altGraph === true,
  });
}
