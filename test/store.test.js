import test from "node:test";
import assert from "node:assert/strict";
import { waitUntil } from "./helpers.js";

/**
 * A server that answers the way server/main.js does, holding what it is sent.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, unknown>} stored
 * @param {{ failGets?: boolean, holdPuts?: Promise<void> }} [options]
 */
function fakeServer(t, stored, options = {}) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls = /** @type {string[]} */ ([]);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const key = url.slice(url.lastIndexOf("/") + 1);
    calls.push(`${method} ${url}`);
    if (method === "GET") {
      if (options.failGets)
        return Response.json(
          { code: "E8002", message: "locked" },
          { status: 500 },
        );
      return Response.json(structuredClone(stored[key] ?? null));
    }
    await options.holdPuts;
    stored[key] = JSON.parse(String(init?.body));
    return new Response(null, { status: 204 });
  };
  return calls;
}

/**
 * The page as server/main.js sends it, with what it wrote in for this user.
 *
 * @param {import('node:test').TestContext} t
 * @param {unknown} inline undefined for a page without it
 */
function pageWith(t, inline) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  t.after(() => {
    if (original !== undefined)
      Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      /** @param {string} id */
      getElementById(id) {
        return id === "userdata" && inline !== undefined
          ? { textContent: JSON.stringify(inline) }
          : null;
      },
    },
  });
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
 * The store keeps what it read from the page, so every test needs a module of its own.
 *
 * @param {string} name
 * @returns {Promise<typeof import('../public/store.js')>}
 */
function freshStore(name) {
  return import(`../public/store.js?${name}`);
}

test("settings, macros and keymap come with the page, recordings from the server", async (t) => {
  const calls = fakeServer(t, { recordings: [{ name: "logon" }] });
  pageWith(t, {
    data: {
      settings: { theme: "Mainframe" },
      macros: [{ name: "logon" }],
      keymap: { F1: "PF(1)" },
    },
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
  assert.deepEqual(recordings, [{ name: "logon" }]);
  assert.deepEqual(calls, ["GET ./api/userdata/recordings"]);
});

test("what an older version kept in this browser is moved to the server", async (t) => {
  /** @type {Record<string, unknown>} */
  const stored = { settings: { font: "IBM 3270" } };
  const calls = fakeServer(t, stored);
  pageWith(t, {
    data: { settings: { font: "IBM 3270" }, macros: null, keymap: null },
  });
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
  assert.deepEqual(calls, ["PUT ./api/userdata/macros"]);
});

test("a page the server could not read the settings into reports its code", async (t) => {
  fakeServer(t, {});
  pageWith(t, { error: { code: "E8002", message: "locked" } });
  legacyBrowserDatabase(t, {});
  const store = await freshStore("page-error");

  await assert.rejects(store.loadSettings(), /\[E8002\] locked/);
  await assert.rejects(store.loadKeymap(), /\[E8002\] locked/);
});

test("a page without the user data in it is reported with its own code", async (t) => {
  fakeServer(t, {});
  pageWith(t, undefined);
  const store = await freshStore("no-page-data");

  await assert.rejects(store.loadSettings(), /\[E5043\]/);
});

test("recordings that could not be read report the server's code", async (t) => {
  fakeServer(t, {}, { failGets: true });
  pageWith(t, { data: {} });
  legacyBrowserDatabase(t, {});
  const store = await freshStore("recordings-error");

  await assert.rejects(store.loadRecordings(), /\[E8002\] locked/);
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
