import { readFileSync } from 'node:fs';
import { AppError } from './errors.js';

/**
 * @typedef {object} Config
 * @property {{ host: string, port: number }} server
 * @property {{ path: string, model: number, defaultHost: string | null, settings: Record<string, string>, extraArgs: string[] }} b3270
 * @property {{ maxSessions: number, maxViewersPerSession: number, idleTimeoutMs: number, allowMultipleControllers: boolean }} sessions
 * @property {{ allowedHosts: string[] }} security
 * @property {'debug' | 'info' | 'warn' | 'error'} logLevel
 */

/**
 * Strip comments from JSONC by scanning characters, so that `//` and `/*`
 * inside string literals survive. Comments are replaced by spaces rather than
 * removed, which keeps byte offsets intact for JSON.parse error messages.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  const out = text.split('');
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      else out[i] = ' ';
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i++;
        inBlockComment = false;
      } else if (ch !== '\n') {
        out[i] = ' ';
      }
      continue;
    }

    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '/' && next === '/') {
      inLineComment = true;
      out[i] = ' ';
    } else if (ch === '/' && next === '*') {
      inBlockComment = true;
      out[i] = ' ';
    }
  }

  return out.join('');
}

/**
 * Trailing commas are legal in JSONC but not in JSON. Only safe to run after
 * comments are gone and only outside strings, so it shares the scanner's rules.
 * @param {string} text
 * @returns {string}
 */
function stripTrailingCommas(text) {
  const out = text.split('');
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch !== ',') continue;

    for (let j = i + 1; j < text.length; j++) {
      const ahead = text[j];
      if (ahead === ' ' || ahead === '\t' || ahead === '\n' || ahead === '\r') continue;
      if (ahead === '}' || ahead === ']') out[i] = ' ';
      break;
    }
  }

  return out.join('');
}

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
  const plain = stripTrailingCommas(stripJsonComments(text));
  try {
    return JSON.parse(plain);
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
  security: { allowedHosts: [] },
  logLevel: 'info',
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
 * Any b3270 resource, set from the config file. b3270 takes arbitrary resources
 * on the command line as `-xrm "b3270.<name>: <value>"`, so this is the one
 * mechanism that covers every setting the emulator has without this project
 * having to know a single one of their names.
 *
 * A name may be given bare (`oversize`) and is qualified as `b3270.oversize`, or
 * written out in full (`b3270.oversize`, `*oversize`) when a resource needs a
 * different qualifier.
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
 * Validate a parsed config object, filling in defaults for anything absent.
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
    },
    logLevel,
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
