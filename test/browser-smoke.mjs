import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "../vendor/ws.mjs";
import { FakeHost } from "./fakehost.js";
import { freePort, testConfig, waitUntil } from "./helpers.js";

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function startBrowser(t) {
  const host = await FakeHost.listen("test/traces/fields.trc", 0, {
    tls: true,
  });
  const serverPort = await freePort();
  const debugPort = await freePort();
  const temp = await mkdtemp(join(tmpdir(), "tn3270-browser-"));
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
  t.after(() => stopProcess(server));
  await waitUntil(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${serverPort}/api/sessions`)).ok;
    } catch {
      return false;
    }
  }, "the server to start");

  const browser = spawn(
    process.env.CHROMIUM ?? "chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${join(temp, "profile")}`,
      `--remote-debugging-port=${debugPort}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  /** @type {WebSocket | null} */
  let socket = null;
  t.after(async () => {
    socket?.close();
    await stopProcess(browser);
    await host.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 5 });
  });

  await waitUntil(async () => {
    try {
      const tabs = await (
        await fetch(`http://127.0.0.1:${debugPort}/json`)
      ).json();
      return tabs.some((tab) => tab.type === "page");
    } catch {
      return false;
    }
  }, "Chromium DevTools to start");
  const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const page = tabs.find((tab) => tab.type === "page");
  assert.ok(page);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, "open");

  let nextId = 0;
  const pending = new Map();
  /** @type {string[]} */
  const exceptions = [];
  /** @type {import('../server/protocol.js').ClientMessage[]} */
  const sentFrames = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === "Runtime.exceptionThrown")
      exceptions.push(message.params.exceptionDetails.text);
    if (message.method === "Network.webSocketFrameSent") {
      try {
        sentFrames.push(JSON.parse(message.params.response.payloadData));
      } catch {
        return;
      }
    }
    if (message.id === undefined) return;
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });

  const command = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const frame = (method, type, accept = () => true) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("message", received);
        reject(new Error(`timed out waiting for ${type}`));
      }, 10000);
      const received = (raw) => {
        const event = JSON.parse(String(raw));
        if (event.method !== method) return;
        let frame;
        try {
          frame = JSON.parse(event.params.response.payloadData);
        } catch {
          return;
        }
        const payload = (Array.isArray(frame) ? frame : [frame]).find(
          (message) => message.type === type && accept(message),
        );
        if (payload === undefined) return;
        clearTimeout(timer);
        socket.off("message", received);
        resolve(payload);
      };
      socket.on("message", received);
    });
  const event = (method, accept = () => true) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("message", received);
        reject(new Error(`timed out waiting for ${method}`));
      }, 10000);
      const received = (raw) => {
        const message = JSON.parse(String(raw));
        if (message.method !== method || !accept(message.params)) return;
        clearTimeout(timer);
        socket.off("message", received);
        resolve(message.params);
      };
      socket.on("message", received);
    });
  const consoleMessage = (code) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("message", received);
        reject(new Error(`timed out waiting for ${code}`));
      }, 10000);
      const received = (raw) => {
        const message = JSON.parse(String(raw));
        if (message.method !== "Runtime.consoleAPICalled") return;
        const value = message.params.args[0]?.value;
        if (typeof value !== "string" || !value.includes(code)) return;
        clearTimeout(timer);
        socket.off("message", received);
        resolve(value);
      };
      socket.on("message", received);
    });
  const key = async (name, code, options = {}) => {
    await command("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: name,
      code,
      ...options,
    });
    await command("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: name,
      code,
      ...options,
    });
  };

  await command("Network.enable");
  await command("Page.enable");
  await command("Runtime.enable");
  const hello = frame("Network.webSocketFrameReceived", "hello");
  const connected = frame(
    "Network.webSocketFrameReceived",
    "status",
    (status) => status.connected === true,
  );
  await command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/` });
  const firstHello = await hello;
  await host.waitForConnection();
  await host.sendRecords(1);
  await connected;
  const geometry = await command("Runtime.evaluate", {
    expression:
      "[document.querySelector('canvas').width, document.querySelector('canvas').height]",
    returnByValue: true,
  });
  assert.ok(geometry.result.result.value.every((size) => size > 0));
  const commandSocket = socket;

  return {
    command,
    commandSocket,
    frame,
    event,
    key,
    consoleMessage,
    firstHello,
    exceptions,
    sentFrames,
    server,
    base: `http://127.0.0.1:${serverPort}`,
  };
}

test("the browser types and stops a recording while host input is pending", async (t) => {
  const browser = await startBrowser(t);
  const sentText = browser.frame("Network.webSocketFrameSent", "text");
  await browser.key("a", "KeyA", { text: "a", windowsVirtualKeyCode: 65 });
  assert.equal((await sentText).value, "a");

  const recordStart = browser.frame(
    "Network.webSocketFrameSent",
    "recorder",
    (message) => message.action === "start",
  );
  await browser.key("e", "KeyE", {
    modifiers: 2,
    windowsVirtualKeyCode: 69,
  });
  await recordStart;
  await browser.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "b",
    code: "KeyB",
    text: "b",
    windowsVirtualKeyCode: 66,
  });
  const recordStopped = browser.frame(
    "Network.webSocketFrameReceived",
    "recorderStopped",
  );
  await browser.key("e", "KeyE", {
    modifiers: 2,
    windowsVirtualKeyCode: 69,
  });
  await recordStopped;
});

test("holding Ctrl+. repeats the last recording", async (t) => {
  const browser = await startBrowser(t);
  const controlE = { modifiers: 2, windowsVirtualKeyCode: 69 };
  const started = browser.frame(
    "Network.webSocketFrameSent",
    "recorder",
    (message) => message.action === "start",
  );
  await browser.key("e", "KeyE", controlE);
  await started;

  const recorded = browser.frame(
    "Network.webSocketFrameReceived",
    "recorderStep",
  );
  await browser.key("b", "KeyB", { text: "b", windowsVirtualKeyCode: 66 });
  await recorded;
  const stopped = browser.frame(
    "Network.webSocketFrameReceived",
    "recorderStopped",
  );
  await browser.key("e", "KeyE", controlE);
  await stopped;

  const controlPeriod = {
    key: ".",
    code: "Period",
    modifiers: 2,
    windowsVirtualKeyCode: 190,
  };
  const first = browser.frame("Network.webSocketFrameSent", "macro");
  await browser.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...controlPeriod,
  });
  assert.deepEqual(await first, {
    type: "macro",
    steps: [{ type: "text", value: "b" }],
  });

  const second = browser.frame("Network.webSocketFrameSent", "macro");
  await browser.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    autoRepeat: true,
    ...controlPeriod,
  });
  assert.deepEqual(await second, {
    type: "macro",
    steps: [{ type: "text", value: "b" }],
    repeat: true,
  });
  await browser.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...controlPeriod,
  });
});

test("left Ctrl tapped alone is Reset, but not when it held down Ctrl+C", async (t) => {
  const browser = await startBrowser(t);
  /** @param {string} code @param {() => Promise<void>} [between] */
  const tapControl = async (code, between) => {
    const init = {
      key: "Control",
      code,
      modifiers: 2,
      windowsVirtualKeyCode: 17,
    };
    await browser.command("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...init,
    });
    await between?.();
    await browser.command("Input.dispatchKeyEvent", {
      type: "keyUp",
      ...init,
      modifiers: 0,
    });
  };

  const reset = browser.frame("Network.webSocketFrameSent", "action");
  await tapControl("ControlLeft");
  assert.equal((await reset).action, "Reset");

  const next = browser.frame("Network.webSocketFrameSent", "action");
  await tapControl("ControlLeft", () =>
    browser.key("c", "KeyC", { modifiers: 2, windowsVirtualKeyCode: 67 }),
  );
  await tapControl("ControlRight");
  assert.equal((await next).action, "Enter", "Ctrl+C sent no Reset first");
});

test("screen-size changes keep the size dialog open", async (t) => {
  const browser = await startBrowser(t);
  await browser.key(",", "Comma", {
    modifiers: 1,
    windowsVirtualKeyCode: 188,
  });
  await browser.key("2", "Digit2", {
    text: "2",
    windowsVirtualKeyCode: 50,
  });
  await browser.key("Enter", "Enter", {
    modifiers: 2,
    windowsVirtualKeyCode: 13,
  });

  const changedModel = browser.frame("Network.webSocketFrameSent", "model");
  const disconnected = browser.frame(
    "Network.webSocketFrameReceived",
    "status",
    (message) => message.connected === false,
  );
  await browser.key("s", "KeyS", { text: "s", windowsVirtualKeyCode: 83 });
  await browser.key("Enter", "Enter", {
    modifiers: 2,
    windowsVirtualKeyCode: 13,
  });
  assert.equal((await changedModel).model, 2);
  await disconnected;

  const beforeBack = browser.sentFrames.length;
  await browser.key("F3", "F3", { windowsVirtualKeyCode: 114 });
  await browser.key("2", "Digit2", {
    text: "2",
    windowsVirtualKeyCode: 50,
  });
  await browser.key("Enter", "Enter", {
    modifiers: 2,
    windowsVirtualKeyCode: 13,
  });
  assert.equal(
    browser.sentFrames
      .slice(beforeBack)
      .some((message) => message.type === "text" || message.type === "action"),
    false,
  );
});

test("the browser opens a panel", async (t) => {
  const browser = await startBrowser(t);
  const before = (
    await browser.command("Page.captureScreenshot", { format: "png" })
  ).result.data;
  await browser.key("m", "KeyM", {
    modifiers: 2,
    windowsVirtualKeyCode: 77,
  });
  const after = (
    await browser.command("Page.captureScreenshot", { format: "png" })
  ).result.data;
  assert.notEqual(after, before);
  assert.deepEqual(browser.exceptions, []);
});

test("the session is restored after reload", async (t) => {
  const browser = await startBrowser(t);
  const reattached = browser.frame(
    "Network.webSocketFrameReceived",
    "hello",
    (message) => message.sessionId === browser.firstHello.sessionId,
  );
  await browser.command("Page.reload");
  await reattached;
  const afterReload = await browser.command("Runtime.evaluate", {
    expression: "location.hash",
    returnByValue: true,
  });
  assert.equal(
    afterReload.result.result.value,
    `#${browser.firstHello.sessionId}`,
  );
  assert.deepEqual(browser.exceptions, []);
});

test("a fresh page starts its session at the saved size, without resizing it", async (t) => {
  const browser = await startBrowser(t);
  for (const screenSize of ["model", "fit"]) {
    await fetch(`${browser.base}/api/userdata/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: 3, screenSize }),
    });
    const hello = browser.frame("Network.webSocketFrameReceived", "hello");
    const sentBefore = browser.sentFrames.length;
    await browser.command("Page.navigate", { url: `${browser.base}/` });
    const started = await hello;

    // The page answers hello with any resize it wants before this returns.
    await browser.command("Runtime.evaluate", { expression: "0" });

    assert.equal(started.model, 3, screenSize);
    assert.ok(started.rows >= 32, `${screenSize}: ${started.rows} rows`);
    const resizes = browser.sentFrames
      .slice(sentBefore)
      .filter((sent) => sent.type === "model" || sent.type === "oversize");
    assert.deepEqual(resizes, [], `${screenSize} asked for no resize`);
  }
  assert.deepEqual(browser.exceptions, []);
});

test("every vendored font loads in a real browser", async (t) => {
  const browser = await startBrowser(t);
  const loaded = await browser.command("Runtime.evaluate", {
    expression: `Promise.all([...document.fonts].map((face) =>
      face.load().then(() => face.family, () => "broken: " + face.family)))`,
    awaitPromise: true,
    returnByValue: true,
  });
  const { FONTS } = await import("../public/settings.js");
  const vendored = FONTS.filter((font) => font.name !== "System monospace");
  assert.deepEqual(
    [...loaded.result.result.value].sort(),
    vendored.map((font) => font.name).sort(),
  );
});

test("a server disconnect is reported clearly", async (t) => {
  const browser = await startBrowser(t);
  const disconnected = browser.consoleMessage("[E5002]");
  await stopProcess(browser.server);
  assert.match(await disconnected, /Connection to server lost\. Reconnecting/);
  assert.deepEqual(browser.exceptions, []);
});

test("a tab coming back into view retries without waiting out the backoff", async (t) => {
  const browser = await startBrowser(t);
  const disconnected = browser.consoleMessage("[E5002]");
  await stopProcess(browser.server);
  await disconnected;
  const retried = browser.consoleMessage("tab visible, retrying now");
  await browser.command("Runtime.evaluate", {
    expression: "document.dispatchEvent(new Event('visibilitychange'))",
  });
  await retried;
  assert.deepEqual(browser.exceptions, []);
});

test("the owner can kill their session from the Sessions panel", async (t) => {
  const browser = await startBrowser(t);
  await browser.key(",", "Comma", {
    modifiers: 1,
    windowsVirtualKeyCode: 188,
  });
  await browser.key("7", "Digit7", {
    text: "7",
    windowsVirtualKeyCode: 55,
  });
  const sessionsLoaded = browser.event(
    "Network.responseReceived",
    ({ response }) => response.url.endsWith("/api/sessions"),
  );
  await browser.key("Enter", "Enter", {
    modifiers: 2,
    windowsVirtualKeyCode: 13,
  });
  const response = await sessionsLoaded;
  await browser.event(
    "Network.loadingFinished",
    ({ requestId }) => requestId === response.requestId,
  );
  await browser.command("Runtime.evaluate", {
    expression:
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  });

  const terminated = browser.consoleMessage("[E3015]");
  await browser.key("Tab", "Tab", { windowsVirtualKeyCode: 9 });
  await browser.key("k", "KeyK", {
    text: "k",
    windowsVirtualKeyCode: 75,
  });
  await browser.key("Enter", "Enter", {
    modifiers: 2,
    windowsVirtualKeyCode: 13,
  });
  assert.match(await terminated, /terminated by its owner/);

  const listed = await (await fetch(`${browser.base}/api/sessions`)).json();
  assert.equal(
    listed.sessions.some(
      (session) => session.id === browser.firstHello.sessionId,
    ),
    false,
  );
  assert.deepEqual(browser.exceptions, []);
});

test("joining from Sessions with E asks the owner for editing rights", async (t) => {
  const browser = await startBrowser(t);
  await browser.key(",", "Comma", {
    modifiers: 1,
    windowsVirtualKeyCode: 188,
  });
  await browser.key("7", "Digit7", {
    text: "7",
    windowsVirtualKeyCode: 55,
  });
  const sessionsLoaded = browser.event(
    "Network.responseReceived",
    ({ response }) => response.url.endsWith("/api/sessions"),
  );
  await browser.key("Enter", "Enter", {
    modifiers: 2,
    windowsVirtualKeyCode: 13,
  });
  const response = await sessionsLoaded;
  await browser.event(
    "Network.loadingFinished",
    ({ requestId }) => requestId === response.requestId,
  );
  await browser.command("Runtime.evaluate", {
    expression:
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  });

  const watchRequested = browser.frame(
    "Network.webSocketFrameReceived",
    "status",
    (message) => message.requests?.some((request) => request.kind === "watch"),
  );
  await browser.key("Tab", "Tab", { windowsVirtualKeyCode: 9 });
  await browser.key("e", "KeyE", { text: "e", windowsVirtualKeyCode: 69 });
  await browser.key("Enter", "Enter", {
    modifiers: 2,
    windowsVirtualKeyCode: 13,
  });
  await watchRequested;

  const editRequested = browser.frame(
    "Network.webSocketFrameReceived",
    "status",
    (message) => message.requests?.some((request) => request.kind === "edit"),
  );
  await browser.key("y", "KeyY", { modifiers: 2, windowsVirtualKeyCode: 89 });
  await editRequested;

  const editor = browser.frame(
    "Network.webSocketFrameReceived",
    "status",
    (message) => message.editor !== null,
  );
  await browser.key("y", "KeyY", { modifiers: 2, windowsVirtualKeyCode: 89 });
  assert.ok((await editor).editor);
  assert.deepEqual(browser.exceptions, []);
});

test("clicking a URL on the host screen opens a new tab", async (t) => {
  const browser = await startBrowser(t);
  const url = "http://localhost";
  for (const character of url.slice(0, -1))
    await browser.key(character, "KeyA", { text: character });
  const painted = browser.frame("Network.webSocketFrameReceived", "paint");
  await browser.key(url.at(-1), "KeyA", { text: url.at(-1) });
  await painted;

  const position = await browser.command("Runtime.evaluate", {
    expression: `(() => {
      const canvas = document.querySelector("canvas");
      const metrics = canvas.getContext("2d").measureText("M");
      const width = Math.ceil(metrics.width);
      const height = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) + 2;
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + (rect.width - 80 * width) / 2 + 12 * width,
        y: rect.top + (rect.height - 44 * height) / 2 + 2.5 * height,
      };
    })()`,
    returnByValue: true,
  });
  const { x, y } = position.result.result.value;
  await browser.command("Target.setDiscoverTargets", { discover: true });
  const opened = browser.event(
    "Target.targetCreated",
    ({ targetInfo }) =>
      targetInfo.type === "page" && targetInfo.url !== browser.base + "/",
  );
  const navigated = browser.event(
    "Target.targetInfoChanged",
    ({ targetInfo }) => targetInfo.url === "http://localhost/",
  );
  await browser.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await browser.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  assert.ok((await opened).targetInfo);
  assert.equal((await navigated).targetInfo.url, "http://localhost/");
  assert.deepEqual(browser.exceptions, []);
});
