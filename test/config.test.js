import test from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonc,
  stripJsonc,
  validateConfig,
  loadConfig,
} from "../server/config.js";
import { parseClientMessage, isHostAllowed } from "../server/protocol.js";
import { AppError } from "../server/errors.js";

test("comments are stripped and JSON survives", () => {
  const text = `{
    // a line comment
    "a": 1, /* a block comment */
    "b": 2
  }`;
  assert.deepEqual(parseJsonc(text), { a: 1, b: 2 });
});

test("comment markers inside strings are left alone", () => {
  const text = '{"url": "http://example.com/x", "path": "/* not a comment */"}';
  assert.deepEqual(parseJsonc(text), {
    url: "http://example.com/x",
    path: "/* not a comment */",
  });
});

test("an escaped quote does not end the string early", () => {
  const text = '{"quoted": "he said \\"//\\" loudly"}';
  assert.deepEqual(parseJsonc(text), { quoted: 'he said "//" loudly' });
});

test("stripping preserves offsets so parse errors still point at the right place", () => {
  const text = '{"a": 1} // tail';
  assert.equal(stripJsonc(text).length, text.length);
});

test("trailing commas are tolerated", () => {
  assert.deepEqual(parseJsonc('{"a": [1, 2,], "b": 3,}'), { a: [1, 2], b: 3 });
});

test("a comment between a trailing comma and its brace is tolerated", () => {
  assert.deepEqual(parseJsonc('{"a": 1, // done\n}'), { a: 1 });
  assert.deepEqual(parseJsonc("[1, /* done */ ]"), [1]);
});

test("a brace inside a string does not make the comma before it trailing", () => {
  assert.deepEqual(parseJsonc('["a", "}"]'), ["a", "}"]);
});

test("the shipped config.example.jsonc parses and validates", () => {
  const config = loadConfig("config.example.jsonc");
  assert.equal(typeof config.server.port, "number");
  assert.ok(config.b3270.model >= 2 && config.b3270.model <= 5);
});

test("missing sections fall back to defaults", () => {
  const config = validateConfig({});
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(config.b3270.defaultHost, null);
  assert.deepEqual(config.security.allowedHosts, []);
  // Without a proxy in front, any client could forge its own address.
  assert.equal(config.security.trustProxyHeaders, false);
  assert.equal(config.logFile, "log/tn3270.log");
  assert.equal(config.logMaxBytes, 10 * 1024 * 1024);
});

test("a wrongly typed setting is rejected with its own code", () => {
  assert.throws(
    () => validateConfig({ server: { port: "8017" } }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "E1003");
      return true;
    },
  );
});

test("an out-of-range setting is rejected with its own code", () => {
  assert.throws(
    () => validateConfig({ b3270: { model: 9 } }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "E1004");
      return true;
    },
  );
});

test("any b3270 resource can be set, and reaches b3270 as a string", () => {
  const config = validateConfig({
    b3270: {
      settings: {
        oversize: "90x30",
        monoCase: true,
        nopSeconds: 30,
        "b3270.codePage": "german",
        "*trace": false,
      },
    },
  });
  assert.deepEqual(config.b3270.settings, {
    oversize: "90x30",
    monoCase: "true",
    nopSeconds: "30",
    "b3270.codePage": "german",
    "*trace": "false",
  });
});

test("a quiet host connection is kept open with a NOP every minute, unless the config says otherwise", () => {
  assert.deepEqual(validateConfig({}).b3270.settings, { nopSeconds: "60" });
  assert.deepEqual(
    validateConfig({ b3270: { settings: { nopSeconds: 0, monoCase: true } } })
      .b3270.settings,
    { nopSeconds: "0", monoCase: "true" },
  );
});

test("a resource name that is not a resource name is refused", () => {
  // These land in `-xrm "b3270.<name>: <value>"`: a space or colon rewrites the argument.
  for (const name of ["code page", "codePage: x", "", "a;b", "-model"]) {
    assert.throws(
      () => validateConfig({ b3270: { settings: { [name]: "x" } } }),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "E1005");
        return true;
      },
      `"${name}" must be refused`,
    );
  }
});

test("a resource value that is not a scalar is refused", () => {
  assert.throws(
    () => validateConfig({ b3270: { settings: { oversize: { x: 1 } } } }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "E1003");
      return true;
    },
  );
});

test("a bad log level names the values it will accept", () => {
  assert.throws(
    () => validateConfig({ logLevel: "chatty" }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.match(err.summary, /debug, info, warn or error/);
      return true;
    },
  );
});

test("well-formed client messages are parsed", () => {
  assert.deepEqual(parseClientMessage('{"type":"action","action":"Enter"}'), {
    type: "action",
    action: "Enter",
    args: [],
  });
  assert.deepEqual(
    parseClientMessage('{"type":"action","action":"PF","args":[3]}'),
    {
      type: "action",
      action: "PF",
      args: ["3"],
    },
  );
  assert.deepEqual(parseClientMessage('{"type":"text","value":"abc"}'), {
    type: "text",
    value: "abc",
  });
  const paste = {
    type: "paste",
    text: "a\nb",
    segments: [
      { row: 0, col: 2, text: "a" },
      { row: 1, col: 2, text: "b" },
    ],
  };
  assert.deepEqual(parseClientMessage(JSON.stringify(paste)), paste);
  assert.deepEqual(parseClientMessage('{"type":"disconnect"}'), {
    type: "disconnect",
  });
  assert.deepEqual(parseClientMessage('{"type":"model","model":4}'), {
    type: "model",
    model: 4,
  });
  assert.deepEqual(
    parseClientMessage('{"type":"connect","host":"mainframe:23"}'),
    {
      type: "connect",
      host: "mainframe:23",
    },
  );
  assert.deepEqual(parseClientMessage('{"type":"refresh"}'), {
    type: "refresh",
  });
  // A page whose host is locked in the config cannot name it.
  assert.deepEqual(parseClientMessage('{"type":"connect"}'), {
    type: "connect",
    host: null,
  });
  assert.deepEqual(
    parseClientMessage('{"type":"answer","viewer":"ab12cd34","allow":true}'),
    { type: "answer", viewer: "ab12cd34", allow: true },
  );
  assert.deepEqual(parseClientMessage('{"type":"stopSharing"}'), {
    type: "stopSharing",
  });
});

test("an answer without a viewer and a yes or no is refused", () => {
  for (const body of [
    { viewer: "ab12cd34" },
    { viewer: 3, allow: true },
    { allow: "yes" },
  ]) {
    assert.throws(
      () => parseClientMessage(JSON.stringify({ type: "answer", ...body })),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "E4002");
        return true;
      },
    );
  }
});

test("only the four real 3270 models may be asked for", () => {
  for (const model of [1, 6, 4.5, "4", null]) {
    assert.throws(
      () => parseClientMessage(JSON.stringify({ type: "model", model })),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "E4002");
        return true;
      },
      `model ${String(model)} must be refused`,
    );
  }
});

test("a paste far larger than a screen is refused", () => {
  // b3270 types a paste one character at a time; a stray log file would busy it for minutes.
  assert.throws(
    () =>
      parseClientMessage(
        JSON.stringify({ type: "paste", text: "x".repeat(16385) }),
      ),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "E4003");
      return true;
    },
  );
});

test("a paste whose segments are not places on the screen is refused", () => {
  for (const segments of [
    undefined,
    [{ row: -1, col: 0, text: "a" }],
    [{ row: 0, col: 1.5, text: "a" }],
    [{ row: 0, col: 0, text: 7 }],
    [null],
  ])
    assert.throws(
      () =>
        parseClientMessage(
          JSON.stringify({ type: "paste", text: "a", segments }),
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "E4002");
        return true;
      },
      JSON.stringify(segments),
    );
});

test("an action outside the allow-list never reaches b3270", () => {
  // The allow-list is all that stands between a browser and b3270's file and program actions.
  for (const action of ["Source", "Script", "Execute", "Trace", "Quit"]) {
    assert.throws(
      () => parseClientMessage(JSON.stringify({ type: "action", action })),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "E4002");
        return true;
      },
      `${action} must be refused`,
    );
  }
});

test("malformed frames are rejected rather than crashing the connection", () => {
  assert.throws(
    () => parseClientMessage("not json"),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "E4001");
      return true;
    },
  );
  assert.throws(
    () => parseClientMessage("[1,2,3]"),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "E4001");
      return true;
    },
  );
  assert.throws(
    () => parseClientMessage('{"type":"nonsense"}'),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "E4002");
      return true;
    },
  );
});

test("an empty allowedHosts list means any host, a populated one means only those", () => {
  assert.equal(isHostAllowed("anything:23", []), true);
  assert.equal(isHostAllowed("mainframe:992", ["mainframe"]), true);
  assert.equal(isHostAllowed("mainframe:992", ["mainframe:992"]), true);
  assert.equal(isHostAllowed("elsewhere:23", ["mainframe"]), false);
});
