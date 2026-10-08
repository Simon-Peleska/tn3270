import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHost } from "./fakehost.js";
import { freePort, testConfig, waitUntil } from "./helpers.js";

/** @param {import('node:child_process').ChildProcess} child */
async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

/**
 * Runs in the page once it is up. Every frame the page sends is kept, so a test
 * can wait for one; the app's own socket is patched through its prototype.
 * Errors the app shows are kept too, since each one is also logged.
 */
const WATCH_PAGE = `
  window.sentFrames = [];
  window.frameWaiters = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    const frame = JSON.parse(String(data));
    window.sentFrames.push(frame);
    for (const waiter of window.frameWaiters.splice(0)) waiter();
    return send.call(this, data);
  };
  window.pageErrors = [];
  const error = console.error;
  console.error = (...args) => {
    window.pageErrors.push(args.map(String).join(" "));
    error(...args);
  };
  window.addEventListener("error", (event) => window.pageErrors.push(event.message));
  window.clipboardReads = 0;
  const readText = navigator.clipboard.readText.bind(navigator.clipboard);
  navigator.clipboard.readText = () => {
    window.clipboardReads++;
    return readText();
  };
  document.getElementById("screen").focus();
`;

/** WebDriver's names for the keys that print nothing. */
const CONTROL = "";
const SHIFT = "";
const INSERT = "";

/**
 * The app on a fake host, in a headless Firefox driven by geckodriver.
 *
 * @param {import('node:test').TestContext} t
 */
async function startFirefox(t) {
  const host = await FakeHost.listen("test/traces/fields.trc", 0, {
    tls: true,
  });
  const serverPort = await freePort();
  const driverPort = await freePort();
  const temp = await mkdtemp(join(tmpdir(), "tn3270-firefox-"));
  const configFile = join(temp, "config.json");
  await writeFile(
    configFile,
    JSON.stringify(
      testConfig({
        server: { host: "127.0.0.1", port: serverPort },
        emulator: { defaultHost: `127.0.0.1:${host.port}` },
        logFile: "",
      }),
    ),
  );
  const server = spawn(process.execPath, ["server/main.js"], {
    env: { ...process.env, TN3270_CONFIG: configFile },
    stdio: "ignore",
  });
  const driver = spawn(
    process.env.GECKODRIVER ?? "geckodriver",
    [`--port=${driverPort}`, `--binary=${process.env.FIREFOX ?? "firefox"}`],
    { stdio: "ignore" },
  );
  const base = `http://127.0.0.1:${driverPort}`;
  /** @type {string | null} */
  let sessionId = null;

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    if (json.value?.error)
      throw new Error(
        `WebDriver ${method} ${path}: ${JSON.stringify(json.value)}`,
      );
    return json.value;
  };

  t.after(async () => {
    if (sessionId !== null)
      await call("DELETE", `/session/${sessionId}`).catch(() => {});
    await stopProcess(driver);
    await stopProcess(server);
    await host.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 5 });
  });

  await waitUntil(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${serverPort}/api/sessions`)).ok;
    } catch {
      return false;
    }
  }, "the server to start");
  await waitUntil(async () => {
    try {
      return (await fetch(`${base}/status`)).ok;
    } catch {
      return false;
    }
  }, "geckodriver to start");

  const session = await call("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        timeouts: { script: 10000 },
        "moz:firefoxOptions": {
          args: ["-headless"],
          // Clipboard reads and writes without Firefox's paste prompt, which
          // nothing could press here.
          prefs: { "dom.events.testing.asyncClipboard": true },
        },
      },
    },
  });
  sessionId = session.sessionId;
  const path = `/session/${sessionId}`;

  /** @param {string} script @returns {Promise<any>} */
  const run = (script) =>
    call("POST", `${path}/execute/sync`, { script, args: [] });
  /** @param {string} script the body of an async function @returns {Promise<any>} */
  const runAsync = (script) =>
    call("POST", `${path}/execute/async`, {
      script: `const done = arguments[0];
        (async () => { ${script} })().then(done, (error) => done({ error: String(error) }));`,
      args: [],
    });
  /** @param {object[]} actions */
  const keys = (actions) =>
    call("POST", `${path}/actions`, {
      actions: [{ type: "key", id: "keyboard", actions }],
    });
  /** @param {number} button 0 left, 1 middle, 2 right */
  const click = async (button) => {
    const canvas = await call("POST", `${path}/element`, {
      using: "css selector",
      value: "canvas",
    });
    await call("POST", `${path}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", origin: canvas, x: 0, y: 0 },
            { type: "pointerDown", button },
            { type: "pointerUp", button },
          ],
        },
      ],
    });
  };
  /**
   * @param {(frame: any) => boolean} accept as source, run in the page
   * @param {number} [count] how many it must have accepted
   * @returns {Promise<any>} the last of those
   */
  const sentFrame = (accept, count = 1) =>
    runAsync(`
      const accept = ${accept.toString()};
      while (window.sentFrames.filter(accept).length < ${count})
        await new Promise((resolve) => window.frameWaiters.push(resolve));
      return window.sentFrames.filter(accept)[${count - 1}];
    `).catch((cause) => {
      throw new Error(`timed out waiting for frame ${count} that ${accept}`, {
        cause,
      });
    });

  await call("POST", `${path}/url`, { url: `http://127.0.0.1:${serverPort}/` });
  await host.waitForConnection();
  await host.sendRecords(1);
  await run(WATCH_PAGE);
  return { run, runAsync, keys, click, sentFrame };
}

test("Firefox types into the host", async (t) => {
  const firefox = await startFirefox(t);
  await firefox.keys([
    { type: "keyDown", value: "a" },
    { type: "keyUp", value: "a" },
  ]);
  const typed = await firefox.sentFrame((frame) => frame.type === "text");
  assert.equal(typed.value, "a");
  assert.deepEqual(await firefox.run("return window.pageErrors"), []);
});

test("Firefox pastes on Ctrl+V and Shift+Insert without reading the clipboard itself", async (t) => {
  const firefox = await startFirefox(t);
  await firefox.runAsync("await navigator.clipboard.writeText('pasted')");

  await firefox.keys([
    { type: "keyDown", value: CONTROL },
    { type: "keyDown", value: "v" },
    { type: "keyUp", value: "v" },
    { type: "keyUp", value: CONTROL },
  ]);
  const first = await firefox.sentFrame((frame) => frame.type === "paste");
  assert.equal(first.text, "pasted");

  await firefox.keys([
    { type: "keyDown", value: SHIFT },
    { type: "keyDown", value: INSERT },
    { type: "keyUp", value: INSERT },
    { type: "keyUp", value: SHIFT },
  ]);
  const second = await firefox.sentFrame((frame) => frame.type === "paste", 2);
  assert.equal(second.text, "pasted");

  assert.equal(await firefox.run("return window.clipboardReads"), 0);
  assert.equal(await firefox.run("return document.activeElement.id"), "screen");
  assert.deepEqual(await firefox.run("return window.pageErrors"), []);
});

test("a middle click in Firefox moves the cursor and, with nothing selected, pastes the clipboard", async (t) => {
  const firefox = await startFirefox(t);
  await firefox.runAsync("await navigator.clipboard.writeText('pasted')");

  await firefox.click(1);
  const moved = await firefox.sentFrame(
    (frame) => frame.type === "action" && frame.action === "MoveCursor1",
  );
  assert.ok(moved);
  const pasted = await firefox.sentFrame((frame) => frame.type === "paste");
  assert.equal(pasted.text, "pasted");
  assert.equal(await firefox.run("return window.clipboardReads"), 1);
  assert.deepEqual(await firefox.run("return window.pageErrors"), []);
});
