import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { setLogFile, setLogLevel, logger } from "./log.js";
import { SessionRegistry } from "./registry.js";
import { parseClientMessage } from "./protocol.js";
import { AppError, describeError } from "./errors.js";
import { proxyRestRequest } from "./restproxy.js";

const config = loadConfig(process.env["TN3270_CONFIG"] ?? "config.jsonc");
setLogLevel(config.logLevel);
if (config.logFile !== "") setLogFile(config.logFile, config.logMaxBytes);
const log = logger("http");

const registry = new SessionRegistry(config);

const ROOT = resolve(".");

async function gitDirectory() {
  const dotGit = join(ROOT, ".git");

  // Worktrees use a .git file pointing at the real git directory.
  try {
    const text = await readFile(dotGit, "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(text);
    if (match?.[1]) return resolve(ROOT, match[1].trim());
  } catch {
    // Normal checkout: .git is a directory.
  }

  return dotGit;
}

async function currentRevision() {
  const injected = process.env["TN3270_REV"]?.trim();
  if (injected) return injected;

  try {
    const dir = await gitDirectory();
    const head = (await readFile(join(dir, "HEAD"), "utf8")).trim();

    // Detached HEAD.
    if (/^[0-9a-f]{40,64}$/i.test(head)) return head;

    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (ref === undefined) return "unknown";

    // Normal loose ref.
    try {
      return (await readFile(join(dir, ref), "utf8")).trim();
    } catch {
      // Ref may be in packed-refs.
    }

    const packed = await readFile(join(dir, "packed-refs"), "utf8");
    const line = packed
      .split(/\r?\n/)
      .find((line) => line.endsWith(` ${ref}`));

    return line?.split(" ")[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

const REVISION = await currentRevision();

const PUBLIC_DIR = join(ROOT, "public");

/** @type {Readonly<Record<string, string>>} */
const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
});

/** Vendored fonts, three quarters of the page's weight, and never edited. */
const IMMUTABLE = new Set([".ttf", ".woff2"]);

/** @type {Readonly<Record<string, number>>} Anything not named here is a 500. */
const ERROR_STATUS = Object.freeze({
  E3001: 404,
  E3014: 403,
  E6001: 404,
});

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} dir
 * @param {string} relative
 * @returns {Promise<void>}
 */
async function sendFile(res, dir, relative) {
  // Decode first: a percent-encoded `..` is still a traversal attempt.
  /** @type {string} */
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch (cause) {
    throw new AppError("E6001", relative, cause);
  }

  const file = join(dir, normalize(decoded));
  if (!file.startsWith(dir)) throw new AppError("E6001", relative);

  /** @type {Buffer} */
  let content;
  try {
    content = await readFile(file);
  } catch (cause) {
    throw new AppError("E6001", relative, cause);
  }

  const ext = extname(file);
  /** @type {Record<string, string>} */
  const headers = {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "content-length": String(content.byteLength),
  };
  if (IMMUTABLE.has(ext))
    headers["cache-control"] = "public, max-age=31536000, immutable";
  res.writeHead(200, headers);
  res.end(content);
}

/**
 * First value only, cut short: headers are sender-controlled and get logged.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name
 * @returns {string}
 */
function header(req, name) {
  const raw = req.headers[name];
  const first = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  return first.split(",")[0]?.trim().slice(0, 64) ?? "";
}

/**
 * Proxy headers are client-controlled unless a proxy really is in front, so
 * they are only believed when `security.trustProxyHeaders` says so.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ip: string, user: string }}
 */
function clientIdentity(req) {
  // Node reports an IPv4 client on a dual-stack listener as `::ffff:127.0.0.1`.
  const address = req.socket.remoteAddress ?? "";
  const socketIp = address.startsWith("::ffff:")
    ? address.slice("::ffff:".length)
    : address;
  if (!config.security.trustProxyHeaders) return { ip: socketIp, user: "" };

  // Leftmost is the original client: each proxy appends its own peer.
  const forwarded = header(req, "x-forwarded-for");
  return {
    ip: forwarded === "" ? socketIp : forwarded,
    user: header(req, "x-remote-user"),
  };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function handleRequest(req, res) {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;
  const client = clientIdentity(req);
  log.info("request", { method: req.method ?? "", path, ...client });

  if (path === "/api/version" && req.method === "GET") {
    sendJson(res, 200, { revision: REVISION });
    return;
  }

  if (path === "/api/sessions" && req.method === "POST") {
    const session = await registry.create(client);
    await session.ready;
    sendJson(res, 201, {
      id: session.id,
      rows: session.screen.rows,
      cols: session.screen.cols,
      model: session.model,
    });
    return;
  }

  const terminateMatch = /^\/api\/sessions\/([0-9a-fA-F-]{36})$/.exec(path);
  if (terminateMatch !== null && req.method === "DELETE") {
    registry.terminate(
      String(terminateMatch[1]),
      header(req, "x-session-pass"),
    );
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === "/api/sessions" && req.method === "GET") {
    sendJson(res, 200, {
      sessions: registry.list(),
      defaultHost: config.b3270.defaultHost,
    });
    return;
  }

  // Matched on the raw target, not the parsed path: percent-encoded action
  // arguments must reach b3270 exactly as sent.
  const restMatch = /^\/api\/sessions\/([0-9a-fA-F-]{36})(\/3270\/.*)$/.exec(
    req.url ?? "",
  );
  if (restMatch !== null) {
    const session = registry.get(String(restMatch[1]));
    await proxyRestRequest(req, res, session, String(restMatch[2]), client);
    return;
  }

  await sendFile(res, PUBLIC_DIR, path === "/" ? "index.html" : path);
}

const server = createServer((req, res) => {
  res.on("finish", () => {
    log.info("response", {
      method: req.method ?? "",
      path: req.url ?? "",
      status: res.statusCode,
    });
  });
  handleRequest(req, res).catch((err) => {
    const { code, summary } = describeError(err);
    log.error(err, { path: req.url ?? "" });
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, ERROR_STATUS[code] ?? 500, { code, message: summary });
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
const MAX_VIEWER_BUFFERED_BYTES = 1024 * 1024;

server.on("upgrade", (req, socket, head) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const client = clientIdentity(req);
  const match = /^\/ws\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
  if (match === null) {
    const err = new AppError("E6002", url.pathname);
    log.error(err, { path: url.pathname, ...client });
    socket.write(
      `HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\n\r\n${err.message}`,
    );
    socket.destroy();
    return;
  }

  /** @type {import('./session.js').Session} */
  let session;
  try {
    session = registry.get(String(match[1]));
  } catch (err) {
    const { code, summary } = describeError(err);
    log.error(err, { path: url.pathname, ...client });
    socket.write(
      `HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\n\r\n[${code}] ${summary}`,
    );
    socket.destroy();
    return;
  }

  const pass = url.searchParams.get("pass") ?? undefined;
  wss.handleUpgrade(req, socket, head, (ws) =>
    attachViewer(session, ws, client, pass),
  );
});

/**
 * @param {import('./session.js').Session} session
 * @param {import('ws').WebSocket} ws
 * @param {{ ip: string, user: string }} client
 * @param {string | undefined} pass from an earlier hello: the owner's, or a guest's let in before
 * @returns {void}
 */
function attachViewer(session, ws, client, pass) {
  /** @type {import('./session.js').Viewer} */
  const viewer = {
    id: randomUUID().slice(0, 8),
    role: "observer",
    ip: client.ip,
    user: client.user,
    pass,
    sendMessage(message) {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_VIEWER_BUFFERED_BYTES) {
        viewerLog.error(new AppError("E6010", viewer.id), {
          bufferedBytes: ws.bufferedAmount,
        });
        ws.close(1013, "E6010");
        return;
      }
      ws.send(JSON.stringify(message));
    },
    close(code = 1008, reason = "refused") {
      ws.close(code, reason);
    },
  };

  const viewerLog = log.with({
    session: session.id,
    viewer: viewer.id,
    ...client,
  });

  try {
    session.attach(viewer);
  } catch (err) {
    const { code, summary } = describeError(err);
    viewerLog.error(err);
    viewer.sendMessage({ type: "error", code, message: summary });
    ws.close(1013, code);
    return;
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    try {
      session.handleClientMessage(viewer, parseClientMessage(String(data)));
    } catch (err) {
      const { code, summary } = describeError(err);
      viewerLog.warn("bad client message", { code, summary });
      viewer.sendMessage({ type: "error", code, message: summary });
    }
  });

  ws.on("close", (code, reason) => {
    viewerLog.info("viewer socket closed", { code, reason: String(reason) });
    session.detach(viewer);
  });

  ws.on("error", (cause) => {
    viewerLog.error(new AppError("E6003", viewer.id, cause));
    session.detach(viewer);
  });
}

server.on("error", (cause) => {
  log.error(
    new AppError("E6004", `${config.server.host}:${config.server.port}`, cause),
  );
  process.exitCode = 1;
});

server.listen(config.server.port, config.server.host, () => {
  log.info("listening", {
    url: `http://${config.server.host}:${config.server.port}`,
  });
});

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  process.on(signal, () => {
    log.info("shutting down", { signal, viewers: wss.clients.size });
    registry.closeAll();
    // Open WebSockets keep `server.close()` from ever calling back.
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
