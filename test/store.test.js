import test from "node:test";
import assert from "node:assert/strict";
import { loadRecordings, saveRecordings } from "../public/store.js";

test("a failed database open can be retried", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  t.after(() => {
    if (original !== undefined)
      Object.defineProperty(globalThis, "indexedDB", original);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  });

  let attempts = 0;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        attempts++;
        const request = {
          result: {
            createObjectStore() {},
            transaction() {
              return {
                objectStore() {
                  return {
                    get() {
                      const read = {
                        result: undefined,
                        onsuccess: /** @type {(() => void) | null} */ (null),
                      };
                      queueMicrotask(() => read.onsuccess?.());
                      return read;
                    },
                  };
                },
              };
            },
          },
          error: new Error("blocked"),
          onupgradeneeded: /** @type {(() => void) | null} */ (null),
          onsuccess: /** @type {(() => void) | null} */ (null),
          onerror: /** @type {(() => void) | null} */ (null),
        };
        queueMicrotask(() => {
          if (attempts === 1) request.onerror?.();
          else {
            request.onupgradeneeded?.();
            request.onsuccess?.();
          }
        });
        return request;
      },
    },
  });

  const retryModule = "../public/store.js?retry";
  const { loadSettings } = /** @type {typeof import('../public/store.js')} */ (
    await import(retryModule)
  );
  await assert.rejects(loadSettings(), /blocked/);
  assert.deepEqual(await loadSettings(), {});
  assert.equal(attempts, 2);
});

test("recordings survive an IndexedDB read after being saved", async (t) => {
  /** @type {Map<string, unknown>} */
  const stored = new Map();
  const database = {
    createObjectStore() {},
    transaction() {
      const transaction = {
        error: null,
        oncomplete: /** @type {(() => void) | null} */ (null),
        onerror: /** @type {(() => void) | null} */ (null),
        objectStore() {
          return {
            /** @param {string} key */
            get(key) {
              const request = {
                result: /** @type {unknown} */ (undefined),
                error: null,
                onsuccess: /** @type {(() => void) | null} */ (null),
                onerror: /** @type {(() => void) | null} */ (null),
              };
              queueMicrotask(() => {
                request.result = structuredClone(stored.get(key));
                request.onsuccess?.();
              });
              return request;
            },
            /** @param {unknown} value @param {string} key */
            put(value, key) {
              stored.set(key, structuredClone(value));
              queueMicrotask(() => transaction.oncomplete?.());
            },
          };
        },
      };
      return transaction;
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  t.after(() => {
    if (original !== undefined)
      Object.defineProperty(globalThis, "indexedDB", original);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request = {
          result: database,
          onupgradeneeded: /** @type {(() => void) | null} */ (null),
          onsuccess: /** @type {(() => void) | null} */ (null),
          onerror: /** @type {(() => void) | null} */ (null),
        };
        queueMicrotask(() => {
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    },
  });

  assert.deepEqual(await loadRecordings(), []);
  /** @type {import('../public/recorder.js').Recording[]} */
  const recordings = [
    {
      name: "Saved",
      recordedAt: "2026-01-01T00:00:00.000Z",
      steps: [{ screen: ["hello"], cursor: { row: 0, col: 0 }, final: true }],
    },
  ];
  await saveRecordings(recordings);
  recordings[0].name = "Changed after save";
  assert.deepEqual(await loadRecordings(), [
    { ...recordings[0], name: "Saved" },
  ]);
});
