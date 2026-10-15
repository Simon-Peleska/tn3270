import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "../server/session.js";
import { FakeHost, sharedPort } from "./fakehost.js";
import {
  collectingViewer,
  freePort,
  testConfig,
  waitUntil,
} from "./helpers.js";

const PRINTER = "3270/test/fixtures/printer/";

/** @param {import('node:test').TestContext} t @param {number} printerPort */
async function printingSession(t, printerPort) {
  process.env["PRINTER_DELAY_MS"] = "1";
  const display = await FakeHost.listen("test/traces/lu.trc", 0, {
    tls: true,
  });
  const shared = await sharedPort([display.port, printerPort]);
  const session = new Session(
    testConfig({ emulator: { settings: { printerLu: "." } } }),
  );
  t.after(async () => {
    session.close();
    shared.close();
    await display.close();
  });
  const owner = collectingViewer("owner");
  session.attach(owner);
  session.connect(`127.0.0.1:${shared.port}`);
  await display.waitForConnection();
  await display.sendRecords(1);
  return owner;
}

test("the owner is streamed each print job as text, and told when it ends", async (t) => {
  const printerHost = await FakeHost.listen(`${PRINTER}smoke.trc`, 0, {
    tls: true,
  });
  t.after(() => printerHost.close());
  const owner = await printingSession(t, printerHost.port);

  const trace = readFileSync(`${PRINTER}smoke.trc`, "utf8").split("\n");
  const records = trace
    .slice(0, trace.indexOf("+"))
    .filter((line) => line.startsWith("< 0x") && line.trim().endsWith("ffef"));
  await printerHost.sendRecords(records.length);
  await waitUntil(
    () => owner.messages.filter((m) => m.type === "printEnd").length === 2,
    "both jobs to end",
  );

  /** @param {number} job */
  const text = (job) =>
    owner.messages
      .flatMap((m) => (m.type === "print" && m.job === job ? [m.text] : []))
      .join("");
  assert.equal(text(1), readFileSync(`${PRINTER}smoke-job1.out`, "latin1"));
  assert.equal(text(2), readFileSync(`${PRINTER}smoke.out`, "latin1"));
  const order = owner.messages
    .filter((m) => m.type === "print" || m.type === "printEnd")
    .map((m) => `${m.type}:${m.job}`);
  assert.equal(
    order.indexOf("printEnd:1"),
    order.lastIndexOf("print:1") + 1,
    "a job ends after its last text",
  );
});

test("a printer that cannot connect shows E2008", async (t) => {
  const owner = await printingSession(t, await freePort());

  await waitUntil(
    () => owner.messages.some((m) => m.type === "error"),
    "the printer error",
  );
  const error = owner.messages.find((m) => m.type === "error");
  assert.equal(error?.type === "error" && error.code, "E2008");
});
