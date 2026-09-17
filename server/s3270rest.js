import { AppError } from './errors.js';

/**
 * One action call in s3270's action syntax: `Name(arg1,"arg, with quotes")`.
 * Parens may be omitted for a zero-argument call (s3270's own `-httpd`
 * accepts bare `PF` and lets `PF`'s own argument-count check reject it), but
 * if present they must be balanced. A quoted argument may contain commas and
 * parens; `\"` and `\\` are the only escapes.
 *
 * @param {string} text already percent-decoded
 * @returns {{ action: string, args: string[] }}
 */
export function parseActionCall(text) {
  const trimmed = text.trim();
  const open = trimmed.indexOf('(');
  if (open === -1) return { action: trimmed, args: [] };
  if (!trimmed.endsWith(')')) throw new AppError('E7001', text);

  const action = trimmed.slice(0, open);
  const body = trimmed.slice(open + 1, -1);
  /** @type {string[]} */
  const args = [];
  let i = 0;
  // Empty parens are zero arguments, not one empty-string argument — that
  // case is spelled `(,)` instead, per s3270's own action-syntax rules.
  while (body.length > 0 && i <= body.length) {
    if (body[i] === '"') {
      let arg = '';
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === '\\' && i + 1 < body.length) {
          arg += body[i + 1];
          i += 2;
        } else {
          arg += body[i];
          i++;
        }
      }
      if (body[i] !== '"') throw new AppError('E7001', text);
      i++;
      args.push(arg);
    } else {
      const start = i;
      while (i < body.length && body[i] !== ',') i++;
      args.push(body.slice(start, i));
    }
    if (i >= body.length) break;
    if (body[i] !== ',') throw new AppError('E7001', text);
    i++;
  }
  return { action, args };
}

/**
 * s3270's twelve-field status line. Window id and per-call timing have no
 * equivalent here — a browser session has neither — so those two fields are
 * always `0x0` and `0.000` rather than a guessed value.
 *
 * @param {import('./session.js').Session} session
 * @returns {string}
 */
export function statusLine(session) {
  const { oia, screen, model } = session;
  const keyboard = oia.keyboardLocked ? 'L' : 'U';
  const formatting = screen.fieldsFormatted ? 'F' : 'U';
  const at = screen.cursor.row * screen.cols + screen.cursor.col;
  const protection = screen.fieldsFormatted && !(screen.cells[at]?.editable ?? true) ? 'P' : 'U';
  const connection = oia.connected ? `C(${oia.host ?? ''})` : 'N';
  const mode = oia.connected ? 'I' : 'N';
  return [
    keyboard,
    formatting,
    protection,
    connection,
    mode,
    String(model),
    String(screen.rows),
    String(screen.cols),
    String(screen.cursor.row),
    String(screen.cursor.col),
    '0x0',
    '0.000',
  ].join(' ');
}

/**
 * Answers one `GET /3270/rest/json/<action-and-args>` request, matching
 * s3270's own `-httpd`: one action, one JSON object back, 400 on failure.
 * Session lookup happens before this is called, so the only failures here are
 * s3270-protocol ones (bad syntax, unknown action, ...) — those go back in
 * the same `{result, status}` shape a real s3270 client already expects,
 * rather than this app's own `{code, message}` error envelope.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {import('./session.js').Session} session
 * @param {string} actionPath still percent-encoded, as it came off the URL
 * @returns {Promise<void>}
 */
export async function handleRestAction(res, session, actionPath) {
  /** @type {string} */
  let decoded;
  try {
    decoded = decodeURIComponent(actionPath);
  } catch (cause) {
    throw new AppError('E7001', actionPath, cause);
  }

  if (decoded === '') {
    respond(res, 400, { result: ['Missing 3270 action.'], status: statusLine(session) });
    return;
  }

  /** @type {{ action: string, args: string[] }} */
  let call;
  try {
    call = parseActionCall(decoded);
  } catch {
    session.log.warn('REST action syntax error', { text: decoded });
    respond(res, 400, { result: [`Syntax error in "${decoded}"`], status: statusLine(session) });
    return;
  }

  const result = await session.runRestAction(call.action, call.args);
  respond(res, result.success ? 200 : 400, { result: result.text, status: statusLine(session) });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {{ result: string[] | null, status: string }} body
 * @returns {void}
 */
function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
