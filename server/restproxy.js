import { createServer } from 'node:net';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { AppError } from './errors.js';

/**
 * b3270 carries s3270's own REST interface — the same httpd code, linked into
 * both programs — so every session's emulator serves it directly and this app
 * only forwards.
 *
 * @typedef {object} RestEndpoint
 * @property {number} port loopback only, one per session
 * @property {string} cookie the x3270-security cookie guarding that port
 */

/**
 * Reserves a loopback port for one b3270's httpd, with the cookie that keeps
 * everyone else off it.
 *
 * The port is bound and released again rather than left to b3270: given `:0`
 * it does pick a free port, but reports back the literal `:0`, so there is no
 * way to learn the number. If the port is taken again in the moment between,
 * b3270 says so — `httpd bind: Address already in use`, as a popup indication
 * that is logged — and every REST call for that session then fails with E7003.
 *
 * The cookie matters more than the port: without `-cookiefile` any local
 * process could drive the session by guessing ports, since b3270's httpd has
 * no other notion of who is asking.
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
 * Hands one request to the session's own b3270 httpd and copies the answer
 * back verbatim — status, content type and body. Nothing is parsed on the way
 * through, so an s3270 REST client sees exactly what a real s3270 would have
 * said, error wording included.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('./session.js').Session} session
 * @param {string} target path and query, from `/3270/` on, still as sent
 * @returns {Promise<unknown>}
 */
export async function proxyRestRequest(req, res, session, target) {
  const endpoint = session.b3270.rest;
  if (endpoint === null) throw new AppError('E7002', session.id);

  const method = req.method ?? 'GET';
  session.log.info('REST proxying', { method, target });

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
        session.log.info('REST proxied', { target, status: answer.statusCode ?? 0 });
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
