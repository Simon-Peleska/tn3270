import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHost } from "./fakehost.js";
import { freePort, testConfig, waitUntil } from "./helpers.js";

const S3270 = process.env["S3270_PATH"] ?? "s3270";
const noS3270 =
  spawnSync(S3270, ["-v"], { stdio: "pipe" }).error && "s3270 not installed";

/** @param {import('node:child_process').ChildProcess} child */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

/** @param {string} url @returns {Promise<boolean>} */
async function answers(url) {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Our server with one session on fields.trc, reached the way s3270's httpd is.
 * @param {import('node:test').TestContext} t
 * @param {string} [user] the proxy's X-Remote-User for whoever starts the session
 * @returns {Promise<{ base: string, host: FakeHost, sessions: string }>}
 */
async function startOurs(t, user) {
  const host = await FakeHost.listen("test/traces/fields.trc", 0, {
    tls: true,
  });
  const port = await freePort();
  const temp = await mkdtemp(join(tmpdir(), "tn3270-rest-"));
  const configFile = join(temp, "config.json");
  await writeFile(
    configFile,
    JSON.stringify(
      testConfig({
        server: { host: "127.0.0.1", port },
        emulator: { defaultHost: `127.0.0.1:${host.port}` },
        security: { allowedHosts: [], trustProxyHeaders: user !== undefined },
        logFile: "",
      }),
    ),
  );
  const server = spawn(process.execPath, ["server/main.js"], {
    env: { ...process.env, TN3270_CONFIG: configFile },
    stdio: "ignore",
  });
  t.after(async () => {
    await stop(server);
    await host.close();
    await rm(temp, { recursive: true, force: true });
  });
  const sessions = `http://127.0.0.1:${port}/api/sessions`;
  await waitUntil(() => answers(sessions), "our server to start");
  const { id } = await (
    await fetch(sessions, {
      method: "POST",
      headers: user ? { "x-remote-user": user } : {},
    })
  ).json();
  await host.waitForConnection();
  await host.sendRecords(1);
  return { base: `${sessions}/${id}/3270/rest/`, host, sessions };
}

/**
 * s3270 with its own httpd on its own copy of fields.trc.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ base: string, host: FakeHost }>}
 */
async function startS3270(t) {
  const host = await FakeHost.listen("test/traces/fields.trc");
  const port = await freePort();
  const s3270 = spawn(
    S3270,
    [
      "-model",
      "3279-4-E",
      "-httpd",
      `127.0.0.1:${port}`,
      `127.0.0.1:${host.port}`,
    ],
    { stdio: "ignore" },
  );
  t.after(async () => {
    await stop(s3270);
    await host.close();
  });
  const base = `http://127.0.0.1:${port}/3270/rest/`;
  await waitUntil(() => answers(base), "s3270's httpd to start");
  await host.waitForConnection();
  await host.sendRecords(1);
  return { base, host };
}

/**
 * @param {string} base
 * @param {string} path
 * @param {{ type: string, body: string }} [post]
 */
async function call(base, path, post) {
  const answer = await fetch(
    base + path,
    post && {
      method: "POST",
      headers: { "content-type": post.type },
      body: post.body,
    },
  );
  // The last field of the status line is how long the run took.
  const body = (await answer.text()).replace(/ \d+\.\d{3}(?=\r\n|")/g, " T");
  return `${answer.status}\n${body}`;
}

/** @type {Array<[string, { type: string, body: string }?]>} */
const CALLS = [
  ["text/Ascii(0,0,2,20)"],
  ["stext/Ascii(0,0,1,20)"],
  ["json/Ascii(0,0,1,5)%20Ascii(1,0,1,5)"],
  ["text/Query(Cursor)"],
  ["stext/Ascii1(3,2,1,20)%20Query(Cursor)"],
  ["text/AsciiField"],
  ["json/ReadBuffer(Field)"],
  ['text/String("abc")'],
  ["stext/Tab()%20String(%22de%20f%22)%20Ascii(0,0,6,40)"],
  ["text/Ascii%200%200%201%205"],
  ["json/Ebcdic(2,1,10)"],
  ["text/BackTab()%20EraseEOF()%20Ascii(2,0,1,30)"],
  ["text/Bogus"],
  ["stext/Bogus"],
  ["json/Bogus"],
  ["text/Query(Cursor)%20Bogus%20Query(Cursor)"],
  ["text/Ascii(0"],
  ["json/Ascii(0"],
  ["text/Query(Cursor)%20Ascii(0"],
  ["text/%24bad"],
  ["text/Ascii(a,b,c)"],
  ["text/"],
  ["stext/"],
  ["json/"],
  ["text/%23%20only%20a%20comment"],
  ["text/MoveCursor(4,11)%20String(%22x%22)%20Ascii(4,0,1,20)"],
  ["post", { type: "text/plain", body: "Ascii(0,0,1,10) Query(Cursor)" }],
  ["post", { type: "text/plain", body: "Bogus" }],
  [
    "post",
    {
      type: "application/json",
      body: '[{"action":"Query","args":["Cursor"]},{"action":"Ascii","args":[0,0,1,5]}]',
    },
  ],
  [
    "post",
    { type: "application/json", body: '"Query(Cursor) Ascii(0,0,1,5)"' },
  ],
  [
    "post",
    { type: "application/json", body: '{"action":"Ascii1","args":[1,1,1,8]}' },
  ],
  ["post", { type: "application/json", body: '{"bogus":1}' }],
  ["post", { type: "application/json", body: '{"action":"Bogus"}' }],
  ["post", { type: "application/json", body: '[{"action":"Query"},5]' }],
  [
    "post",
    {
      type: "application/json",
      body: '{"action":"Query","args":[{"a":1}]}',
    },
  ],
];

test(
  "REST calls answer like s3270's httpd",
  { skip: noS3270, timeout: 20_000 },
  async (t) => {
    const [ours, theirs] = await Promise.all([startOurs(t), startS3270(t)]);
    for (const [path, post] of CALLS) {
      const [mine, s3270] = await Promise.all([
        call(ours.base, path, post),
        call(theirs.base, path, post),
      ]);
      assert.equal(mine, s3270, `${path} ${post?.body ?? ""}`);
    }

    // An AID waits for the host to unlock the keyboard, as s3270 does.
    const enter = "stext/String(%22zz%22)%20Enter()%20Ascii(2,0,1,20)";
    const answered = [ours, theirs].map(async (side) => {
      const reply = call(side.base, enter);
      await side.host.waitUntil(
        () => side.host.received.includes("7d"),
        5000,
        "the AID did not reach the host",
      );
      side.host.cursor = 0;
      await side.host.sendRecords(1);
      return reply;
    });
    const [mine, s3270] = await Promise.all(answered);
    assert.equal(mine, s3270, "Enter");
    assert.match(mine, /^200\nU F U C\(127\.0\.0\.1\) I /);
  },
);

test("REST calls outside s3270's paths and verbs are refused with a code", async (t) => {
  const ours = await startOurs(t);
  const refused = async (
    /** @type {string} */ path,
    /** @type {RequestInit} */ init,
  ) => {
    const answer = await fetch(ours.base + path, init);
    return [answer.status, (await answer.json()).code];
  };
  assert.deepEqual(await refused("nothing/x", {}), [404, "E7005"]);
  assert.deepEqual(await refused("post", {}), [405, "E7006"]);
  assert.deepEqual(
    await refused("post", {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: "<x/>",
    }),
    [415, "E7007"],
  );
  assert.deepEqual(await refused("text/%E0%A4%A", {}), [400, "E7009"]);
  assert.deepEqual(
    await refused("text/Query(Cursor)%20connect(10.0.0.1)", {}),
    [403, "E7012"],
  );
  assert.deepEqual(
    await refused("post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"action":"Set","args":["printerLu","x"]}',
    }),
    [403, "E7012"],
  );
  const gone = ours.base.replace(
    /[0-9a-f-]{36}/,
    "00000000-0000-0000-0000-000000000000",
  );
  const answer = await fetch(`${gone}text/Query(Cursor)`);
  assert.equal(answer.status, 404);
  assert.equal((await answer.json()).code, "E3001");
});

test("a session started by a user answers REST calls from that user only", async (t) => {
  const ours = await startOurs(t, "alice");
  const ask = async (/** @type {Record<string, string>} */ headers) => {
    const answer = await fetch(`${ours.base}text/Query(Cursor)`, { headers });
    const body = await answer.text();
    return [
      answer.status,
      answer.status === 200 ? body : JSON.parse(body).code,
    ];
  };
  assert.deepEqual(await ask({}), [403, "E7013"]);
  assert.deepEqual(await ask({ "x-remote-user": "bob" }), [403, "E7013"]);
  assert.deepEqual(await ask({ "x-remote-user": "alice" }), [200, "2 11\r\n"]);

  const posted = await fetch(`${ours.base}post`, {
    method: "POST",
    headers: { "content-type": "text/plain", "x-remote-user": "bob" },
    body: 'String("x")',
  });
  assert.equal(posted.status, 403);
  assert.equal((await posted.json()).code, "E7013");
});

test("a session started without a user answers anyone's REST calls", async (t) => {
  const ours = await startOurs(t, "");
  const answer = await fetch(`${ours.base}text/Query(Cursor)`, {
    headers: { "x-remote-user": "bob" },
  });
  assert.equal(answer.status, 200);
});
