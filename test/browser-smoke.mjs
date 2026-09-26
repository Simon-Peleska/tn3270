import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function startBrowser(t) {
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
    key,
    firstHello,
    exceptions,
    sentFrames,
    server,
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

test("sessions can be switched and restored after reload", async (t) => {
  const browser = await startBrowser(t);
  const secondHello = browser.frame(
    "Network.webSocketFrameReceived",
    "hello",
    (message) => message.sessionId !== browser.firstHello.sessionId,
  );
  await browser.key("b", "KeyB", {
    modifiers: 2,
    windowsVirtualKeyCode: 66,
  });
  await browser.key("2", "Digit2", {
    text: "2",
    windowsVirtualKeyCode: 50,
  });
  assert.notEqual((await secondHello).sessionId, browser.firstHello.sessionId);

  const beforeReload = await browser.command("Runtime.evaluate", {
    expression: "location.hash",
    returnByValue: true,
  });
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
    beforeReload.result.result.value,
  );
  assert.deepEqual(browser.exceptions, []);
});

test("a server disconnect is reported clearly", async (t) => {
  const browser = await startBrowser(t);
  const disconnected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browser.commandSocket.off("message", received);
      reject(new Error("timed out waiting for the disconnect message"));
    }, 10000);
    const received = (raw) => {
      const event = JSON.parse(String(raw));
      if (event.method !== "Runtime.consoleAPICalled") return;
      const message = event.params.args[0]?.value;
      if (typeof message !== "string" || !message.includes("[E5002]")) return;
      clearTimeout(timer);
      browser.commandSocket.off("message", received);
      resolve(message);
    };
    browser.commandSocket.on("message", received);
  });
  await stopProcess(browser.server);
  assert.match(await disconnected, /Connection to server lost\. Reconnecting/);
  assert.deepEqual(browser.exceptions, []);
});
