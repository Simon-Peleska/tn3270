import { readFileSync } from 'node:fs';
import { AppError } from './errors.js';

/**
 * @typedef {object} Config
 * @property {{ host: string, port: number }} server
 * @property {{ path: string, model: number, defaultHost: string | null, settings: Record<string, string>, extraArgs: string[] }} b3270
 * @property {{ maxSessions: number, maxViewersPerSession: number, idleTimeoutMs: number, allowMultipleControllers: boolean }} sessions
 * @property {{ allowedHosts: string[], trustProxyHeaders: boolean }} security
 * @property {'debug' | 'info' | 'warn' | 'error'} logLevel
 * @property {string} logFile Empty is stderr only.
 * @property {number} logMaxBytes Size at which the log rolls to `<logFile>.1`.
 */

/**
 * JSONC in, JSON out. Comments and trailing commas become spaces rather than
 * being deleted, so JSON.parse's byte offsets still point at the right place.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripJsonc(text) {
  const out = text.split('');
  let inString = false;
  let comma = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      out[i] = ' ';
      i++;
      while (i < text.length) {
        const closing = text[i] === '*' && text[i + 1] === '/';
        if (text[i] !== '\n') out[i] = ' ';
        if (closing) {
          out[i + 1] = ' ';
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;

    if (ch === ',') {
      comma = i;
      continue;
    }

    if (ch === '}' || ch === ']') {
      if (comma !== -1) out[comma] = ' ';
    } else if (ch === '"') {
      inString = true;
    }
    comma = -1;
  }

  return out.join('');
}

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (cause) {
    throw new AppError('E1002', cause instanceof Error ? cause.message : String(cause), cause);
  }
}

/** @type {Config} */
const DEFAULTS = {
  server: { host: '127.0.0.1', port: 8017 },
  b3270: { path: 'b3270', model: 2, defaultHost: null, settings: {}, extraArgs: [] },
  sessions: {
    maxSessions: 16,
    maxViewersPerSession: 8,
    idleTimeoutMs: 300000,
    allowMultipleControllers: false,
  },
  security: { allowedHosts: [], trustProxyHeaders: false },
  logLevel: 'info',
  logFile: 'log/tn3270.log',
  logMaxBytes: 10 * 1024 * 1024,
};

/**
 * @param {Record<string, unknown>} source
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function section(source, path) {
  const value = source[path];
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('E1003', `"${path}" must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function str(obj, key, name, fallback) {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new AppError('E1003', `"${name}" must be a string`);
  return value;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function num(obj, key, name, fallback, min, max) {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError('E1003', `"${name}" must be a number`);
  }
  if (value < min || value > max) {
    throw new AppError('E1004', `"${name}" must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
function bool(obj, key, name, fallback) {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new AppError('E1003', `"${name}" must be a boolean`);
  return value;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {string} name
 * @param {string[]} fallback
 * @returns {string[]}
 */
function strArray(obj, key, name, fallback) {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new AppError('E1003', `"${name}" must be an array of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new AppError('E1003', `"${name}[${index}]" must be a string`);
    }
    return entry;
  });
}

/**
 * A bare name (`oversize`) is qualified as `b3270.oversize`; one written out in
 * full (`*oversize`) is passed to the emulator as given.
 *
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {string} name
 * @returns {Record<string, string>}
 */
function resources(obj, key, name) {
  const value = obj[key];
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('E1003', `"${name}" must be an object of resource names to values`);
  }

  /** @type {Record<string, string>} */
  const out = {};
  for (const [resource, raw] of Object.entries(value)) {
    if (!/^\*?[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(resource)) {
      throw new AppError('E1005', `"${name}.${resource}"`);
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      throw new AppError('E1003', `"${name}.${resource}" must be a string, number or boolean`);
    }
    out[resource] = String(raw);
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {Config}
 */
export function validateConfig(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError('E1003', 'config root must be an object');
  }
  const root = /** @type {Record<string, unknown>} */ (raw);

  const serverSection = section(root, 'server');
  const b3270Section = section(root, 'b3270');
  const sessionsSection = section(root, 'sessions');
  const securitySection = section(root, 'security');

  const model = num(b3270Section, 'model', 'b3270.model', DEFAULTS.b3270.model, 2, 5);
  if (!Number.isInteger(model)) throw new AppError('E1004', '"b3270.model" must be a whole number');

  const rawDefaultHost = b3270Section['defaultHost'];
  if (rawDefaultHost !== undefined && rawDefaultHost !== null && typeof rawDefaultHost !== 'string') {
    throw new AppError('E1003', '"b3270.defaultHost" must be a string or null');
  }

  const logLevel = str(root, 'logLevel', 'logLevel', DEFAULTS.logLevel);
  if (logLevel !== 'debug' && logLevel !== 'info' && logLevel !== 'warn' && logLevel !== 'error') {
    throw new AppError('E1004', `"logLevel" must be debug, info, warn or error, got "${logLevel}"`);
  }

  return {
    server: {
      host: str(serverSection, 'host', 'server.host', DEFAULTS.server.host),
      port: num(serverSection, 'port', 'server.port', DEFAULTS.server.port, 1, 65535),
    },
    b3270: {
      path: str(b3270Section, 'path', 'b3270.path', DEFAULTS.b3270.path),
      model,
      defaultHost: rawDefaultHost === undefined ? null : rawDefaultHost,
      settings: resources(b3270Section, 'settings', 'b3270.settings'),
      extraArgs: strArray(b3270Section, 'extraArgs', 'b3270.extraArgs', DEFAULTS.b3270.extraArgs),
    },
    sessions: {
      maxSessions: num(sessionsSection, 'maxSessions', 'sessions.maxSessions', DEFAULTS.sessions.maxSessions, 1, 1000),
      maxViewersPerSession: num(sessionsSection, 'maxViewersPerSession', 'sessions.maxViewersPerSession', DEFAULTS.sessions.maxViewersPerSession, 1, 1000),
      idleTimeoutMs: num(sessionsSection, 'idleTimeoutMs', 'sessions.idleTimeoutMs', DEFAULTS.sessions.idleTimeoutMs, 0, 86400000),
      allowMultipleControllers: bool(sessionsSection, 'allowMultipleControllers', 'sessions.allowMultipleControllers', DEFAULTS.sessions.allowMultipleControllers),
    },
    security: {
      allowedHosts: strArray(securitySection, 'allowedHosts', 'security.allowedHosts', DEFAULTS.security.allowedHosts),
      trustProxyHeaders: bool(securitySection, 'trustProxyHeaders', 'security.trustProxyHeaders', DEFAULTS.security.trustProxyHeaders),
    },
    logLevel,
    logFile: str(root, 'logFile', 'logFile', DEFAULTS.logFile),
    logMaxBytes: num(root, 'logMaxBytes', 'logMaxBytes', DEFAULTS.logMaxBytes, 4096, 1024 * 1024 * 1024),
  };
}

/**
 * @param {string} file
 * @returns {Config}
 */
export function loadConfig(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new AppError('E1001', file, cause);
  }
  return validateConfig(parseJsonc(text));
}
