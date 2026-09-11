import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { setLogLevel, logger } from './log.js';
import { SessionRegistry } from './session.js';
import { parseClientMessage } from './protocol.js';
import { AppError, describeError } from './errors.js';

const config = loadConfig(process.env['TN3270_CONFIG'] ?? 'config.jsonc');
setLogLevel(config.logLevel);
const log = logger('http');

const registry = new SessionRegistry(config);

const ROOT = resolve('.');
const PUBLIC_DIR = join(ROOT, 'public');
// ghostty-web is served straight out of node_modules so the package's own
// layout is preserved and its wasm resolves relative to the module URL.
const VENDOR_DIR = join(ROOT, 'node_modules', 'ghostty-web');

/** @type {Readonly<Record<string, string>>} */
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
});

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * Serve one file out of a directory, refusing anything that escapes it.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} dir
 * @param {string} relative
 * @returns {Promise<void>}
 */
async function sendFile(res, dir, relative) {
  // Decode first: a percent-encoded `..` is still a traversal attempt, and it
  // has to be resolved before the containment check to mean anything.
  /** @type {string} */
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch (cause) {
    throw new AppError('E6001', relative, cause);
  }

  const file = join(dir, normalize(decoded));
  if (!file.startsWith(dir)) throw new AppError('E6001', relative);

  /** @type {Buffer} */
  let content;
  try {
    content = await readFile(file);
  } catch (cause) {
    throw new AppError('E6001', relative, cause);
  }

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(content);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  log.info('request', { method: req.method ?? '', path });

  if (path === '/api/sessions' && req.method === 'POST') {
    const session = registry.create();
    await session.ready;
    sendJson(res, 201, {
      id: session.id,
      rows: session.screen.rows,
      cols: session.screen.cols,
      model: session.model,
    });
    return;
  }

  if (path === '/api/sessions' && req.method === 'GET') {
    sendJson(res, 200, { sessions: registry.list(), defaultHost: config.b3270.defaultHost });
    return;
  }

  if (path.startsWith('/vendor/')) {
    await sendFile(res, VENDOR_DIR, path.slice('/vendor/'.length));
    return;
  }

  await sendFile(res, PUBLIC_DIR, path === '/' ? 'index.html' : path);
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    const { code, summary } = describeError(err);
    log.error(err, { path: req.url ?? '' });
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, code === 'E6001' ? 404 : 500, { code, message: summary });
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const match = /^\/ws\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
  if (match === null) {
    log.warn('rejecting upgrade', { path: url.pathname });
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  /** @type {import('./session.js').Session} */
  let session;
  try {
    session = registry.get(String(match[1]));
  } catch (err) {
    const { code, summary } = describeError(err);
    log.error(err, { path: url.pathname });
    socket.write(`HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\n\r\n[${code}] ${summary}`);
    socket.destroy();
    return;
  }

  // Read before the terminal exists, so the very first repaint already
  // matches the browser's saved preference instead of flashing host colours
  // for one frame and then correcting itself.
  const hostColors = url.searchParams.get('hostColors') !== '0';
  const requested = url.searchParams.get('fieldColor');
  const fieldColor = requested !== null && /^#[0-9a-fA-F]{6}$/.test(requested) ? requested : null;

  wss.handleUpgrade(req, socket, head, (ws) => attachViewer(session, ws, hostColors, fieldColor));
});

/**
 * @param {import('./session.js').Session} session
 * @param {import('ws').WebSocket} ws
 * @param {boolean} hostColors
 * @param {string | null} fieldColor
 * @returns {void}
 */
function attachViewer(session, ws, hostColors, fieldColor) {
  /** @type {import('./session.js').Viewer} */
  const viewer = {
    id: randomUUID().slice(0, 8),
    role: 'observer',
    hostColors,
    fieldColor,
    // Screen output goes in binary frames, control traffic in text frames. The
    // frame type is the discriminator, so neither needs an envelope.
    sendScreen(bytes) {
      if (ws.readyState === ws.OPEN) ws.send(Buffer.from(bytes, 'utf8'), { binary: true });
    },
    sendMessage(message) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    },
  };

  try {
    session.attach(viewer);
  } catch (err) {
    const { code, summary } = describeError(err);
    log.error(err, { session: session.id });
    viewer.sendMessage({ type: 'error', code, message: summary });
    ws.close(1013, code);
    return;
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      session.handleClientMessage(viewer, parseClientMessage(String(data)));
    } catch (err) {
      const { code, summary } = describeError(err);
      log.warn('bad client message', { viewer: viewer.id, code, summary });
      viewer.sendMessage({ type: 'error', code, message: summary });
    }
  });

  ws.on('close', (code, reason) => {
    log.info('viewer socket closed', { viewer: viewer.id, code, reason: String(reason) });
    session.detach(viewer);
  });

  ws.on('error', (cause) => {
    log.error(new AppError('E4004', viewer.id, cause), { session: session.id });
    session.detach(viewer);
  });
}

server.on('error', (cause) => {
  log.error(new AppError('E6004', `${config.server.host}:${config.server.port}`, cause));
  process.exitCode = 1;
});

server.listen(config.server.port, config.server.host, () => {
  log.info('listening', { url: `http://${config.server.host}:${config.server.port}` });
});

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => {
    log.info('shutting down', { signal, viewers: wss.clients.size });
    registry.closeAll();
    // Open WebSockets keep `server.close()` from ever calling back, so the
    // viewers have to be dropped explicitly or the process hangs on exit.
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
