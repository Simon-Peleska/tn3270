import test from "node:test";
import assert from "node:assert/strict";
import {
  createSessionRequest,
  listSessions,
  liveSessionIds,
} from "../public/session-api.js";

test("session API uses one response shape for create and list", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  /** @type {string[]} */
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(options?.method ?? "GET");
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
  assert.deepEqual(await liveSessionIds(), new Set(["created"]));
  assert.deepEqual(requests, ["POST", "GET", "GET"]);
});

test("session API surfaces a coded error while the live check tolerates downtime", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    Response.json({ code: "E3002", message: "session limit" }, { status: 500 });
  await assert.rejects(createSessionRequest(), /\[E3002\] session limit/);
  await assert.rejects(listSessions(), /\[E3002\] session limit/);
  assert.equal(await liveSessionIds(), null);
});
