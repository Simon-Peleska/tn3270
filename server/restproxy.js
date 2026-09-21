import { createServer } from 'node:net';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { AppError } from './errors.js';

/**
 * b3270 carries s3270's own httpd, so each session's emulator serves REST
 * itself and this module only forwards.
 *
 * @typedef {object} RestEndpoint
 * @property {number} port loopback only, one per session
 * @property {string} cookie the x3270-security cookie guarding that port
 */

/**
 * The port is bound and released rather than left to b3270, which takes `:0`
 * but then reports back the literal `:0`, leaving no way to learn the number.
 * The cookie is the only thing keeping other local processes off that port.
 *
 * @returns {Promise<RestEndpoint>}
 */
export function reserveRestEndpoint() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
      probe.close(() => resolve({ port, cookie: randomBytes(32).toString('hex') }));
    });
  });
}

/**
 * Copies the answer back verbatim and parses nothing, so a client sees exactly
 * what a real s3270 would have said.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('./session.js').Session} session
 * @param {string} target path and query from `/3270/` on, still as sent
 * @param {{ ip: string, user: string }} [client]
 * @returns {Promise<unknown>}
 */
export async function proxyRestRequest(req, res, session, target, client = { ip: '', user: '' }) {
  const log = session.log.with(client);
  const method = req.method ?? 'GET';

  const endpoint = session.b3270.rest;
  if (endpoint === null) throw new AppError('E7002', session.id);
  if (!session.allowAutomation) {
    log.warn('REST refused: automation is off for this session', { method, target });
    throw new AppError('E7004', session.id);
  }

  log.info('REST proxying', { method, target });

  return new Promise((resolve, reject) => {
    const upstream = request(
      {
        host: '127.0.0.1',
        port: endpoint.port,
        method,
        path: target,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${endpoint.port}`,
          cookie: `x3270-security=${endpoint.cookie}`,
        },
      },
      (answer) => {
        log.info('REST proxied', { target, status: answer.statusCode ?? 0 });
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
        answer.on('end', resolve);
        answer.on('error', reject);
      },
    );

    upstream.on('error', (cause) => {
      reject(new AppError('E7003', `${session.id} to 127.0.0.1:${endpoint.port}${target}`, cause));
    });
    req.pipe(upstream);
  });
}
