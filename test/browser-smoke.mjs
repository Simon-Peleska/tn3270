import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import { FakeHost } from "./fakehost.js";
import { testConfig, waitUntil } from "./helpers.js";

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

test("a real browser types, opens a panel, switches sessions, and reloads", async (t) => {
  const host = await FakeHost.listen("test/traces/fields.trc", 0);

  const serverPort = await freePort();
  const debugPort = await freePort();
  const temp = await mkdtemp(join(tmpdir(), "tn3270-browser-"));
  const configFile = join(temp, "config.json");
  await writeFile(
    configFile,
    JSON.stringify(
      testConfig({
        server: { host: "127.0.0.1", port: serverPort },
        b3270: {
          path: "b3270",
          model: 4,
          defaultHost: `127.0.0.1:${host.port}`,
        },
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
  t.after(async () => {
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
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  t.after(() => socket.close());
  await once(socket, "open");

  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
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
        let payload;
        try {
          payload = JSON.parse(event.params.response.payloadData);
        } catch {
          return;
        }
        if (payload.type !== type || !accept(payload)) return;
        clearTimeout(timer);
        socket.off("message", received);
        resolve(payload);
      };
      socket.on("message", received);
    });

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
  assert.equal(firstHello.type, "hello");
  await host.waitForConnection();
  await host.sendRecords(1);
  await connected;
  const geometry = await command("Runtime.evaluate", {
    expression:
      "[document.querySelector('canvas').width, document.querySelector('canvas').height]",
    returnByValue: true,
  });
  assert.ok(geometry.result.result.value.every((size) => size > 0));

  const sentText = frame("Network.webSocketFrameSent", "text");
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    text: "a",
    windowsVirtualKeyCode: 65,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });
  assert.equal((await sentText).value, "a");

  const recordStart = frame(
    "Network.webSocketFrameSent",
    "recorder",
    (message) => message.action === "start",
  );
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "e",
    code: "KeyE",
    modifiers: 2,
    windowsVirtualKeyCode: 69,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "e",
    code: "KeyE",
    modifiers: 2,
    windowsVirtualKeyCode: 69,
  });
  await recordStart;
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "b",
    code: "KeyB",
    text: "b",
    windowsVirtualKeyCode: 66,
  });
  const recordStopped = frame(
    "Network.webSocketFrameReceived",
    "recorderStopped",
  );
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "e",
    code: "KeyE",
    modifiers: 2,
    windowsVirtualKeyCode: 69,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "e",
    code: "KeyE",
    modifiers: 2,
    windowsVirtualKeyCode: 69,
  });
  await recordStopped;

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
  await key(",", "Comma", { modifiers: 1, windowsVirtualKeyCode: 188 });
  await key("2", "Digit2", { text: "2", windowsVirtualKeyCode: 50 });
  await key("Enter", "Enter", { modifiers: 2, windowsVirtualKeyCode: 13 });
  const changedModel = frame("Network.webSocketFrameSent", "model");
  const disconnectedForSize = frame(
    "Network.webSocketFrameReceived",
    "status",
    (message) => message.connected === false,
  );
  await key("s", "KeyS", { text: "s", windowsVirtualKeyCode: 83 });
  await key("Enter", "Enter", { modifiers: 2, windowsVirtualKeyCode: 13 });
  assert.equal((await changedModel).model, 2);
  await disconnectedForSize;
  const beforeBack = sentFrames.length;
  await key("F3", "F3", { windowsVirtualKeyCode: 114 });
  await key("2", "Digit2", { text: "2", windowsVirtualKeyCode: 50 });
  await key("Enter", "Enter", { modifiers: 2, windowsVirtualKeyCode: 13 });
  assert.equal(
    sentFrames
      .slice(beforeBack)
      .some((message) => message.type === "text" || message.type === "action"),
    false,
  );
  await key("F3", "F3", { windowsVirtualKeyCode: 114 });
  await key("F3", "F3", { windowsVirtualKeyCode: 114 });

  const before = (await command("Page.captureScreenshot", { format: "png" }))
    .result.data;
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: " ",
    code: "Space",
    text: " ",
    modifiers: 1,
    windowsVirtualKeyCode: 32,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: " ",
    code: "Space",
    modifiers: 1,
    windowsVirtualKeyCode: 32,
  });
  const after = (await command("Page.captureScreenshot", { format: "png" }))
    .result.data;
  assert.notEqual(after, before);

  const secondHello = frame(
    "Network.webSocketFrameReceived",
    "hello",
    (message) => message.sessionId !== firstHello.sessionId,
  );
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "b",
    code: "KeyB",
    modifiers: 2,
    windowsVirtualKeyCode: 66,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "b",
    code: "KeyB",
    modifiers: 2,
    windowsVirtualKeyCode: 66,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "2",
    code: "Digit2",
    text: "2",
    windowsVirtualKeyCode: 50,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "2",
    code: "Digit2",
    windowsVirtualKeyCode: 50,
  });
  assert.notEqual((await secondHello).sessionId, firstHello.sessionId);

  const beforeReload = await command("Runtime.evaluate", {
    expression: "location.hash",
    returnByValue: true,
  });
  const reattached = frame(
    "Network.webSocketFrameReceived",
    "hello",
    (message) => message.sessionId === firstHello.sessionId,
  );
  await command("Page.reload");
  await reattached;
  const afterReload = await command("Runtime.evaluate", {
    expression: "location.hash",
    returnByValue: true,
  });
  assert.equal(
    afterReload.result.result.value,
    beforeReload.result.result.value,
  );
  assert.deepEqual(exceptions, []);
});
