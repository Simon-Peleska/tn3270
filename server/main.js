import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer } from "../vendor/ws.mjs";
import { loadConfig } from "./config.js";
import { setLogFile, setLogLevel, logger } from "./log.js";
import { SessionRegistry } from "./registry.js";
import { AppError, describeError } from "./errors.js";
import { checkVendoredWs } from "./vendorcheck.js";
import { USER_DATA_KEYS, openUserData, ownerOf } from "./userdata.js";

const config = loadConfig(process.env["TN3270_CONFIG"] ?? "config.jsonc");
setLogLevel(config.logLevel);
if (config.logFile !== "") setLogFile(config.logFile, config.logMaxBytes);
const log = logger("http");

try {
  checkVendoredWs();
} catch (err) {
  log.error(err);
}

const registry = new SessionRegistry(config);
const userData = openUserData(config.userDataFile);

// Recordings carry a full styled screen per step, so they are the big one.
const MAX_USER_DATA_BYTES = 32 * 1024 * 1024;

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
    const line = packed.split(/\r?\n/).find((line) => line.endsWith(` ${ref}`));

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
  ".woff2": "font/woff2",
});

/** Vendored fonts, three quarters of the page's weight, and never edited. */
const IMMUTABLE = new Set([".woff2"]);

/** @type {Readonly<Record<string, number>>} Anything not named here is a 500. */
const ERROR_STATUS = Object.freeze({
  E3001: 404,
  E3014: 403,
  E6001: 404,
  E8004: 404,
  E8005: 413,
  E8006: 400,
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
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBody(req, maxBytes) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new AppError("E8005", `over ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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

  if (path === "/api/userdata" && req.method === "GET") {
    sendJson(res, 200, userData.load(ownerOf(client)));
    return;
  }

  const userDataMatch = /^\/api\/userdata\/([a-z]+)$/.exec(path);
  if (userDataMatch !== null && req.method === "PUT") {
    const key = USER_DATA_KEYS.find((name) => name === userDataMatch[1]);
    if (key === undefined) throw new AppError("E8004", userDataMatch[1]);
    const json = await readBody(req, MAX_USER_DATA_BYTES);
    try {
      JSON.parse(json);
    } catch (cause) {
      throw new AppError("E8006", key, cause);
    }
    const owner = ownerOf(client);
    userData.save(owner, key, json);
    log.info("user data saved", { owner, key, bytes: json.length });
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === "/api/sessions" && req.method === "POST") {
    sendJson(res, 201, await registry.create(client));
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
      defaultHost: config.emulator.defaultHost,
    });
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

  const id = String(match[1]);
  try {
    registry.get(id);
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
    attachViewer(id, ws, socket, client, pass),
  );
});

/**
 * @param {string} id
 * @param {import('ws').WebSocket} ws
 * @param {import('node:stream').Duplex} socket the connection under `ws`
 * @param {{ ip: string, user: string }} client
 * @param {string | undefined} pass from an earlier hello: the owner's, or a guest's let in before
 * @returns {void}
 */
function attachViewer(id, ws, socket, client, pass) {
  /** @type {ReturnType<SessionRegistry["attach"]>} */
  let viewer;
  // Under load a viewer's frames pile up within a turn, and a system call per
  // frame would be much of what the server does.
  let corked = false;
  try {
    viewer = registry.attach(id, client, pass, {
      send(text) {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_VIEWER_BUFFERED_BYTES) {
          viewerLog.error(new AppError("E6010", viewer.viewerId), {
            bufferedBytes: ws.bufferedAmount,
          });
          ws.close(1013, "E6010");
          return;
        }
        if (!corked) {
          corked = true;
          socket.cork();
          setImmediate(() => {
            corked = false;
            socket.uncork();
          });
        }
        ws.send(text);
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    });
  } catch (err) {
    const { code, summary } = describeError(err);
    log.error(err, { session: id, ...client });
    ws.send(JSON.stringify({ type: "error", code, message: summary }));
    ws.close(1013, code);
    return;
  }

  const viewerLog = log.with({
    session: id,
    viewer: viewer.viewerId,
    ...client,
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    viewer.message(String(data));
  });

  ws.on("close", (code, reason) => {
    viewerLog.info("viewer socket closed", { code, reason: String(reason) });
    viewer.detach();
  });

  ws.on("error", (cause) => {
    viewerLog.error(new AppError("E6003", viewer.viewerId, cause));
    viewer.detach();
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
    server.close(() => {
      userData.close();
      process.exit(0);
    });
  });
}
