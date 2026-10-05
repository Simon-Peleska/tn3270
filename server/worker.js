// One thread of the server's sessions (registry.js starts them): everything a session does,
// from the emulator to the JSON a browser gets, happens here. The main thread only owns the
// sockets, so it passes each websocket frame in and each finished message out as a string.
import { parentPort, workerData } from "node:worker_threads";
import { Session } from "./session.js";
import { parseClientMessage } from "./protocol.js";
import { AppError, describeError } from "./errors.js";
import { setLogLevel, setLogSink, logger } from "./log.js";

const port = /** @type {import("node:worker_threads").MessagePort} */ (
  parentPort
);
/** @type {import('./config.js').Config} */
const config = workerData.config;
setLogLevel(config.logLevel);
setLogSink((line) => port.postMessage(["log", line]));
const log = logger("worker");

/** @type {Map<string, Session>} */
const sessions = new Map();
/** @type {Map<string, { session: Session, viewer: import('./session.js').Viewer }>} */
const viewers = new Map();

/** @param {string} id */
function getSession(id) {
  const session = sessions.get(id);
  if (session === undefined) throw new AppError("E3001", id);
  return session;
}

/** @param {number} request @param {() => Promise<unknown> | unknown} work */
async function answer(request, work) {
  try {
    port.postMessage(["reply", request, await work()]);
  } catch (err) {
    const { code, summary } = describeError(err);
    if (code === "E0000") log.error(err);
    port.postMessage(["reply", request, undefined, { code, summary }]);
  }
}

port.on("message", (/** @type {any[]} */ message) => {
  const [type] = message;

  if (type === "message") {
    const [, viewerId, text] = message;
    const entry = viewers.get(viewerId);
    if (entry === undefined) return;
    try {
      entry.session.handleClientMessage(entry.viewer, parseClientMessage(text));
    } catch (err) {
      const { code, summary } = describeError(err);
      log.warn("bad client message", {
        session: entry.session.id,
        viewer: viewerId,
        code,
        summary,
      });
      entry.viewer.sendMessage({ type: "error", code, message: summary });
    }
    return;
  }

  if (type === "attach") {
    const [, viewerId, sessionId, client, pass] = message;
    // What a viewer is sent in one turn, a paint and the status with it, goes
    // out as one frame: an array when there is more than one message.
    /** @type {import('./protocol.js').ServerMessage[] | null} */
    let outbox = null;
    /** @type {import('./session.js').Viewer} */
    const viewer = {
      id: viewerId,
      role: "observer",
      ip: client.ip,
      user: client.user,
      pass,
      sendMessage: (msg) => {
        if (outbox === null) {
          outbox = [];
          queueMicrotask(() => {
            const batch = /** @type {any[]} */ (outbox);
            outbox = null;
            const frame = batch.length === 1 ? batch[0] : batch;
            port.postMessage(["send", viewerId, JSON.stringify(frame)]);
          });
        }
        outbox.push(msg);
      },
      // Behind the messages still in the outbox, which say why.
      close: (code = 1008, reason = "refused") =>
        queueMicrotask(() =>
          port.postMessage(["close", viewerId, code, reason]),
        ),
    };
    try {
      const session = getSession(sessionId);
      session.attach(viewer);
      viewers.set(viewerId, { session, viewer });
    } catch (err) {
      const { code, summary } = describeError(err);
      log.error(err, { session: sessionId, viewer: viewerId, ...client });
      viewer.sendMessage({ type: "error", code, message: summary });
      viewer.close(1013, code);
    }
    return;
  }

  if (type === "detach") {
    const [, viewerId] = message;
    const entry = viewers.get(viewerId);
    if (entry === undefined) return;
    viewers.delete(viewerId);
    entry.session.detach(entry.viewer);
    return;
  }

  if (type === "create") {
    const [, request, client] = message;
    answer(request, async () => {
      const session = new Session(config);
      session.startedBy = client.user || client.ip || "Unknown";
      session.onClosed = () => {
        sessions.delete(session.id);
        for (const [viewerId, entry] of viewers)
          if (entry.session === session) viewers.delete(viewerId);
        port.postMessage(["closed", session.id]);
      };
      sessions.set(session.id, session);
      if (config.emulator.defaultHost !== null)
        session.connect(config.emulator.defaultHost);
      await session.ready;
      return {
        id: session.id,
        rows: session.screen.rows,
        cols: session.screen.cols,
        model: session.model,
      };
    });
    return;
  }

  if (type === "terminate") {
    const [, request, id, pass] = message;
    answer(request, () => getSession(id).terminate(pass));
    return;
  }

  if (type === "list") {
    const [, request] = message;
    answer(request, () =>
      [...sessions.values()].map((session) => ({
        id: session.id,
        viewers: session.viewers.size,
        connection: session.oia.connectionState,
        host: session.oia.host,
        startedAt: session.startedAt,
        startedBy: session.startedBy,
      })),
    );
    return;
  }

  if (type === "closeAll") {
    for (const session of [...sessions.values()]) session.close();
  }
});
