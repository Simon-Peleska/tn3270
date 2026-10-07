/** mulberry32: small, fast and good enough to pick test inputs. @param {number} seed */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** 0 <= n < max @param {number} max */
    int: (max) => Math.floor(next() * max),
    /** @template T @param {T[]} items @returns {T} */
    pick: (items) => items[Math.floor(next() * items.length)],
    /** @param {number} p */
    chance: (p) => next() < p,
  };
}
/** @typedef {ReturnType<typeof rng>} Rng */
