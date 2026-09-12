import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonc, stripJsonc, validateConfig, loadConfig } from '../server/config.js';
import { parseClientMessage, isHostAllowed } from '../server/protocol.js';
import { AppError } from '../server/errors.js';

/**
 * The comment stripper is hand-written, so it is worth the boring tests: a bug
 * here silently changes settings rather than failing loudly.
 */

test('comments are stripped and JSON survives', () => {
  const text = `{
    // a line comment
    "a": 1, /* a block comment */
    "b": 2
  }`;
  assert.deepEqual(parseJsonc(text), { a: 1, b: 2 });
});

test('comment markers inside strings are left alone', () => {
  const text = '{"url": "http://example.com/x", "path": "/* not a comment */"}';
  assert.deepEqual(parseJsonc(text), { url: 'http://example.com/x', path: '/* not a comment */' });
});

test('an escaped quote does not end the string early', () => {
  const text = '{"quoted": "he said \\"//\\" loudly"}';
  assert.deepEqual(parseJsonc(text), { quoted: 'he said "//" loudly' });
});

test('stripping preserves offsets so parse errors still point at the right place', () => {
  const text = '{"a": 1} // tail';
  assert.equal(stripJsonc(text).length, text.length);
});

test('trailing commas are tolerated', () => {
  assert.deepEqual(parseJsonc('{"a": [1, 2,], "b": 3,}'), { a: [1, 2], b: 3 });
});

test('a comment between a trailing comma and its brace is tolerated', () => {
  assert.deepEqual(parseJsonc('{"a": 1, // done\n}'), { a: 1 });
  assert.deepEqual(parseJsonc('[1, /* done */ ]'), [1]);
});

test('a brace inside a string does not make the comma before it trailing', () => {
  assert.deepEqual(parseJsonc('["a", "}"]'), ['a', '}']);
});

test('the shipped config.jsonc parses and validates', () => {
  const config = loadConfig('config.jsonc');
  assert.equal(typeof config.server.port, 'number');
  assert.ok(config.b3270.model >= 2 && config.b3270.model <= 5);
});

test('missing sections fall back to defaults', () => {
  const config = validateConfig({});
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.b3270.defaultHost, null);
  assert.deepEqual(config.security.allowedHosts, []);
});

test('a wrongly typed setting is rejected with its own code', () => {
  assert.throws(() => validateConfig({ server: { port: '8017' } }), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'E1003');
    return true;
  });
});

test('an out-of-range setting is rejected with its own code', () => {
  assert.throws(() => validateConfig({ b3270: { model: 9 } }), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'E1004');
    return true;
  });
});

test('any b3270 resource can be set, and reaches b3270 as a string', () => {
  const config = validateConfig({
    b3270: { settings: { oversize: '90x30', monoCase: true, nopSeconds: 30, 'b3270.codePage': 'german', '*trace': false } },
  });
  assert.deepEqual(config.b3270.settings, {
    oversize: '90x30',
    monoCase: 'true',
    nopSeconds: '30',
    'b3270.codePage': 'german',
    '*trace': 'false',
  });
});

test('a resource name that is not a resource name is refused', () => {
  // These land in `-xrm "b3270.<name>: <value>"`, so anything with a space or a
  // colon in it would rewrite the argument rather than name a setting.
  for (const name of ['code page', 'codePage: x', '', 'a;b', '-model']) {
    assert.throws(() => validateConfig({ b3270: { settings: { [name]: 'x' } } }), (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'E1005');
      return true;
    }, `"${name}" must be refused`);
  }
});

test('a resource value that is not a scalar is refused', () => {
  assert.throws(() => validateConfig({ b3270: { settings: { oversize: { x: 1 } } } }), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'E1003');
    return true;
  });
});

test('a bad log level names the values it will accept', () => {
  assert.throws(() => validateConfig({ logLevel: 'chatty' }), (err) => {
    assert.ok(err instanceof AppError);
    assert.match(err.summary, /debug, info, warn or error/);
    return true;
  });
});

test('well-formed client messages are parsed', () => {
  assert.deepEqual(parseClientMessage('{"type":"action","action":"Enter"}'), {
    type: 'action', action: 'Enter', args: [],
  });
  assert.deepEqual(parseClientMessage('{"type":"action","action":"PF","args":[3]}'), {
    type: 'action', action: 'PF', args: ['3'],
  });
  assert.deepEqual(parseClientMessage('{"type":"text","value":"abc"}'), { type: 'text', value: 'abc' });
  assert.deepEqual(parseClientMessage('{"type":"paste","text":"a\\nb"}'), { type: 'paste', text: 'a\nb' });
  assert.deepEqual(parseClientMessage('{"type":"disconnect"}'), { type: 'disconnect' });
  assert.deepEqual(parseClientMessage('{"type":"model","model":4}'), { type: 'model', model: 4 });
  assert.deepEqual(parseClientMessage('{"type":"connect","host":"mainframe:23"}'), {
    type: 'connect', host: 'mainframe:23',
  });
  // The settings page draws over the terminal and asks for the screen back.
  assert.deepEqual(parseClientMessage('{"type":"refresh"}'), { type: 'refresh' });
  // A page whose host is locked in the config cannot name it.
  assert.deepEqual(parseClientMessage('{"type":"connect"}'), { type: 'connect', host: null });
});

test('only the four real 3270 models may be asked for', () => {
  for (const model of [1, 6, 4.5, '4', null]) {
    assert.throws(() => parseClientMessage(JSON.stringify({ type: 'model', model })), (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'E4002');
      return true;
    }, `model ${String(model)} must be refused`);
  }
});

test('a paste far larger than a screen is refused', () => {
  // b3270 types a paste one character at a time, so a stray copy of a log file
  // would keep the session busy for minutes.
  assert.throws(() => parseClientMessage(JSON.stringify({ type: 'paste', text: 'x'.repeat(16385) })), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'E4003');
    return true;
  });
});

test('an action outside the allow-list never reaches b3270', () => {
  // b3270 has actions that read files and run programs; the allow-list is the
  // only thing standing between a browser and them.
  for (const action of ['Source', 'Script', 'Execute', 'Trace', 'Quit']) {
    assert.throws(() => parseClientMessage(JSON.stringify({ type: 'action', action })), (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'E4002');
      return true;
    }, `${action} must be refused`);
  }
});

test('malformed frames are rejected rather than crashing the connection', () => {
  assert.throws(() => parseClientMessage('not json'), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'E4001');
    return true;
  });
  assert.throws(() => parseClientMessage('[1,2,3]'), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'E4001');
    return true;
  });
  assert.throws(() => parseClientMessage('{"type":"nonsense"}'), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'E4002');
    return true;
  });
});

test('an empty allowedHosts list means any host, a populated one means only those', () => {
  assert.equal(isHostAllowed('anything:23', []), true);
  assert.equal(isHostAllowed('mainframe:992', ['mainframe']), true);
  assert.equal(isHostAllowed('mainframe:992', ['mainframe:992']), true);
  assert.equal(isHostAllowed('elsewhere:23', ['mainframe']), false);
});
