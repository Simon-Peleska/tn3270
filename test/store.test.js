import test from "node:test";
import assert from "node:assert/strict";
import { waitUntil } from "./helpers.js";

/**
 * A server that answers the way server/main.js does, holding what it is sent.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, unknown>} stored
 * @param {{ failFirstGet?: boolean, holdPuts?: Promise<void> }} [options]
 */
function fakeServer(t, stored, options = {}) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls = /** @type {string[]} */ ([]);
  let gets = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (method === "GET") {
      gets++;
      if (options.failFirstGet && gets === 1)
        return Response.json(
          { code: "E8002", message: "locked" },
          { status: 500 },
        );
      return Response.json({
        settings: null,
        macros: null,
        keymap: null,
        recordings: null,
        ...structuredClone(stored),
      });
    }
    await options.holdPuts;
    stored[url.slice(url.lastIndexOf("/") + 1)] = JSON.parse(
      String(init?.body),
    );
    return new Response(null, { status: 204 });
  };
  return calls;
}

/**
 * What an older version left in this browser, under its old key names.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, unknown>} records
 */
function legacyBrowserDatabase(t, records) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  t.after(() => {
    if (original !== undefined)
      Object.defineProperty(globalThis, "indexedDB", original);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  });
  const database = {
    createObjectStore() {},
    transaction() {
      return {
        objectStore() {
          return {
            /** @param {string} key */
            get(key) {
              const request = {
                result: /** @type {unknown} */ (undefined),
                onsuccess: /** @type {(() => void) | null} */ (null),
              };
              queueMicrotask(() => {
                request.result = structuredClone(records[key]);
                request.onsuccess?.();
              });
              return request;
            },
          };
        },
      };
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request = {
          result: database,
          onupgradeneeded: /** @type {(() => void) | null} */ (null),
          onsuccess: /** @type {(() => void) | null} */ (null),
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
  });
}

/**
 * The store caches its one GET, so every test needs a module of its own.
 *
 * @param {string} name
 * @returns {Promise<typeof import('../public/store.js')>}
 */
function freshStore(name) {
  return import(`../public/store.js?${name}`);
}

test("all four are loaded from the server in one request", async (t) => {
  const calls = fakeServer(t, {
    settings: { theme: "Mainframe" },
    macros: [{ name: "logon" }],
    keymap: { F1: "PF(1)" },
    recordings: [],
  });
  legacyBrowserDatabase(t, {});
  const store = await freshStore("all-four");

  const [settings, macros, keymap, recordings] = await Promise.all([
    store.loadSettings(),
    store.loadMacros(),
    store.loadKeymap(),
    store.loadRecordings(),
  ]);

  assert.deepEqual(settings, { theme: "Mainframe" });
  assert.deepEqual(macros, [{ name: "logon" }]);
  assert.deepEqual(keymap, { F1: "PF(1)" });
  assert.deepEqual(recordings, []);
  assert.deepEqual(calls, ["GET ./api/userdata"]);
});

test("what an older version kept in this browser is moved to the server", async (t) => {
  /** @type {Record<string, unknown>} */
  const stored = { settings: { font: "IBM 3270" } };
  const calls = fakeServer(t, stored);
  legacyBrowserDatabase(t, {
    ui: { font: "Inconsolata" },
    macros: [{ name: "from the browser" }],
  });
  const store = await freshStore("legacy");

  assert.deepEqual(await store.loadSettings(), { font: "IBM 3270" });
  assert.deepEqual(await store.loadMacros(), [{ name: "from the browser" }]);
  assert.deepEqual(await store.loadKeymap(), {});

  assert.deepEqual(stored["macros"], [{ name: "from the browser" }]);
  assert.deepEqual(stored["settings"], { font: "IBM 3270" });
  assert.equal(stored["keymap"], undefined);
  assert.deepEqual(calls, ["GET ./api/userdata", "PUT ./api/userdata/macros"]);
});

test("a failed load reports the server's code and can be retried", async (t) => {
  fakeServer(t, { keymap: { F2: "PF(2)" } }, { failFirstGet: true });
  legacyBrowserDatabase(t, {});
  const store = await freshStore("retry");

  await assert.rejects(store.loadKeymap(), /\[E8002\] locked/);
  assert.deepEqual(await store.loadKeymap(), { F2: "PF(2)" });
});

test("saves of one key reach the server in the order they were made", async (t) => {
  /** @type {Record<string, unknown>} */
  const stored = {};
  /** @type {() => void} */
  let release = () => {};
  const holdPuts = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const calls = fakeServer(t, stored, { holdPuts });
  const store = await freshStore("order");

  const saves = Promise.all([
    store.saveSettings({ theme: "first" }),
    store.saveSettings({ theme: "second" }),
  ]);
  await waitUntil(() => calls.length > 0, "the first save to be sent");
  // Two requests in flight at once could land in either order.
  assert.deepEqual(calls, ["PUT ./api/userdata/settings"]);
  release();
  await saves;

  assert.deepEqual(stored["settings"], { theme: "second" });
  assert.equal(calls.length, 2);
});
