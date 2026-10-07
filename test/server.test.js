import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { WebSocket } from "../vendor/ws.mjs";
import { FakeHost } from "./fakehost.js";
import { freePort, testConfig, waitUntil } from "./helpers.js";
import { Grid } from "../public/grid.js";
import { DEFAULT_SETTINGS, FONTS, THEMES } from "../public/settings.js";

/**
 * @param {'debug' | 'info' | 'warn' | 'error'} [logLevel]
 * @param {boolean} [trustProxyHeaders]
 * @param {string} [userDataFile] pass the same one to two servers to share it
 * @param {Record<string, unknown>} [overrides] more config
 * @returns {Promise<{ port: number, logFile: string, stop: () => Promise<void> }>}
 */
async function startServer(
  logLevel = "warn",
  trustProxyHeaders = false,
  userDataFile = ":memory:",
  overrides = {},
) {
  const port = await freePort();
  const configFile = `test/.tmp-config-${port}.jsonc`;
  const logFile = `test/.tmp-log-${port}.log`;
  // The same config the in-process tests use, so the model the traces were
  // recorded on is stated once.
  await writeFile(
    configFile,
    JSON.stringify(
      testConfig({
        server: { host: "127.0.0.1", port },
        security: { trustProxyHeaders },
        logLevel,
        logFile,
        userDataFile,
        ...overrides,
      }),
    ),
  );

  const child = spawn("node", ["server/main.js"], {
    env: { ...process.env, TN3270_CONFIG: configFile },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Readiness comes from the socket, not a log line a level change could remove.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));

  let ready = false;
  await waitUntil(() => {
    if (!ready) {
      fetch(`http://127.0.0.1:${port}/api/sessions`)
        .then(() => {
          ready = true;
        })
        .catch(() => {});
    }
    return ready;
  }, "the server to accept requests");

  return {
    port,
    logFile,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      await rm(configFile, { force: true });
      await rm(logFile, { force: true });
      await rm(`${logFile}.1`, { force: true });
    },
  };
}

/**
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ socket: WebSocket, messages: Record<string, unknown>[], paints: Record<string, unknown>[], grid: Grid }>}
 */
async function openViewer(url, headers = {}) {
  const socket = new WebSocket(url, { headers });
  /** @type {Record<string, unknown>[]} */
  const messages = [];
  /** @type {Record<string, unknown>[]} */
  const paints = [];
  const grid = new Grid(1, 1);

  socket.on("message", (data) => {
    const frame = JSON.parse(String(data));
    for (const message of Array.isArray(frame) ? frame : [frame]) {
      messages.push(message);
      if (message["type"] !== "paint") continue;
      paints.push(message);
      grid.applyPaint(message);
    }
  });

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, messages, paints, grid };
}

test("two browsers share one session over the real server", async (t) => {
  const server = await startServer();
  const host = await FakeHost.listen("test/traces/reverse.trc", 0, {
    tls: true,
  });
  t.after(async () => {
    await host.close();
    await server.stop();
  });

  const base = `http://127.0.0.1:${server.port}`;
  const created = await (
    await fetch(`${base}/api/sessions`, { method: "POST" })
  ).json();
  assert.match(String(created.id), /^[0-9a-f-]{36}$/);

  const first = await openViewer(
    `ws://127.0.0.1:${server.port}/ws/${created.id}`,
  );
  t.after(() => first.socket.close());
  await waitUntil(() => first.messages.length > 0, "the hello message");
  assert.equal(first.messages[0]?.["type"], "hello");
  assert.equal(first.messages[0]?.["role"], "controller");
  await waitUntil(() => first.paints.length > 0, "the initial repaint");
  assert.equal(first.paints[0]?.["full"], true);

  first.socket.send(
    JSON.stringify({ type: "connect", host: `127.0.0.1:${host.port}` }),
  );
  await host.waitForConnection();
  await host.sendRecords(1);
  await waitUntil(
    () => first.grid.rowText(0).includes("_____"),
    "the host screen to arrive",
  );

  const second = await openViewer(
    `ws://127.0.0.1:${server.port}/ws/${created.id}`,
  );
  t.after(() => second.socket.close());
  await waitUntil(
    () => second.messages.some((m) => m["type"] === "waiting"),
    "the late viewer to be told to wait",
  );
  /** @returns {Record<string, unknown> | undefined} */
  const request = () => {
    const status = first.messages.findLast((m) => m["type"] === "status");
    const requests = /** @type {Record<string, unknown>[]} */ (
      status?.["requests"] ?? []
    );
    return requests[0];
  };
  await waitUntil(() => request() !== undefined, "the owner to be asked");
  assert.equal(request()?.["name"], "127.0.0.1", "no user, so the address");
  first.socket.send(
    JSON.stringify({
      type: "answer",
      viewer: request()?.["viewer"],
      allow: true,
    }),
  );
  await waitUntil(() => second.paints.length > 0, "the late viewer repaint");

  const hello = second.messages.find((m) => m["type"] === "hello");
  assert.equal(hello?.["role"], "observer");
  assert.equal(hello?.["owner"], false);
  assert.ok(
    second.grid.rowText(0).includes("_____"),
    "the late viewer must see the current screen",
  );

  second.socket.send(JSON.stringify({ type: "text", value: "x" }));
  await waitUntil(
    () => second.messages.some((m) => m["code"] === "E3006"),
    "the observer refusal",
  );

  second.socket.close();
  const again = await openViewer(
    `ws://127.0.0.1:${server.port}/ws/${created.id}?pass=${String(hello?.["pass"])}`,
  );
  t.after(() => again.socket.close());
  await waitUntil(
    () => again.messages.length > 0,
    "the guest's reload to be answered",
  );
  assert.equal(
    again.messages[0]?.["type"],
    "hello",
    "a guest let in once is let back in without asking",
  );
});

test("the server refuses an unknown session and a bad upgrade path", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  // Over the socket, as a browser cannot read an upgrade's 404.
  const missing = new WebSocket(
    `ws://127.0.0.1:${server.port}/ws/${"0".repeat(8)}-0000-0000-0000-000000000000`,
  );
  /** @type {unknown[]} */
  const said = [];
  missing.on("message", (data) => said.push(JSON.parse(String(data))));
  const reason = await new Promise((resolve) =>
    missing.once("close", (_code, why) => resolve(String(why))),
  );
  assert.equal(reason, "E3001");
  assert.deepEqual(said, [
    {
      type: "error",
      code: "E3001",
      message: "Session not found: 00000000-0000-0000-0000-000000000000",
    },
  ]);

  const wrong = new WebSocket(`ws://127.0.0.1:${server.port}/ws/nonsense`);
  await assert.rejects(
    new Promise((resolve, reject) => {
      wrong.once("open", resolve);
      wrong.once("error", reject);
    }),
    /404/,
  );
});

test("static files and the session list are served", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>TN3270 Terminal<\/title>/);

  const module = await fetch(`${base}/canvas.js`);
  assert.equal(module.status, 200);
  assert.equal(
    module.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );

  const list = await (await fetch(`${base}/api/sessions`)).json();
  assert.ok(Array.isArray(list.sessions));
});

test("the version endpoint names the commit the server runs", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const response = await fetch(`http://127.0.0.1:${server.port}/api/version`);
  assert.equal(response.status, 200);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert.deepEqual(await response.json(), { revision: head });
});

test("fonts are cached forever, and the page's own code is asked about on every load", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;

  const code = await fetch(`${base}/app.js`);
  assert.equal(code.status, 200);
  assert.equal(code.headers.get("cache-control"), "no-cache");
  const etag = code.headers.get("etag");
  assert.ok(etag !== null, "app.js has an etag to be asked about by");

  const unchanged = await fetch(`${base}/app.js`, {
    headers: { "if-none-match": etag },
  });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");

  const font = await fetch(`${base}/fonts/3270-Regular.woff2`);
  assert.equal(font.status, 200);
  assert.equal(
    font.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
});

test("the page's code goes compressed to a browser that takes it", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const source = readFileSync("public/app.js", "utf8");

  for (const encoding of ["br", "gzip"]) {
    const response = await fetch(`http://127.0.0.1:${server.port}/app.js`, {
      headers: { "accept-encoding": encoding },
    });
    assert.equal(response.headers.get("content-encoding"), encoding);
    assert.ok(
      Number(response.headers.get("content-length")) < source.length / 2,
      `${encoding} at least halves app.js`,
    );
    // fetch undoes the encoding, so this is what the browser ends up running.
    assert.equal(await response.text(), source);
  }

  const font = await fetch(
    `http://127.0.0.1:${server.port}/fonts/3270-Regular.woff2`,
    { headers: { "accept-encoding": "br" } },
  );
  assert.equal(font.headers.get("content-encoding"), null);
});

test("the page preloads every module it imports", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();

  /** @type {Set<string>} */
  const imported = new Set();
  /** @param {string} file @returns {void} */
  const walk = (file) => {
    if (imported.has(file)) return;
    imported.add(file);
    const source = readFileSync(`public/${file}`, "utf8");
    for (const [, target] of source.matchAll(/from "\.\/([\w.-]+)"/g))
      walk(String(target));
  };
  walk("app.js");

  for (const file of imported)
    assert.ok(
      html.includes(`<link rel="modulepreload" href="./${file}" />`),
      `${file} is imported but never preloaded — add it to public/index.html`,
    );
});

test("every font offered is served and has a face the page can load", async () => {
  const html = readFileSync("public/index.html", "utf8");
  const served = readdirSync("public/fonts").filter((f) =>
    f.endsWith(".woff2"),
  );
  const offered = FONTS.flatMap((font) =>
    font.file === undefined ? [] : [font.file],
  );

  assert.deepEqual([...offered].sort(), [...served].sort());
  for (const file of offered)
    assert.ok(
      html.includes(`url("./fonts/${file}")`),
      `${file} is offered but has no @font-face in public/index.html`,
    );
});

/**
 * What the server wrote into the page for this user.
 *
 * @param {string} html
 * @returns {unknown}
 */
function pageUserData(html) {
  const match =
    /<script type="application\/json" id="userdata">(.*?)<\/script>/s.exec(
      html,
    );
  assert.ok(match !== null, "the page carries the user's data");
  return JSON.parse(String(match[1]));
}

test("the page comes with the user's font, theme and settings in it", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;

  const first = await (await fetch(`${base}/`)).text();
  assert.match(first, /href="\.\/fonts\/FiraMono-Regular\.woff2"/);
  assert.deepEqual(pageUserData(first), {
    data: { settings: null, macros: null, keymap: null },
  });

  const theme = THEMES.find((entry) => entry.name !== DEFAULT_SETTINGS.theme);
  assert.ok(theme !== undefined);
  const settings = { font: "IBM 3270", theme: theme.name, model: 3 };
  await putUserData(server.port, "settings", settings);
  await putUserData(server.port, "keymap", { F1: "PF(1)" });
  await putUserData(server.port, "recordings", [{ name: "big" }]);

  const response = await fetch(`${base}/`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  const fonts = [...html.matchAll(/<link rel="preload" href="([^"]+)"/g)];
  assert.deepEqual(
    fonts.map((match) => match[1]),
    ["./fonts/3270-Regular.woff2"],
    "only the font in use is fetched before the page starts",
  );
  assert.ok(
    html.includes(
      `<style>body { background: ${theme.colors.background}; }</style>`,
    ),
  );
  // Recordings can be megabytes, so they are left to a request of their own.
  assert.deepEqual(pageUserData(html), {
    data: { settings, macros: null, keymap: { F1: "PF(1)" } },
  });
  const recordings = await fetch(`${base}/api/userdata/recordings`);
  assert.deepEqual(await recordings.json(), [{ name: "big" }]);
});

test("a macro cannot end the script element its page carries it in", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const macros = [{ name: "</script><script>alert(1)</script>", steps: [] }];
  await putUserData(server.port, "macros", macros);

  const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
  assert.ok(!html.includes("<script>alert(1)"));
  assert.deepEqual(
    /** @type {{ data: { macros: unknown } }} */ (pageUserData(html)).data
      .macros,
    macros,
  );
});

test("a session starts at the size it is asked for", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  /** @param {unknown} body */
  const create = (body) =>
    fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const sized = await create({ model: 2, oversize: "100x30" });
  assert.equal(sized.status, 201);
  const body = await sized.json();
  assert.deepEqual([body.cols, body.rows], [100, 30]);

  // Smaller than model 4's 43 rows: the emulator would refuse it.
  const misfit = await (await create({ model: 4, oversize: "80x30" })).json();
  assert.deepEqual([misfit.cols, misfit.rows], [80, 43]);

  const unasked = await (await create({})).json();
  assert.deepEqual([unasked.cols, unasked.rows], [80, 43]);

  for (const bad of [{ model: 9 }, { oversize: "huge" }, [2]]) {
    const refused = await create(bad);
    assert.equal(refused.status, 400, JSON.stringify(bad));
    assert.equal((await refused.json()).code, "E3017");
  }
});

test("a static file replaced by a deploy is served new, without a restart", async (t) => {
  const server = await startServer();
  const name = `.tmp-deploy-${server.port}.js`;
  t.after(async () => {
    await server.stop();
    await rm(`public/${name}`, { force: true });
  });
  const url = `http://127.0.0.1:${server.port}/${name}`;

  await writeFile(`public/${name}`, "export const version = 1;\n");
  const before = await fetch(url);
  assert.equal(await before.text(), "export const version = 1;\n");

  await writeFile(`public/${name}`, "export const version = 22;\n");
  const after = await fetch(url);
  assert.equal(await after.text(), "export const version = 22;\n");
});

test("a path that tries to escape the public directory is refused", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  // Percent-encoded, or fetch normalises the traversal away before the server sees it.
  for (const path of [
    "/%2e%2e%2fconfig.jsonc",
    "/fonts/%2e%2e%2f%2e%2e%2fconfig.jsonc",
  ]) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
    const body = await response.json();
    assert.equal(response.status, 404, `${path} must not be served`);
    assert.equal(body.code, "E6001");
  }
});

/**
 * @param {{ logFile: string }} server
 * @param {string} needle
 * @returns {Promise<string>}
 */
async function logLine(server, needle) {
  await waitUntil(
    () => readFileSync(server.logFile, "utf8").includes(needle),
    `"${needle}" in the log`,
  );
  const lines = readFileSync(server.logFile, "utf8").split("\n");
  return lines.find((line) => line.includes(needle)) ?? "";
}

/** What a proxy would set, and a direct client can just as easily claim. */
const PROXY_HEADERS = {
  "x-forwarded-for": "203.0.113.9, 10.0.0.1",
  "x-remote-user": "alice",
};

test("the log file names the session and the address every line came from", async (t) => {
  const server = await startServer("info");
  t.after(() => server.stop());

  const base = `http://127.0.0.1:${server.port}`;
  const created = await (
    await fetch(`${base}/api/sessions`, { method: "POST" })
  ).json();
  const viewer = await openViewer(
    `ws://127.0.0.1:${server.port}/ws/${created.id}`,
  );
  t.after(() => viewer.socket.close());
  await waitUntil(() => viewer.messages.length > 0, "the hello message");

  const attached = await logLine(server, "viewer attached");
  const started = await logLine(server, "starting emulator");

  assert.match(attached, new RegExp(`session=${created.id}\\b`));
  assert.match(attached, /ip=127\.0\.0\.1\b/);
  // Even the lines no browser caused say which session they belong to.
  assert.match(started, new RegExp(`session=${created.id}\\b`));
  // Nobody authenticated, so no user field at all rather than an empty one.
  assert.doesNotMatch(attached, /user=/);
});

test("a forwarded address and user are believed only when a proxy is configured", async (t) => {
  const server = await startServer("info", true);
  t.after(() => server.stop());

  const base = `http://127.0.0.1:${server.port}`;
  const created = await (
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: PROXY_HEADERS,
    })
  ).json();
  const viewer = await openViewer(
    `ws://127.0.0.1:${server.port}/ws/${created.id}`,
    PROXY_HEADERS,
  );
  t.after(() => viewer.socket.close());
  await waitUntil(() => viewer.messages.length > 0, "the hello message");

  const requested = await logLine(server, "request method=POST");
  const createdLine = await logLine(server, "session created");
  const attached = await logLine(server, "viewer attached");

  // The leftmost X-Forwarded-For entry is the browser, the rest are proxies.
  assert.match(requested, /ip=203\.0\.113\.9 user=alice/);
  assert.match(createdLine, /ip=203\.0\.113\.9 user=alice/);
  assert.match(attached, /ip=203\.0\.113\.9 user=alice/);
  const listed = await (await fetch(`${base}/api/sessions`)).json();
  const entry = listed.sessions.find(
    (/** @type {{ id: string }} */ session) => session.id === created.id,
  );
  assert.equal(entry.startedBy, "alice");
  assert.ok(Date.parse(entry.startedAt) <= Date.now());
});

test("a client claiming a forwarded address is logged as itself by default", async (t) => {
  const server = await startServer("info");
  t.after(() => server.stop());

  const base = `http://127.0.0.1:${server.port}`;
  const created = await (
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: PROXY_HEADERS,
    })
  ).json();

  const requested = await logLine(server, "request method=POST");
  assert.match(requested, /ip=127\.0\.0\.1\b/);
  assert.doesNotMatch(requested, /203\.0\.113\.9|alice/);
  const listed = await (await fetch(`${base}/api/sessions`)).json();
  const entry = listed.sessions.find(
    (/** @type {{ id: string }} */ session) => session.id === created.id,
  );
  assert.equal(entry.startedBy, "127.0.0.1");
});

test("only a session owner can terminate it", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const base = `http://127.0.0.1:${server.port}`;
  const created = await (
    await fetch(`${base}/api/sessions`, { method: "POST" })
  ).json();
  const owner = await openViewer(
    `ws://127.0.0.1:${server.port}/ws/${created.id}`,
  );
  t.after(() => owner.socket.close());
  await waitUntil(
    () => owner.messages.some((message) => message.type === "hello"),
    "the owner's hello",
  );
  const hello = owner.messages.find((message) => message.type === "hello");
  assert.ok(hello);
  assert.equal(typeof hello.pass, "string");
  const ownerPass = String(hello.pass);

  for (const pass of [undefined, "not-the-owner"]) {
    const response = await fetch(`${base}/api/sessions/${created.id}`, {
      method: "DELETE",
      headers: pass === undefined ? {} : { "x-session-pass": pass },
    });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.code, "E3014");
  }
  let listed = await (await fetch(`${base}/api/sessions`)).json();
  assert.ok(
    listed.sessions.some(
      (/** @type {{ id: string }} */ session) => session.id === created.id,
    ),
  );

  const closed = once(owner.socket, "close");
  const response = await fetch(`${base}/api/sessions/${created.id}`, {
    method: "DELETE",
    headers: { "x-session-pass": ownerPass },
  });
  assert.equal(response.status, 204);
  const [code, reason] = await closed;
  assert.equal(code, 4001);
  assert.equal(String(reason), "E3015");
  listed = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(
    listed.sessions.some(
      (/** @type {{ id: string }} */ session) => session.id === created.id,
    ),
    false,
  );
});

test("the owner logs on by hand through the logon endpoint, and the password is never logged", async (t) => {
  const host = await FakeHost.listen("test/traces/login.trc", 0, {
    tls: true,
  });
  const server = await startServer("debug", false, ":memory:", {
    emulator: { defaultHost: `127.0.0.1:${host.port}` },
    logon: { readyText: "Uzivatel (User)", doneText: "READY", timeoutMs: 5000 },
  });
  t.after(async () => {
    await host.close();
    await server.stop();
  });

  const base = `http://127.0.0.1:${server.port}`;
  const created = await (
    await fetch(`${base}/api/sessions`, { method: "POST" })
  ).json();
  const owner = await openViewer(
    `ws://127.0.0.1:${server.port}/ws/${created.id}`,
  );
  t.after(() => owner.socket.close());
  await waitUntil(
    () => owner.messages.some((message) => message.type === "hello"),
    "the owner's hello",
  );
  const ownerPass = String(
    owner.messages.find((message) => message.type === "hello")?.pass,
  );
  await host.waitForConnection();
  await host.sendRecords(1);

  const url = `${base}/api/sessions/${created.id}/logon`;
  /** @param {string} pass @param {string} body */
  const post = (pass, body) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-pass": pass },
      body,
    });

  let response = await post("not-the-owner", '{"user":"SIMON","password":"x"}');
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "E3019");
  response = await post(ownerPass, '{"user":"SIMON"}');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "E3025");

  const logon = post(ownerPass, '{"user":"SIMON","password":"hunter2"}');
  // "SIMON" and "hunter2" in EBCDIC.
  await host.waitUntil(
    () =>
      host.received.includes("e2c9d4d6d5") &&
      host.received.includes("88a495a38599f2"),
    5000,
    "the user and password to be typed",
  );
  host.socket?.write(Buffer.from("f5c3114040d9c5c1c4e8ffef", "hex"));
  response = await logon;
  assert.equal(response.status, 204);
  await waitUntil(
    () => owner.grid.rowText(0).startsWith("READY"),
    "the logged-on screen",
  );

  const log = readFileSync(server.logFile, "utf8");
  assert.match(log, /logon finished/);
  assert.doesNotMatch(log, /hunter2|68756e74657232|88a495a38599f2/);
});

test("an upgrade to a path that is not a session is refused with its own code", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}/ws/not-a-session`,
  );
  const body = await new Promise((resolve) => {
    socket.on("error", () => {});
    socket.on("unexpected-response", (_req, res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
  });

  assert.equal(body.status, 404);
  assert.match(body.text, /E6002/);
});

/**
 * @param {number} port
 * @param {string} key
 * @param {unknown} value
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Response>}
 */
function putUserData(port, key, value, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/api/userdata/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
}

/**
 * @param {number} port
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Record<string, unknown>>}
 */
async function getUserData(port, headers = {}) {
  /** @type {Record<string, unknown>} */
  const data = {};
  for (const key of ["settings", "macros", "keymap", "recordings"]) {
    /** @type {Response} */
    const response = await fetch(
      `http://127.0.0.1:${port}/api/userdata/${key}`,
      { headers },
    );
    assert.equal(response.status, 200);
    data[key] = await response.json();
  }
  return data;
}

test("user data saved through one server is read back through it", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  assert.deepEqual(await getUserData(server.port), {
    settings: null,
    macros: null,
    keymap: null,
    recordings: null,
  });

  const settings = { theme: "Solarized", fitFontSize: 20 };
  assert.equal(
    (await putUserData(server.port, "settings", settings)).status,
    204,
  );
  assert.equal((await putUserData(server.port, "macros", [])).status, 204);
  const replaced = { theme: "Mainframe" };
  assert.equal(
    (await putUserData(server.port, "settings", replaced)).status,
    204,
  );

  assert.deepEqual(await getUserData(server.port), {
    settings: replaced,
    macros: [],
    keymap: null,
    recordings: null,
  });
});

test("blue and green servers on one database file see each other's saves", async (t) => {
  const dataFile = `test/.tmp-userdata-shared-${process.pid}.sqlite`;
  const blue = await startServer("warn", false, dataFile);
  t.after(() => blue.stop());
  const green = await startServer("warn", false, dataFile);
  t.after(() => green.stop());
  t.after(async () => {
    for (const suffix of ["", "-wal", "-shm"])
      await rm(`${dataFile}${suffix}`, { force: true });
  });

  // Both writing at once is what a deploy's overlap looks like.
  const saves = [];
  for (let i = 0; i < 20; i++) {
    const server = i % 2 === 0 ? blue : green;
    saves.push(putUserData(server.port, "keymap", { n: String(i) }));
    saves.push(putUserData(server.port, "macros", [{ i }]));
  }
  for (const response of await Promise.all(saves))
    assert.equal(response.status, 204);

  assert.equal(
    (await putUserData(blue.port, "settings", { font: "IBM 3270" })).status,
    204,
  );
  const seenByGreen = await getUserData(green.port);
  assert.deepEqual(seenByGreen["settings"], { font: "IBM 3270" });
  assert.deepEqual(await getUserData(blue.port), seenByGreen);
});

test("user data is kept per user behind a proxy, and per address otherwise", async (t) => {
  const server = await startServer("info", true);
  t.after(() => server.stop());

  const alice = { "x-remote-user": "alice", "x-forwarded-for": "203.0.113.9" };
  const aliceElsewhere = {
    "x-remote-user": "alice",
    "x-forwarded-for": "198.51.100.7",
  };
  const bob = { "x-remote-user": "bob", "x-forwarded-for": "203.0.113.9" };
  const anonymous = { "x-forwarded-for": "203.0.113.9" };

  await putUserData(server.port, "settings", { theme: "alice" }, alice);
  await putUserData(server.port, "settings", { theme: "address" }, anonymous);

  assert.deepEqual(
    (await getUserData(server.port, aliceElsewhere))["settings"],
    {
      theme: "alice",
    },
  );
  assert.equal((await getUserData(server.port, bob))["settings"], null);
  assert.deepEqual((await getUserData(server.port, anonymous))["settings"], {
    theme: "address",
  });
  assert.match(
    await logLine(server, "user data saved"),
    /owner=user:alice key=settings/,
  );
});

test("user data with an unknown key or a broken body is refused with its own code", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const unknown = await putUserData(server.port, "passwords", {});
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "E8004");

  const unread = await fetch(
    `http://127.0.0.1:${server.port}/api/userdata/passwords`,
  );
  assert.equal(unread.status, 404);
  assert.equal((await unread.json()).code, "E8007");

  const broken = await fetch(
    `http://127.0.0.1:${server.port}/api/userdata/settings`,
    {
      method: "PUT",
      body: "{not json",
    },
  );
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).code, "E8006");

  const tooBig = await putUserData(
    server.port,
    "recordings",
    "x".repeat(33 * 1024 * 1024),
  );
  assert.equal(tooBig.status, 413);
  assert.equal((await tooBig.json()).code, "E8005");

  const recordings = await fetch(
    `http://127.0.0.1:${server.port}/api/userdata/recordings`,
  );
  assert.equal(await recordings.json(), null);
});
