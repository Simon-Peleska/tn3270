import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFile, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { WebSocket } from "ws";
import { FakeHost } from "./fakehost.js";
import { testConfig, waitUntil } from "./helpers.js";
import { Grid } from "../public/grid.js";

/** @returns {Promise<number>} a port that was free a moment ago */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * @param {'debug' | 'info' | 'warn' | 'error'} [logLevel]
 * @param {boolean} [trustProxyHeaders]
 * @returns {Promise<{ port: number, logFile: string, stop: () => Promise<void> }>}
 */
async function startServer(logLevel = "warn", trustProxyHeaders = false) {
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
    const message = JSON.parse(String(data));
    messages.push(message);
    if (message["type"] !== "paint") return;
    paints.push(message);
    grid.applyPaint(message);
  });

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, messages, paints, grid };
}

test("two browsers share one session over the real server", async (t) => {
  const server = await startServer();
  const host = await FakeHost.listen("test/traces/reverse.trc", 0);
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

  const missing = new WebSocket(
    `ws://127.0.0.1:${server.port}/ws/${"0".repeat(8)}-0000-0000-0000-000000000000`,
  );
  await assert.rejects(
    new Promise((resolve, reject) => {
      missing.once("open", resolve);
      missing.once("error", reject);
    }),
    /404/,
  );

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

test("fonts are cached forever, and the page's own code never", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;

  const code = await fetch(`${base}/app.js`);
  assert.equal(code.status, 200);
  assert.equal(code.headers.get("cache-control"), null);
  assert.equal(await code.text(), readFileSync("public/app.js", "utf8"));

  const font = await fetch(`${base}/fonts/3270-Regular.ttf`);
  assert.equal(font.status, 200);
  assert.equal(
    font.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
});

test("the page preloads every module it imports, and every font", async (t) => {
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

  for (const font of readdirSync("public/fonts").filter((f) =>
    f.endsWith(".ttf"),
  ))
    assert.ok(
      html.includes(`href="./fonts/${font}"`),
      `${font} is served but never preloaded`,
    );
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
  const spawned = await logLine(server, "spawning");

  assert.match(attached, new RegExp(`session=${created.id}\\b`));
  assert.match(attached, /ip=127\.0\.0\.1\b/);
  // Even the lines no browser caused say which session they belong to.
  assert.match(spawned, new RegExp(`session=${created.id}\\b`));
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
});

test("a client claiming a forwarded address is logged as itself by default", async (t) => {
  const server = await startServer("info");
  t.after(() => server.stop());

  const base = `http://127.0.0.1:${server.port}`;
  await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: PROXY_HEADERS,
  });

  const requested = await logLine(server, "request method=POST");
  assert.match(requested, /ip=127\.0\.0\.1\b/);
  assert.doesNotMatch(requested, /203\.0\.113\.9|alice/);
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
