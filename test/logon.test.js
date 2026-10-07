import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:tls";
import { Session } from "../server/session.js";
import { decodeReply, encodeRequest } from "../server/dcas.js";
import { codePage } from "../3270/src/charset.js";
import { FAKEHOST_CA, FAKEHOST_KEY } from "./fakehost.js";
import {
  collectingViewer,
  freePort,
  startTracedSession,
  testConfig,
  waitUntil,
} from "./helpers.js";

// login.trc's one screen is an AS/400 sign-on: "Uzivatel (User)" with the
// cursor in its field, "Heslo (Password)" on the line below.
const READY_TEXT = "Uzivatel (User)";
const DONE_TEXT = "READY";
// Erase/Write, keyboard restored, "READY" at the top left, end of record.
const READY_RECORD = "f5c3114040d9c5c1c4e8ffef";
const TLS_KEY = readFileSync(FAKEHOST_KEY);
const TLS_CERT = readFileSync(FAKEHOST_CA);

/** @param {string} text @returns {string} EBCDIC 037 as hex, the trace's code page */
function ebcdicHex(text) {
  const { toEbcdic } = codePage("cp037");
  return Buffer.from(
    [...text].map((ch) => toEbcdic.get(ch.codePointAt(0) ?? 0) ?? 0),
  ).toString("hex");
}

/**
 * A DCAS that answers each request with what `reply` makes of it.
 *
 * @param {(request: Buffer) => Buffer} reply
 */
async function fakeDcas(reply) {
  /** @type {Buffer[]} */
  const requests = [];
  /** @type {(import('node:tls').TLSSocket)[]} */
  const sockets = [];
  const server = createServer(
    { key: TLS_KEY, cert: TLS_CERT, ca: [TLS_CERT], requestCert: true },
    (socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      socket.once("data", (/** @type {Buffer} */ request) => {
        requests.push(request);
        socket.end(reply(request));
      });
    },
  );
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(undefined)),
  );
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    requests,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** @param {Buffer} request @param {number} rc1 @param {string} ticketHex */
function dcasReply(request, rc1, ticketHex) {
  const reply = Buffer.alloc(38);
  reply[0] = 0x02;
  reply[1] = 0x02;
  request.copy(reply, 2, 2, 6);
  reply.writeUInt16BE(rc1, 6);
  if (rc1 !== 0) reply.writeUInt32BE(8, 8);
  Buffer.from(ticketHex, "hex").copy(reply, 30);
  return reply;
}

/**
 * @param {{ dcasPort?: number, timeoutMs?: number }} options
 */
function logonConfig({ dcasPort, timeoutMs = 5000 }) {
  return {
    security: { trustProxyHeaders: true },
    logon: {
      readyText: READY_TEXT,
      doneText: DONE_TEXT,
      timeoutMs,
      ...(dcasPort === undefined
        ? {}
        : {
            sso: true,
            dcas: {
              host: "127.0.0.1",
              port: dcasPort,
              applid: "TSO",
              certFile: FAKEHOST_CA,
              keyFile: FAKEHOST_KEY,
              caFile: FAKEHOST_CA,
            },
          }),
    },
  };
}

/**
 * A session whose proxy named `user`, its owner attached, connected to a host
 * that shows login.trc's sign-on screen.
 *
 * @param {Record<string, unknown>} config overrides
 * @param {string} user
 */
async function signOnSession(config, user) {
  const owner = collectingViewer("owner");
  const traced = await startTracedSession("test/traces/login.trc", {
    config,
    prepare: (session) => {
      session.remoteUser = user;
      session.attach(owner);
    },
  });
  return { ...traced, owner };
}

/** @param {ReturnType<typeof collectingViewer>} viewer @returns {boolean} */
function sawSignOnScreen(viewer) {
  return JSON.stringify(viewer.paints).includes("Uzivatel");
}

test("a DCAS request is laid out as IBM's Format 2", () => {
  const request = encodeRequest("TSO", "SIMON", Buffer.from("01020304", "hex"));
  assert.equal(
    request.toString("hex"),
    [
      "0202",
      "01020304",
      "e3e2d6" + "00".repeat(17),
      "0000",
      "00000005",
      "e2c9d4d6d5",
    ].join(""),
  );
});

test("a DCAS reply gives its PassTicket, or its return codes as an error", () => {
  const correlator = Buffer.from("01020304", "hex");
  const request = encodeRequest("TSO", "SIMON", correlator);
  assert.equal(
    decodeReply(dcasReply(request, 0, ebcdicHex("PT123")), correlator),
    "PT123",
  );
  assert.throws(
    () => decodeReply(dcasReply(request, 251, ""), correlator),
    /\[E9003\].*251\/8\/0\/0.*PTKTDATA/,
  );
  assert.throws(
    () =>
      decodeReply(dcasReply(request, 0, ""), Buffer.from("ffffffff", "hex")),
    /\[E9004\].*correlator/,
  );
  assert.throws(
    () => decodeReply(Buffer.alloc(10), correlator),
    /\[E9004\].*10 bytes/,
  );
});

test("single sign-on types the user and PassTicket, and shows the host only once logged on", async (t) => {
  const dcas = await fakeDcas((request) =>
    dcasReply(request, 0, ebcdicHex("PT123") + "404040"),
  );
  const fixture = await signOnSession(
    logonConfig({ dcasPort: dcas.port }),
    "simon",
  );
  t.after(async () => {
    await fixture.close();
    await dcas.close();
  });
  const { host, session, owner } = fixture;

  await host.waitUntil(
    () =>
      host.received.includes(ebcdicHex("SIMON")) &&
      host.received.includes(ebcdicHex("PT123")),
    5000,
    "the user and PassTicket to be typed",
  );
  assert.equal(dcas.requests.length, 1);
  assert.equal(
    dcas.requests[0]?.subarray(32).toString("hex"),
    "e2c9d4d6d5",
    "the user ID goes to DCAS in upper case",
  );
  assert.equal(sawSignOnScreen(owner), false);
  session.handleClientMessage(owner, { type: "text", value: "X" });
  assert.ok(
    owner.messages.some((m) => m.type === "error" && m.code === "E3018"),
    "the keyboard waits for the logon",
  );

  host.socket?.write(Buffer.from(READY_RECORD, "hex"));
  await waitUntil(
    () => owner.grid.rowText(0).startsWith("READY"),
    "the logged-on screen to be painted",
  );
  assert.equal(session.loggingOn, false);
  assert.equal(sawSignOnScreen(owner), false);
  assert.ok(!owner.messages.some((m) => m.type === "logon"));
});

test("a DCAS refusal shows the host at once and hands the owner the logon dialog", async (t) => {
  const dcas = await fakeDcas((request) => dcasReply(request, 251, ""));
  const fixture = await signOnSession(
    logonConfig({ dcasPort: dcas.port }),
    "simon",
  );
  t.after(async () => {
    await fixture.close();
    await dcas.close();
  });
  const { owner, session } = fixture;

  await waitUntil(
    () => owner.messages.some((m) => m.type === "logon"),
    "the logon dialog to be asked for",
  );
  const logon = owner.messages.find((m) => m.type === "logon");
  assert.equal(logon?.type === "logon" ? logon.code : "", "E9003");
  assert.equal(session.loggingOn, false);
  assert.ok(sawSignOnScreen(owner), "the host's screen is shown with it");
});

test("with DCAS unreachable or no user from the proxy, the owner gets the logon dialog", async (t) => {
  const closedPort = await freePort();
  for (const [user, code] of [
    ["simon", "E9001"],
    ["", "E3023"],
  ]) {
    const fixture = await signOnSession(
      logonConfig({ dcasPort: closedPort }),
      user,
    );
    t.after(() => fixture.close());
    await waitUntil(
      () => fixture.owner.messages.some((m) => m.type === "logon"),
      `the logon dialog for ${code}`,
    );
    const logon = fixture.owner.messages.find((m) => m.type === "logon");
    assert.equal(logon?.type === "logon" ? logon.code : "", code);
    await waitUntil(
      () => sawSignOnScreen(fixture.owner),
      "the host's screen to be shown",
    );
  }
});

test("an owner who attaches after single sign-on failed still gets the dialog", async (t) => {
  const traced = await startTracedSession("test/traces/login.trc", {
    config: logonConfig({ dcasPort: await freePort() }),
  });
  t.after(() => traced.close());
  const { session } = traced;
  await waitUntil(() => session.logonFailure !== null, "the logon to fail");

  const owner = collectingViewer("owner");
  session.attach(owner);
  const logon = owner.messages.find((m) => m.type === "logon");
  assert.equal(logon?.type === "logon" ? logon.code : "", "E3023");
  assert.equal(session.logonFailure, null, "told once");
});

test("a logon by hand types the user and password the owner gave", async (t) => {
  const fixture = await signOnSession(logonConfig({}), "");
  t.after(() => fixture.close());
  const { host, session, owner } = fixture;
  await waitUntil(() => sawSignOnScreen(owner), "the sign-on screen");

  const done = session.logonByHand(session.ownerPass, "SIMON", "secret");
  await host.waitUntil(
    () =>
      host.received.includes(ebcdicHex("SIMON")) &&
      host.received.includes(ebcdicHex("secret")),
    5000,
    "the user and password to be typed",
  );
  host.socket?.write(Buffer.from(READY_RECORD, "hex"));
  await done;
  await waitUntil(
    () => owner.grid.rowText(0).startsWith("READY"),
    "the logged-on screen",
  );
  assert.equal(session.undoStack.length, 0, "the password is not history");
});

test("a logon by hand fails with its own code, and only for the owner", async (t) => {
  const fixture = await signOnSession(logonConfig({ timeoutMs: 300 }), "");
  t.after(() => fixture.close());
  const { session } = fixture;

  await assert.rejects(
    session.logonByHand("not-the-pass", "SIMON", "secret"),
    /\[E3019\]/,
  );
  // The host never answers the Enter, so the logged-on screen never comes.
  await assert.rejects(
    session.logonByHand(session.ownerPass, "SIMON", "secret"),
    /\[E3021\]/,
  );
  assert.equal(session.loggingOn, false);

  const unconfigured = new Session(testConfig());
  t.after(() => unconfigured.close());
  await assert.rejects(
    unconfigured.logonByHand(unconfigured.ownerPass, "SIMON", "secret"),
    /\[E3024\]/,
  );
});

test("a logon on a session not connected fails at once", async (t) => {
  const session = new Session(testConfig(logonConfig({})));
  t.after(() => session.close());
  await assert.rejects(
    session.logonByHand(session.ownerPass, "SIMON", "secret"),
    /\[E3022\]/,
  );
});
