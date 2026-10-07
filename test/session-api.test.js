import test from "node:test";
import assert from "node:assert/strict";
import {
  createSessionRequest,
  listSessions,
  terminateSession,
} from "../public/session-api.js";

test("session API uses one response shape for create and list", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  /** @type {string[]} */
  const requests = [];
  /** @type {{ method: string, headers: Record<string, string> }} */
  const termination = { method: "", headers: {} };
  globalThis.fetch = async (_url, options) => {
    requests.push(options?.method ?? "GET");
    if (options?.method === "DELETE") {
      termination.method = options.method;
      termination.headers = /** @type {Record<string, string>} */ (
        options.headers
      );
      return new Response(null, { status: 204 });
    }
    return Response.json(
      options?.method === "POST"
        ? { id: "created", rows: 24, cols: 80 }
        : {
            sessions: [
              { id: "created", startedBy: "test", startedAt: "2026-01-01" },
            ],
          },
    );
  };

  assert.deepEqual(await createSessionRequest(), {
    id: "created",
    rows: 24,
    cols: 80,
  });
  assert.equal((await listSessions())[0].id, "created");
  await terminateSession("created", "owner-pass");
  assert.deepEqual(requests, ["POST", "GET", "DELETE"]);
  assert.equal(termination.method, "DELETE");
  assert.deepEqual(termination.headers, { "x-session-pass": "owner-pass" });
});

test("session API surfaces a coded error", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    Response.json({ code: "E3002", message: "session limit" }, { status: 500 });
  await assert.rejects(createSessionRequest(), /\[E3002\] session limit/);
  await assert.rejects(listSessions(), /\[E3002\] session limit/);
  await assert.rejects(
    terminateSession("session", "wrong-pass"),
    /\[E3002\] session limit/,
  );
});

test("session termination preserves an owner-only error from the server", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    Response.json(
      { code: "E3014", message: "Only the session owner may terminate it" },
      { status: 403 },
    );
  await assert.rejects(
    terminateSession("session", "guest-pass"),
    /\[E3014\] Only the session owner may terminate it/,
  );
});
