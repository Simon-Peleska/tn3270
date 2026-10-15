import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../server/session.js";
import { FakeHost } from "./fakehost.js";
import { collectingViewer, letIn, testConfig, waitUntil } from "./helpers.js";
import {
  CLOSE,
  UNFORMATTED,
  insert,
  message,
  open,
} from "../3270/test/indfile.js";

const TRANSFER = /** @type {const} */ ({
  type: "transfer",
  hostFile: "'USER.DATA(MEM)'",
  hostCommand: "TSO IND\\e005BFILE",
});

/** The owner's session at TSO READY, where the transfer types its command. @param {import('node:test').TestContext} t */
async function readySession(t) {
  const host = await FakeHost.listen("test/traces/fields.trc", 0, {
    tls: true,
  });
  const session = new Session(testConfig());
  t.after(async () => {
    session.close();
    await host.close();
  });
  const owner = collectingViewer("owner");
  session.attach(owner);
  session.connect(`127.0.0.1:${host.port}`);
  await host.waitForConnection();
  await host.sendRecords(1);
  host.socket?.write(Buffer.from(UNFORMATTED, "hex"));
  await waitUntil(() => session.screenLines()[0]?.trim() === "", "READY");
  return { host, session, owner };
}

/** @param {FakeHost} host @param {string[]} records */
function answer(host, records) {
  for (const record of records) host.socket?.write(Buffer.from(record, "hex"));
}

/** @param {ReturnType<typeof collectingViewer>} viewer */
const downloadEnd = async (viewer) => {
  await waitUntil(
    () => viewer.messages.some((m) => m.type === "downloadEnd"),
    "the download to end",
  );
  return viewer.messages.find((m) => m.type === "downloadEnd");
};

/** @param {FakeHost} host */
const commandSent = (host) =>
  host.waitUntil(() => host.received.includes("7d"), 5000, "no Enter");

test("the owner downloads a data set as text through IND$FILE", async (t) => {
  const { host, session, owner } = await readySession(t);
  session.handleClientMessage(owner, TRANSFER);
  await commandSent(host);
  assert.equal(
    session.screenLines()[0]?.trimEnd(),
    "TSO IND$FILE GET 'USER.DATA(MEM)' ASCII CRLF",
  );
  answer(host, [
    open("FT:DATA"),
    insert(Buffer.from("HELLO, WORLD\r\n")),
    insert(Buffer.from("SECOND LINE\r\n")),
    CLOSE,
    ...message("TRANS03 File transfer complete"),
  ]);
  const end = await downloadEnd(owner);
  assert.equal(end?.type === "downloadEnd" && end.ok, true);
  assert.match(
    end?.type === "downloadEnd" ? end.message : "",
    /^Transfer complete, 25 bytes transferred \S+ [KM]?bytes\/sec in DFT mode$/,
  );
  const text = owner.messages
    .flatMap((m) => (m.type === "download" ? [m.text] : []))
    .join("");
  assert.equal(text, "HELLO, WORLD\nSECOND LINE\n");
});

/** @param {ReturnType<typeof collectingViewer>} viewer */
const failure = async (viewer) => {
  const end = await downloadEnd(viewer);
  return end?.type === "downloadEnd" && !end.ok
    ? `${end.code} ${end.message}`
    : "";
};

test("the host's refusal ends the download with E3030", async (t) => {
  const { host, session, owner } = await readySession(t);
  session.handleClientMessage(owner, TRANSFER);
  await commandSent(host);
  answer(host, message("TRANS34 Data set not found"));
  assert.equal(
    await failure(owner),
    "E3030 Data set download failed: TRANS34 Data set not found",
  );
});

test("the owner cancels a download, and leaving cancels it too", async (t) => {
  const { host, session, owner } = await readySession(t);
  session.handleClientMessage(owner, TRANSFER);
  await commandSent(host);
  session.handleClientMessage(owner, { type: "transferCancel" });
  assert.equal(
    await failure(owner),
    "E3030 Data set download failed: Transfer canceled by user",
  );

  owner.messages.length = 0;
  host.socket?.write(Buffer.from(UNFORMATTED, "hex"));
  await waitUntil(() => session.emulator.s.ft === null, "the keyboard");
  session.handleClientMessage(owner, TRANSFER);
  await waitUntil(() => session.emulator.s.ft !== null, "a second download");
  session.detach(owner);
  await waitUntil(() => session.emulator.s.ft === null, "the cancel");
});

test("only the owner may download, not a guest let in to edit", async (t) => {
  const { session, owner } = await readySession(t);
  const guest = collectingViewer("guest");
  letIn(session, owner, guest);
  session.handleClientMessage(guest, { type: "askEdit" });
  session.handleClientMessage(owner, {
    type: "answer",
    viewer: guest.id,
    allow: true,
  });
  assert.equal(guest.role, "controller");
  session.handleClientMessage(guest, TRANSFER);
  assert.equal(
    await failure(guest),
    "E3029 Only the session's owner may download data sets",
  );
});

test("a macro's download runs in its turn, and the steps after it wait for the file", async (t) => {
  const { host, session, owner } = await readySession(t);
  session.handleClientMessage(owner, {
    type: "macro",
    steps: [TRANSFER, { type: "text", value: "AFTER" }],
  });
  await commandSent(host);
  assert.doesNotMatch(session.screenLines().join("\n"), /AFTER/);
  answer(host, [
    open("FT:DATA"),
    insert(Buffer.from("HELLO, WORLD\r\n")),
    CLOSE,
    ...message("TRANS03 File transfer complete"),
  ]);
  const end = await downloadEnd(owner);
  assert.equal(end?.type === "downloadEnd" && end.ok, true);
  assert.equal(
    end?.type === "downloadEnd" ? end.hostFile : "",
    "'USER.DATA(MEM)'",
  );
  const text = owner.messages
    .flatMap((m) => (m.type === "download" ? [m.text] : []))
    .join("");
  assert.equal(text, "HELLO, WORLD\n");
  await waitUntil(
    () => session.screenLines().join("\n").includes("AFTER"),
    "the step after the download",
  );
});
