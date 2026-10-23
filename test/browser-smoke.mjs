import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "../vendor/ws.mjs";
import { FakeHost, sharedPort } from "./fakehost.js";
import { freePort, testConfig, waitUntil } from "./helpers.js";
import {
  CLOSE,
  GET,
  UNFORMATTED,
  insert,
  message,
  open,
} from "../3270/test/indfile.js";

const PRINTER_TRACE = "3270/test/fixtures/printer/smoke.trc";

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function startBrowser(t, { printer = false } = {}) {
  const host = await FakeHost.listen(
    printer ? "test/traces/lu.trc" : "test/traces/fields.trc",
    0,
    { tls: true },
  );
  const printerHost = printer
    ? await FakeHost.listen(PRINTER_TRACE, 0, { tls: true })
    : null;
  const shared = printerHost
    ? await sharedPort([host.port, printerHost.port])
    : null;
  const serverPort = await freePort();
  const debugPort = await freePort();
  const temp = await mkdtemp(join(tmpdir(), "tn3270-browser-"));
  const configFile = join(temp, "config.json");
  await writeFile(
    configFile,
    JSON.stringify(
      testConfig({
        server: { host: "127.0.0.1", port: serverPort },
        emulator: {
          defaultHost: `127.0.0.1:${shared?.port ?? host.port}`,
          settings: printer ? { printerLu: "." } : {},
        },
        logFile: "",
      }),
    ),
  );
  const server = spawn(process.execPath, ["server/main.js"], {
    env: { ...process.env, TN3270_CONFIG: configFile, PRINTER_DELAY_MS: "1" },
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
    shared?.close();
    await printerHost?.close();
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
  const connected = frame(
    "Network.webSocketFrameReceived",
    "status",
    (status) => status.connected === true,
  );
  await command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/` });
  await host.waitForConnection();
  await host.sendRecords(1);
  await connected;
  const geometry = await command("Runtime.evaluate", {
    expression:
      "[document.querySelector('canvas').width, document.querySelector('canvas').height]",
    returnByValue: true,
  });
  assert.ok(geometry.result.result.value.every((size) => size > 0));
  const hash = await command("Runtime.evaluate", {
    expression: "location.hash.slice(1)",
    returnByValue: true,
  });
  const sessionId = hash.result.result.value;
  const commandSocket = socket;

  return {
    command,
    commandSocket,
    frame,
    event,
    key,
    consoleMessage,
    sessionId,
    exceptions,
    sentFrames,
    server,
    host,
    printerHost,
    temp,
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

/** @param {Awaited<ReturnType<typeof startBrowser>>} browser */
async function waitForAmber(browser) {
  await waitUntil(async () => {
    const background = await browser.command("Runtime.evaluate", {
      expression: "document.getElementById('screen').style.background",
      returnByValue: true,
    });
    // #100c00, the Amber theme's background.
    return background.result.result.value === "rgb(16, 12, 0)";
  }, "the Amber theme to be applied");
}

test("a theme saved in another tab is shown here without a reload", async (t) => {
  const browser = await startBrowser(t);
  const heard = browser.consoleMessage("another tab saved");
  const response = await fetch(`${browser.base}/api/userdata/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-tab": "elsewhere" },
    body: JSON.stringify({ theme: "Amber" }),
  });
  assert.equal(response.status, 204);
  await heard;
  await waitForAmber(browser);
  assert.deepEqual(browser.exceptions, []);
});

test("a theme saved while the tab heard nothing is shown on focus", async (t) => {
  const browser = await startBrowser(t);
  // Saved as this very tab, so the server tells it nothing.
  const tab = await browser.command("Runtime.evaluate", {
    expression: "import('./store.js').then((store) => store.TAB_ID)",
    awaitPromise: true,
    returnByValue: true,
  });
  const response = await fetch(`${browser.base}/api/userdata/settings`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-tab": tab.result.result.value,
    },
    body: JSON.stringify({ theme: "Amber" }),
  });
  assert.equal(response.status, 204);

  const changed = browser.consoleMessage("user data changed elsewhere");
  await browser.command("Runtime.evaluate", {
    expression: "window.dispatchEvent(new Event('focus'))",
  });
  await changed;
  await waitForAmber(browser);
  assert.deepEqual(browser.exceptions, []);
});

/**
 * @param {Awaited<ReturnType<typeof startBrowser>>} browser
 * @param {'left' | 'middle' | 'right'} button
 */
async function clickScreenMiddle(browser, button) {
  const center = await browser.command("Runtime.evaluate", {
    expression: `(() => {
      const rect = document.querySelector("canvas").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
    returnByValue: true,
  });
  const { x, y } = center.result.result.value;
  for (const type of ["mousePressed", "mouseReleased"])
    await browser.command("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button,
      clickCount: 1,
    });
  return { x, y };
}

test("a right click and a wheel turn sideways move the cursor and run what they are bound to", async (t) => {
  const browser = await startBrowser(t);
  const changed = browser.consoleMessage("user data changed elsewhere");
  const response = await fetch(`${browser.base}/api/userdata/keymap`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-tab": "elsewhere" },
    body: JSON.stringify({
      Enter: [{ key: "RightClick", shift: false, ctrl: false, alt: false }],
      PF8: [{ key: "WheelRight", shift: false, ctrl: false, alt: false }],
    }),
  });
  assert.equal(response.status, 204);
  await changed;

  const moved = browser.frame(
    "Network.webSocketFrameSent",
    "action",
    (message) => message.action === "MoveCursor1",
  );
  const entered = browser.frame(
    "Network.webSocketFrameSent",
    "action",
    (message) => message.action === "Enter",
  );
  const { x, y } = await clickScreenMiddle(browser, "right");
  await moved;
  await entered;
  const actions = browser.sentFrames
    .filter((message) => message.type === "action")
    .map((message) => message.action);
  assert.ok(
    actions.indexOf("MoveCursor1") < actions.indexOf("Enter"),
    "the cursor moves before Enter is sent",
  );

  const paged = browser.frame(
    "Network.webSocketFrameSent",
    "action",
    (message) => message.action === "PF" && message.args[0] === "8",
  );
  await browser.command("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: 120,
    deltaY: 0,
  });
  await paged;
  assert.deepEqual(browser.exceptions, []);
});

test("Ctrl+C copies the selection and lets go of it, as Ctrl+X does", async (t) => {
  const browser = await startBrowser(t);
  await browser.command("Browser.grantPermissions", {
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    origin: browser.base,
  });
  await browser.command("Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
  await browser.command("Runtime.evaluate", {
    expression: `window.copies = [];
    navigator.clipboard.writeText = async (text) => {
      window.copies.push(text);
      console.info("copied");
    };`,
  });
  const box = await browser.command("Runtime.evaluate", {
    expression: `(() => {
      const rect = document.querySelector("#pane-1").getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`,
    returnByValue: true,
  });
  const { left, top, width, height } = box.result.result.value;
  const [x, y] = [left + width * 0.05, top + height * 0.05];
  const [toX, toY] = [left + width * 0.95, top + height * 0.6];
  await browser.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await browser.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: toX,
    y: toY,
    button: "left",
    buttons: 1,
  });
  await browser.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: toX,
    y: toY,
    button: "left",
    clickCount: 1,
  });

  /** @returns {Promise<string[]>} */
  const copies = async () =>
    (
      await browser.command("Runtime.evaluate", {
        expression: "window.copies",
        returnByValue: true,
      })
    ).result.result.value;
  const ctrlC = () =>
    browser.key("c", "KeyC", { modifiers: 2, windowsVirtualKeyCode: 67 });

  const first = browser.consoleMessage("copied");
  await ctrlC();
  await first;
  const [selected] = await copies();
  assert.ok(selected.trim() !== "", "the selection was copied");

  // With the selection gone, Ctrl+C takes the field under the cursor instead.
  const second = browser.consoleMessage("copied");
  await ctrlC();
  await second;
  assert.notEqual((await copies())[1], selected);
  assert.deepEqual(browser.exceptions, []);
});

test("a middle click moves the cursor and pastes there", async (t) => {
  const browser = await startBrowser(t);
  await browser.command("Browser.grantPermissions", {
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    origin: browser.base,
  });
  await browser.command("Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
  await browser.command("Runtime.evaluate", {
    expression: "navigator.clipboard.writeText('pasted')",
    awaitPromise: true,
    userGesture: true,
  });

  const moved = browser.frame(
    "Network.webSocketFrameSent",
    "action",
    (message) => message.action === "MoveCursor1",
  );
  const pasted = browser.frame("Network.webSocketFrameSent", "paste");
  await clickScreenMiddle(browser, "middle");
  await moved;
  assert.equal((await pasted).text, "pasted");
  assert.deepEqual(browser.exceptions, []);
});

test("a middle click the browser pasted itself does not paste the clipboard as well", async (t) => {
  const browser = await startBrowser(t);
  await browser.command("Browser.grantPermissions", {
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    origin: browser.base,
  });
  await browser.command("Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
  await browser.command("Runtime.evaluate", {
    expression: "navigator.clipboard.writeText('clipboard')",
    awaitPromise: true,
    userGesture: true,
  });
  // What Firefox on Linux does: paste the selection right after the click.
  // Clipboard reads are counted: the second paste would only arrive later.
  await browser.command("Runtime.evaluate", {
    expression: `window.clipboardReads = 0;
    const readText = navigator.clipboard.readText.bind(navigator.clipboard);
    navigator.clipboard.readText = () => { window.clipboardReads++; return readText(); };
    window.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      const data = new DataTransfer();
      data.setData("text/plain", "selection");
      document.getElementById("screen").dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    })`,
  });

  const pasted = browser.frame("Network.webSocketFrameSent", "paste");
  const skipped = browser.consoleMessage(
    "the browser pasted the middle click itself",
  );
  await clickScreenMiddle(browser, "middle");
  assert.equal((await pasted).text, "selection");
  await skipped;
  const reads = await browser.command("Runtime.evaluate", {
    expression: "window.clipboardReads",
    returnByValue: true,
  });
  assert.equal(reads.result.result.value, 0, "the clipboard was not read");
  assert.deepEqual(browser.exceptions, []);
});

test("Ctrl+V and Shift+Insert paste without reading the clipboard themselves", async (t) => {
  const browser = await startBrowser(t);
  // Writing only: reading through navigator.clipboard would be refused.
  await browser.command("Browser.grantPermissions", {
    permissions: ["clipboardSanitizedWrite"],
    origin: browser.base,
  });
  await browser.command("Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
  await browser.command("Runtime.evaluate", {
    expression: "navigator.clipboard.writeText('pasted')",
    awaitPromise: true,
    userGesture: true,
  });

  for (const [name, code, modifiers, windowsVirtualKeyCode] of [
    ["v", "KeyV", 2, 86],
    ["Insert", "Insert", 8, 45],
  ]) {
    const pasted = browser.frame("Network.webSocketFrameSent", "paste");
    await browser.key(name, code, { modifiers, windowsVirtualKeyCode });
    assert.equal((await pasted).text, "pasted", name);
  }
  const focused = await browser.command("Runtime.evaluate", {
    expression: "document.activeElement.id",
    returnByValue: true,
  });
  assert.equal(focused.result.result.value, "screen");
  assert.deepEqual(browser.exceptions, []);
});

test("the session is restored after reload", async (t) => {
  const browser = await startBrowser(t);
  const reattached = browser.frame("Network.webSocketFrameReceived", "hello");
  await browser.command("Page.reload");
  await reattached;
  const afterReload = await browser.command("Runtime.evaluate", {
    expression: "location.hash",
    returnByValue: true,
  });
  assert.equal(afterReload.result.result.value, `#${browser.sessionId}`);
  assert.deepEqual(browser.exceptions, []);
});

test("Ctrl+digit opens and switches sessions, Ctrl+Shift+digit splits the page", async (t) => {
  const browser = await startBrowser(t);
  const evaluate = async (expression) =>
    (
      await browser.command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
    ).result.result.value;
  const afterPaint = (expression) =>
    evaluate(
      `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(${expression}))))`,
    );
  const panes = () =>
    afterPaint(
      "[...document.querySelectorAll('canvas')].map((c) => c.hidden ? null : c.style.left)",
    );

  const secondHello = browser.frame("Network.webSocketFrameReceived", "hello");
  const onSecond = browser.consoleMessage("keyboard on session");
  await browser.key("2", "Digit2", { modifiers: 2, windowsVirtualKeyCode: 50 });
  await secondHello;
  await onSecond;
  const ids = (await evaluate("location.hash.slice(1)")).split(",");
  assert.equal(ids.length, 2);
  assert.equal(ids[0], browser.sessionId);
  assert.notEqual(ids[1], browser.sessionId);
  // The second session took the one pane there was.
  assert.deepEqual(await panes(), [null, "0px", null, null]);

  // Shift-2 prints " on a German keyboard; the digit comes from the code.
  const split = browser.consoleMessage("layout");
  await browser.key('"', "Digit2", {
    modifiers: 2 | 8,
    windowsVirtualKeyCode: 50,
  });
  await split;
  const [left, right] = await panes();
  assert.equal(left, "0px");
  assert.ok(Number.parseInt(right, 10) > 0, right);

  const backOnFirst = browser.consoleMessage("keyboard on session");
  await browser.key("1", "Digit1", { modifiers: 2, windowsVirtualKeyCode: 49 });
  assert.match(await backOnFirst, /1$/);
  const typed = browser.frame("Network.webSocketFrameSent", "text");
  await browser.key("a", "KeyA", { text: "a", windowsVirtualKeyCode: 65 });
  assert.equal((await typed).value, "a");

  const reattached = browser.frame("Network.webSocketFrameReceived", "hello");
  await browser.command("Page.reload");
  await reattached;
  assert.equal(await evaluate("location.hash.slice(1)"), ids.join(","));
  assert.deepEqual(browser.exceptions, []);
});

test("the address keeps the panels and the keyboard on show across a reload", async (t) => {
  const browser = await startBrowser(t);
  const addressAfterPaint = async () =>
    (
      await browser.command("Runtime.evaluate", {
        expression:
          "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(location.search))))",
        awaitPromise: true,
        returnByValue: true,
      })
    ).result.result.value;

  await browser.key("m", "KeyM", { modifiers: 1, windowsVirtualKeyCode: 77 });
  await browser.key("k", "KeyK", { modifiers: 2, windowsVirtualKeyCode: 75 });
  assert.equal(await addressAfterPaint(), "?panel=menu&keyboard=1");

  // A playback needs the recording a reload lost, so the stack stops short of it.
  const restored = browser.consoleMessage("panels restored");
  await browser.command("Page.navigate", {
    url: `${browser.base}/?panel=menu&panel=font&panel=playback%3A1&keyboard=1#${browser.sessionId}`,
  });
  await restored;
  assert.equal(await addressAfterPaint(), "?panel=menu&panel=font&keyboard=1");
  assert.deepEqual(browser.exceptions, []);
});

test("a link to a session that is gone starts a new one", async (t) => {
  const browser = await startBrowser(t);
  const gone = "00000000-0000-0000-0000-000000000000";
  const reported = browser.consoleMessage("[E3001]");
  const started = browser.frame("Network.webSocketFrameReceived", "hello");
  // A new query, or only the hash would change and the page would not load.
  await browser.command("Page.navigate", {
    url: `${browser.base}/?link#${gone}`,
  });
  await reported;
  await started;
  const hash = await browser.command("Runtime.evaluate", {
    expression: "location.hash.slice(1)",
    returnByValue: true,
  });
  assert.match(hash.result.result.value, /^[0-9a-f-]{36}$/);
  assert.notEqual(hash.result.result.value, gone);
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
    listed.sessions.some((session) => session.id === browser.sessionId),
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
      const width = metrics.width;
      const height = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
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

test("Shift+click opens a data set in the editor the page is framed in", async (t) => {
  const browser = await startBrowser(t);
  // A page of the server's own stands in for VS Code's webview, and frames
  // the session the test started.
  const loaded = browser.event("Page.loadEventFired");
  await browser.command("Page.navigate", { url: `${browser.base}/editor` });
  await loaded;
  const resolved = browser.consoleMessage("resolve ");
  await browser.command("Runtime.evaluate", {
    expression: `(() => {
      addEventListener("message", (event) => {
        const message = event.data;
        if (message?.bridge !== "tn3270") return;
        const answer = (fields) =>
          event.source.postMessage({ bridge: "tn3270", v: 1, ...fields }, location.origin);
        if (message.type === "hello")
          answer({ type: "hello", capabilities: ["resolveDatasets", "openDataset"] });
        if (message.type === "resolveDatasets") {
          console.info("resolve " + JSON.stringify(message.names));
          const found = message.names.filter((name) => /PGM[12]/.test(name));
          answer({ type: "result", id: message.id, result: { found } });
        }
        if (message.type === "openDataset") {
          console.info("open " + message.name);
          answer(
            message.name.includes("PGM2")
              ? { type: "result", id: message.id, error: { code: "TERM005E", message: "open failed" } }
              : { type: "result", id: message.id, result: {} },
          );
        }
      });
      const frame = document.createElement("iframe");
      frame.src = "/#${browser.sessionId}";
      frame.style = "position: fixed; inset: 0; border: 0; width: 1000px; height: 700px";
      document.body.append(frame);
    })()`,
  });
  assert.deepEqual(JSON.parse((await resolved).slice("resolve ".length)), [
    "USER.PLI.SOURCE(PGM1)",
    "USER.PLI.SOURCE(PGM2)",
    "USER.PLI.SOURCE(NOTHERE)",
    "USER.PLI.DATA",
  ]);

  /** @param {number} row @param {number} col 0-based */
  const shiftClick = async (row, col) => {
    const position = await browser.command("Runtime.evaluate", {
      expression: `(() => {
        const frame = document.querySelector("iframe").getBoundingClientRect();
        const canvas = document.querySelector("iframe").contentDocument.querySelector("canvas");
        const metrics = canvas.getContext("2d").measureText("M");
        const width = metrics.width;
        const height = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
        const rect = canvas.getBoundingClientRect();
        return {
          x: frame.left + rect.left + (rect.width - 80 * width) / 2 + (${col} + 0.5) * width,
          y: frame.top + rect.top + (rect.height - 44 * height) / 2 + (${row} + 0.5) * height,
        };
      })()`,
      returnByValue: true,
    });
    const { x, y } = position.result.result.value;
    for (const type of ["mousePressed", "mouseReleased"])
      await browser.command("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
        modifiers: 8,
      });
  };

  // Not in the repo, so not opened: the first open is the next click's.
  const opened = browser.consoleMessage("open ");
  await shiftClick(25, 12);
  await shiftClick(23, 12);
  assert.equal(await opened, "open USER.PLI.SOURCE(PGM1)");

  const failed = browser.consoleMessage("E5061");
  await shiftClick(24, 12);
  assert.match(await failed, /USER\.PLI\.SOURCE\(PGM2\).*TERM005E/);

  const askedAgain = browser.consoleMessage("resolve ");
  await browser.command("Runtime.evaluate", {
    expression: `document.querySelector("iframe").contentWindow.postMessage(
      { bridge: "tn3270", v: 1, type: "datasetsChanged" }, location.origin)`,
  });
  assert.equal(
    JSON.parse((await askedAgain).slice("resolve ".length)).length,
    4,
  );
  assert.deepEqual(browser.exceptions, []);
});

test("a resize draws the screen in the frame it happens in, never a blank canvas", async (t) => {
  const browser = await startBrowser(t);
  // This observer comes after the page's, so its frame is the one the
  // page's resize is shown in.
  await browser.command("Runtime.evaluate", {
    expression: `new Promise((observed) => {
      const canvas = document.querySelector("canvas");
      let first = true;
      window.litAfterResize = new Promise((resolve) => {
        const observer = new ResizeObserver(() => {
          if (first) {
            first = false;
            observed();
            return;
          }
          observer.disconnect();
          requestAnimationFrame(() => {
            const { data } = canvas
              .getContext("2d")
              .getImageData(0, 0, canvas.width, canvas.height);
            let lit = 0;
            for (let i = 0; i < data.length; i += 4)
              if (data[i] + data[i + 1] + data[i + 2] > 0) lit++;
            resolve(lit);
          });
        });
        observer.observe(document.querySelector("#screen"));
      });
    })`,
    awaitPromise: true,
  });
  await browser.command("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const lit = await browser.command("Runtime.evaluate", {
    expression: "window.litAfterResize",
    awaitPromise: true,
    returnByValue: true,
  });
  assert.ok(lit.result.result.value > 0, "the resized canvas is drawn");
  assert.deepEqual(browser.exceptions, []);
});

test("a print job from the host downloads as a UTF-8 text file", async (t) => {
  const browser = await startBrowser(t, { printer: true });
  const downloads = join(browser.temp, "downloads");
  await browser.command("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
  });
  const trace = readFileSync(PRINTER_TRACE, "utf8").split("\n");
  const records = trace
    .slice(0, trace.indexOf("+"))
    .filter((line) => line.startsWith("< 0x") && line.trim().endsWith("ffef"));

  await browser.printerHost.waitForConnection();
  await browser.printerHost.sendRecords(records.length);
  await waitUntil(
    async () =>
      (await readdir(downloads).catch(() => [])).filter((name) =>
        /^print-.*-2\.txt$/.test(name),
      ).length === 1,
    "the second job to download",
    10000,
  );

  const [file] = (await readdir(downloads)).filter((name) =>
    name.endsWith("-2.txt"),
  );
  assert.equal(
    await readFile(join(downloads, file), "utf8"),
    readFileSync("3270/test/fixtures/printer/smoke.out", "latin1"),
  );
  assert.deepEqual(browser.exceptions, []);
});

test("a data set downloads as a UTF-8 text file from the transfer panel", async (t) => {
  const browser = await startBrowser(t);
  const downloads = join(browser.temp, "downloads");
  await browser.command("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
  });
  browser.host.socket?.write(Buffer.from(UNFORMATTED, "hex"));
  /** @param {string} text */
  const type = async (text) => {
    for (const ch of text) await browser.key(ch, "", { text: ch });
  };
  const enter = () =>
    browser.key("Enter", "Enter", { modifiers: 2, windowsVirtualKeyCode: 13 });

  await browser.key("m", "KeyM", { modifiers: 1, windowsVirtualKeyCode: 77 });
  await type("8");
  await enter();
  await browser.key("Tab", "Tab", { windowsVirtualKeyCode: 9 });
  await browser.key("Tab", "Tab", { windowsVirtualKeyCode: 9 });
  await type("'USER.DATA'");
  await enter();
  await browser.host.waitUntil(
    () => browser.host.received.includes("7d"),
    5000,
    "the IND$FILE command",
  );
  for (const record of [
    open("FT:DATA"),
    // ü and ß, as IND$FILE's ASCII table has them.
    insert(Buffer.from("Gr\xf0\xb1e\r\n", "latin1")),
    CLOSE,
    ...message("TRANS03 File transfer complete"),
  ])
    browser.host.socket?.write(Buffer.from(record, "hex"));

  await waitUntil(
    async () =>
      (await readdir(downloads).catch(() => [])).includes("USER.DATA.txt"),
    "the data set to download",
  );
  assert.equal(
    await readFile(join(downloads, "USER.DATA.txt"), "utf8"),
    "Grüße\n",
  );
  assert.deepEqual(browser.exceptions, []);
});

test("a macro's download step saves the data set without the panel", async (t) => {
  const browser = await startBrowser(t);
  const downloads = join(browser.temp, "downloads");
  await browser.command("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
  });
  browser.host.socket?.write(Buffer.from(UNFORMATTED, "hex"));
  for (const [key, body] of /** @type {const} */ ([
    [
      "macros",
      [
        {
          name: "Get",
          steps: [
            {
              text: "",
              action: "Download",
              args: ["'U.TN3270.DL'", "TSO IND\\e005BFILE"],
            },
          ],
        },
      ],
    ],
    [
      "keymap",
      {
        "Macro:Get": [{ key: "F12", shift: false, ctrl: false, alt: false }],
      },
    ],
  ])) {
    const changed = browser.consoleMessage("user data changed elsewhere");
    const response = await fetch(`${browser.base}/api/userdata/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-tab": "elsewhere" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 204);
    await changed;
  }

  await browser.key("F12", "F12", { windowsVirtualKeyCode: 123 });
  await browser.host.waitUntil(
    () => browser.host.received.includes("7d"),
    5000,
    "the IND$FILE command",
  );
  for (const record of [
    open("FT:DATA"),
    insert(Buffer.from("JOB OUTPUT\r\n")),
    CLOSE,
    ...message("TRANS03 File transfer complete"),
  ])
    browser.host.socket?.write(Buffer.from(record, "hex"));

  await waitUntil(
    async () =>
      (await readdir(downloads).catch(() => [])).includes("U.TN3270.DL.txt"),
    "the data set to download",
  );
  assert.equal(
    await readFile(join(downloads, "U.TN3270.DL.txt"), "utf8"),
    "JOB OUTPUT\n",
  );
  assert.deepEqual(browser.exceptions, []);
});

test("a file uploads into a data set from the transfer panel", async (t) => {
  const browser = await startBrowser(t);
  const local = join(browser.temp, "upload.txt");
  await writeFile(local, "Grüße\nZWEI\n");
  await browser.command("Page.setInterceptFileChooserDialog", {
    enabled: true,
  });
  browser.host.socket?.write(Buffer.from(UNFORMATTED, "hex"));
  /** @param {string} text */
  const type = async (text) => {
    for (const ch of text) await browser.key(ch, "", { text: ch });
  };
  const tab = () => browser.key("Tab", "Tab", { windowsVirtualKeyCode: 9 });

  await browser.key("m", "KeyM", { modifiers: 1, windowsVirtualKeyCode: 77 });
  await type("8");
  await browser.key("Enter", "Enter", {
    modifiers: 2,
    windowsVirtualKeyCode: 13,
  });
  await tab();
  // The one-cell option field skips on to the data set's.
  await type("3");
  await type("'USER.DATA'");
  const chooser = browser.event("Page.fileChooserOpened");
  await browser.key("Enter", "Enter", {
    modifiers: 2,
    windowsVirtualKeyCode: 13,
  });
  const { backendNodeId } = await chooser;
  const finished = browser.consoleMessage("transfer finished");
  await browser.command("DOM.setFileInputFiles", {
    files: [local],
    backendNodeId,
  });
  await browser.host.waitUntil(
    () => browser.host.received.includes("7d"),
    5000,
    "the IND$FILE command",
  );
  answer(browser.host, [open("FT:DATA"), GET]);
  // ü and ß, as IND$FILE's ASCII table has them.
  const data = Buffer.from("Gr\xf0\xb1e\r\nZWEI\r\n", "latin1").toString("hex");
  await browser.host.waitUntil(
    () => browser.host.received.includes(data),
    5000,
    "the file's text",
  );
  answer(browser.host, [
    GET,
    CLOSE,
    ...message("TRANS03 File transfer complete"),
  ]);
  await finished;
  assert.deepEqual(browser.exceptions, []);
});

test("macros upload from the clipboard and download to it", async (t) => {
  const browser = await startBrowser(t);
  await browser.command("Browser.grantPermissions", {
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    origin: browser.base,
  });
  await browser.command("Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
  await browser.command("Runtime.evaluate", {
    expression: "navigator.clipboard.writeText('COPIED\\n')",
    awaitPromise: true,
    userGesture: true,
  });
  browser.host.socket?.write(Buffer.from(UNFORMATTED, "hex"));
  for (const [key, body] of /** @type {const} */ ([
    [
      "macros",
      [
        {
          name: "Put",
          steps: [
            {
              text: "",
              action: "Upload",
              args: ["'U.IN'", "TSO IND\\e005BFILE", "clipboard"],
            },
          ],
        },
        {
          name: "Get",
          steps: [
            {
              text: "",
              action: "Download",
              args: ["'U.OUT'", "TSO IND\\e005BFILE", "clipboard"],
            },
          ],
        },
      ],
    ],
    [
      "keymap",
      {
        "Macro:Put": [{ key: "F11", shift: false, ctrl: false, alt: false }],
        "Macro:Get": [{ key: "F12", shift: false, ctrl: false, alt: false }],
      },
    ],
  ])) {
    const changed = browser.consoleMessage("user data changed elsewhere");
    const response = await fetch(`${browser.base}/api/userdata/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-tab": "elsewhere" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 204);
    await changed;
  }

  let done = browser.consoleMessage("macro transfer done");
  await browser.key("F11", "F11", { windowsVirtualKeyCode: 122 });
  await browser.host.waitUntil(
    () => browser.host.received.includes("7d"),
    5000,
    "the IND$FILE PUT command",
  );
  answer(browser.host, [open("FT:DATA"), GET]);
  const data = Buffer.from("COPIED\r\n").toString("hex");
  await browser.host.waitUntil(
    () => browser.host.received.includes(data),
    5000,
    "the clipboard's text",
  );
  answer(browser.host, [
    GET,
    CLOSE,
    ...message("TRANS03 File transfer complete"),
  ]);
  await done;

  done = browser.consoleMessage("macro transfer done");
  const mark = browser.host.received.length;
  await browser.key("F12", "F12", { windowsVirtualKeyCode: 123 });
  await browser.host.waitUntil(
    () => browser.host.received.slice(mark).includes("7d"),
    5000,
    "the IND$FILE GET command",
  );
  answer(browser.host, [
    open("FT:DATA"),
    insert(Buffer.from("JOB OUTPUT\r\n")),
    CLOSE,
    ...message("TRANS03 File transfer complete"),
  ]);
  await done;
  const clipboard = await browser.command("Runtime.evaluate", {
    expression: "navigator.clipboard.readText()",
    awaitPromise: true,
    userGesture: true,
    returnByValue: true,
  });
  assert.equal(clipboard.result.result.value, "JOB OUTPUT\n");
  assert.deepEqual(browser.exceptions, []);
});

/** @param {FakeHost} host @param {string[]} records */
function answer(host, records) {
  for (const record of records) host.socket?.write(Buffer.from(record, "hex"));
}
