import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionRegistry } from '../server/session.js';
import { INIT_SEQUENCE } from '../server/vt.js';
import { AppError } from '../server/errors.js';
import { testConfig, collectingViewer, waitUntil, settle, startTracedSession } from './helpers.js';

/**
 * The multi-viewer contract: the session owns the screen, viewers come and go,
 * and a viewer that joins late is immediately correct.
 */

test('the first viewer controls and the rest observe', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const first = collectingViewer('first');
  const second = collectingViewer('second');
  session.attach(first);
  session.attach(second);

  assert.equal(first.role, 'controller');
  assert.equal(second.role, 'observer');
});

test('a viewer joining mid-stream gets a repaint matching what the first viewer sees', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;

  const early = collectingViewer('early');
  session.attach(early);
  await waitUntil(() => session.screen.rowText(0).includes('_____'), 'the screen to be drawn');

  const late = collectingViewer('late');
  session.attach(late);

  const repaint = late.screen[0];
  assert.ok(repaint !== undefined, 'the late viewer should receive a repaint on attach');
  assert.ok(repaint.startsWith(INIT_SEQUENCE), 'the repaint must set the terminal up from scratch');
  assert.ok(repaint.includes('_____'), 'the repaint must contain the current screen');

  const hello = late.messages[0];
  assert.equal(hello?.type, 'hello');
  assert.equal(hello?.type === 'hello' ? hello.rows : 0, session.screen.rows);
});

test('every attached viewer receives the same delta', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;
  await waitUntil(() => session.screen.rowText(0).includes('_____'), 'the screen to be drawn');

  const a = collectingViewer('a');
  const b = collectingViewer('b');
  session.attach(a);
  session.attach(b);
  const beforeA = a.screen.length;
  const beforeB = b.screen.length;

  session.b3270.runActions([{ action: 'String', args: ['hello'] }]);
  await waitUntil(() => a.screen.length > beforeA, 'a delta to be broadcast');
  await waitUntil(() => b.screen.length > beforeB, 'the observer to get it too');

  assert.deepEqual(a.screen.slice(beforeA), b.screen.slice(beforeB));
});

test('a viewer with host colours off gets no truecolor from the host, another viewer is unaffected', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;
  await waitUntil(() => session.screen.rowText(0).includes('_____'), 'the screen to be drawn');

  const plain = collectingViewer('plain');
  plain.hostColors = false;
  const colored = collectingViewer('colored');
  session.attach(plain);
  session.attach(colored);

  // "red" is ANSI slot 1, an indexed background SGR of 41 — a boundary check
  // (not colours.includes('41')) because 41 can appear inside an unrelated
  // number like a cursor row.
  const redBackground = /(?:^|;)41(?:;|m)/;
  const plainRepaint = plain.screen[0] ?? '';
  const coloredRepaint = colored.screen[0] ?? '';
  assert.ok(!redBackground.test(plainRepaint), 'the red field must not reach a viewer with host colours off');
  assert.ok(redBackground.test(coloredRepaint), 'the other viewer must still see the host red');

  // Flipping it live repaints only that viewer, in place.
  session.handleClientMessage(colored, { type: 'hostColors', enabled: false });
  const latest = colored.screen.at(-1) ?? '';
  assert.ok(!redBackground.test(latest), 'toggling off must repaint without the host colour');
  assert.equal(plain.screen.length, 1, 'the other viewer must not have been repainted');
});

test('an observer cannot type, and is told why in place', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer('controller');
  const observer = collectingViewer('observer');
  session.attach(controller);
  session.attach(observer);

  session.handleClientMessage(observer, { type: 'text', value: 'nope' });

  const last = observer.messages.at(-1);
  assert.equal(last?.type, 'error');
  assert.equal(last?.type === 'error' ? last.code : '', 'E4003');
});

test('control passes on when the controller leaves', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const first = collectingViewer('first');
  const second = collectingViewer('second');
  session.attach(first);
  session.attach(second);
  session.detach(first);

  assert.equal(second.role, 'controller', 'the session must not be left read-only');
});

test('allowMultipleControllers makes every viewer a controller', async (t) => {
  const session = new Session(testConfig({ sessions: { allowMultipleControllers: true, idleTimeoutMs: 0 } }));
  t.after(() => session.close());
  await session.ready;

  const a = collectingViewer('a');
  const b = collectingViewer('b');
  session.attach(a);
  session.attach(b);

  assert.equal(a.role, 'controller');
  assert.equal(b.role, 'controller');
});

test('the viewer ceiling is enforced', async (t) => {
  const session = new Session(testConfig({ sessions: { maxViewersPerSession: 1, idleTimeoutMs: 0 } }));
  t.after(() => session.close());
  await session.ready;

  session.attach(collectingViewer('a'));
  assert.throws(() => session.attach(collectingViewer('b')), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'E3003');
    return true;
  });
});

test('a session survives its viewers leaving and rejoining', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;
  await waitUntil(() => session.screen.rowText(0).includes('_____'), 'the screen to be drawn');

  const viewer = collectingViewer('reload');
  session.attach(viewer);
  session.detach(viewer);
  assert.equal(session.closed, false, 'the host connection must outlive the browser');

  const rejoined = collectingViewer('rejoined');
  session.attach(rejoined);
  assert.ok(rejoined.screen[0]?.includes('_____'), 'the same screen must come straight back');
});

test('changing the model resizes the grid and tells every viewer before repainting', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;
  assert.equal(session.screen.rows, 43, 'the fixture starts on a model 4');

  const controller = collectingViewer('controller');
  const observer = collectingViewer('observer');
  session.attach(controller);
  session.attach(observer);

  session.handleClientMessage(controller, { type: 'model', model: 2 });
  await waitUntil(() => session.screen.rows === 24, 'the grid to become a model 2');

  for (const viewer of [controller, observer]) {
    const at = viewer.events.findIndex((event) => event.kind === 'message' && event.message.type === 'screen');
    assert.notEqual(at, -1, `${viewer.id} must be told the new size`);
    const event = viewer.events[at];
    assert.deepEqual(event?.kind === 'message' ? event.message : null, {
      type: 'screen', model: 2, rows: 24, cols: 80,
    });

    // A repaint is meaningless to a viewer still holding a 43-row terminal, so
    // the resize arriving first is part of the contract, not a coincidence.
    const next = viewer.events[at + 1];
    assert.ok(
      next?.kind === 'screen' && next.bytes.startsWith(INIT_SEQUENCE),
      `${viewer.id} must be repainted immediately after being resized`,
    );
  }
});

test('a host that only ever erases the default screen shrinks the grid to match', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const viewer = collectingViewer('viewer');
  session.attach(viewer);

  // A model 4 offers 43x80, but a host that never sends Erase/Write Alternate
  // only ever uses the default 24x80 — b3270 reports that as an erase
  // indication's logical-rows/logical-columns, not as a new screen-mode.
  session.handleIndication({ kind: 'screen-mode', body: { model: 4, rows: 43, columns: 80, color: true } });
  await waitUntil(() => session.screen.rows === 43, 'the grid to grow to the model 4 size');

  const before = viewer.events.length;
  session.handleIndication({ kind: 'erase', body: { 'logical-rows': 24, 'logical-columns': 80 } });

  const at = viewer.events.findIndex(
    (event, i) => i >= before && event.kind === 'message' && event.message.type === 'screen',
  );
  assert.notEqual(at, -1, 'the viewer must be told the grid shrank to what the host actually uses');
  assert.deepEqual(viewer.events[at]?.kind === 'message' ? viewer.events[at].message : null, {
    type: 'screen', model: 4, rows: 24, cols: 80,
  });

  const next = viewer.events[at + 1];
  assert.ok(
    next?.kind === 'screen' && next.bytes.startsWith(INIT_SEQUENCE),
    'the viewer must be repainted immediately after being resized',
  );
});

test('changing the model under a live connection drops it and reopens the same host', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session, host } = fixture;
  await waitUntil(() => session.screen.rowText(0).includes('_____'), 'the screen to be drawn');
  const expectedHost = `127.0.0.1:${host.port}`;
  assert.equal(session.lastHost, expectedHost);

  const controller = collectingViewer('controller');
  session.attach(controller);
  session.handleClientMessage(controller, { type: 'model', model: 2 });

  // b3270 refuses a model change while connected, so the session has to take the
  // connection down first — and then put it back, on the host as it was typed,
  // port and all.
  await waitUntil(() => session.screen.rows === 24, 'the grid to become a model 2');
  await waitUntil(
    () => session.oia.connectionState !== 'not-connected',
    'the host connection to come back',
  );
  assert.equal(session.model, 2);
  assert.equal(session.lastHost, expectedHost);
});

test('reconnecting without naming a host reuses the one the session knows', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session, host } = fixture;
  await waitUntil(() => session.oia.connectionState !== 'not-connected', 'the first connection');

  const controller = collectingViewer('controller');
  session.attach(controller);
  session.handleClientMessage(controller, { type: 'disconnect' });
  await waitUntil(() => session.oia.connectionState === 'not-connected', 'the disconnect');

  session.handleClientMessage(controller, { type: 'connect', host: null });
  await waitUntil(() => session.oia.connectionState !== 'not-connected', 'the reconnection');
  assert.equal(session.lastHost, `127.0.0.1:${host.port}`);
});

test('a refresh repaints only the viewer who asked, even an observer', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;
  await waitUntil(() => session.screen.rowText(0).includes('_____'), 'the screen to be drawn');

  const controller = collectingViewer('controller');
  const observer = collectingViewer('observer');
  session.attach(controller);
  session.attach(observer);
  assert.equal(observer.role, 'observer');

  const before = controller.screen.length;
  session.handleClientMessage(observer, { type: 'refresh' });

  assert.equal(controller.screen.length, before, 'nobody else may be disturbed');
  const last = observer.screen.at(-1) ?? '';
  assert.ok(last.startsWith(INIT_SEQUENCE), 'the asker gets a full repaint');
  assert.ok(last.includes('_____'), 'and it is the host screen, not an error');
  assert.ok(
    observer.messages.every((message) => message.type !== 'error'),
    'an observer asking for its own screen back is not an input',
  );
});

test('a Backspace action deletes the character behind the cursor, not just moves over it', async (t) => {
  // b3270's own Backspace only moves the cursor left; a PC keyboard's
  // Backspace deletes. The field here is nondisplay, so the deletion itself
  // is checked through the cursor: typing "hello" then backspacing must land
  // one column short of typing "hell" plus a bare cursor-left would.
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;
  const { screen } = session;
  await settle(session);

  const controller = collectingViewer('controller');
  session.attach(controller);

  const before = screen.cursor.col;
  session.handleClientMessage(controller, { type: 'text', value: 'hello' });
  await settle(session);
  assert.equal(screen.cursor.col, before + 5);

  session.handleClientMessage(controller, { type: 'action', action: 'Backspace' });
  await settle(session);
  assert.equal(screen.cursor.col, before + 4, 'one character should have been deleted');

  session.handleClientMessage(controller, { type: 'action', action: 'Backspace' });
  await settle(session);
  assert.equal(screen.cursor.col, before + 3, 'backspacing again deletes the next character back');
});

test('a b3270 resource set in the config reaches the emulator', async (t) => {
  // oversize is the cheapest resource to observe: b3270 answers it in the
  // screen-mode indication, which is the same path the browser sees.
  const session = new Session(testConfig({ b3270: { path: 'b3270', model: 2, settings: { oversize: '90x30' } } }));
  t.after(() => session.close());
  await session.ready;

  assert.equal(session.screen.rows, 30);
  assert.equal(session.screen.cols, 90);
});

test('the registry refuses to exceed maxSessions', () => {
  const registry = new SessionRegistry(testConfig({ sessions: { maxSessions: 1, idleTimeoutMs: 0 } }));
  registry.create();
  assert.throws(() => registry.create(), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'E3002');
    return true;
  });
  registry.closeAll();
});

test('an unknown session id is a stable error, not a crash', () => {
  const registry = new SessionRegistry(testConfig());
  assert.throws(() => registry.get('nope'), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'E3001');
    return true;
  });
});

test('a closed session removes itself from the registry', async () => {
  const registry = new SessionRegistry(testConfig());
  const session = registry.create();
  await session.ready;
  assert.equal(registry.list().length, 1);
  session.close();
  assert.equal(registry.list().length, 0);
});

/**
 * Where the typeable fields are is not in b3270's screen indications, so the
 * session has to go and read them. These check the whole round trip: a viewer
 * says what colour it wants, the session asks b3270, and the tint comes back
 * in the bytes — all of it against a real emulator and a real trace.
 */

test('a viewer that asked for a field colour gets the typeable fields tinted with it', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;

  const viewer = collectingViewer('tinted');
  viewer.fieldColor = '#123456';
  session.attach(viewer);

  await waitUntil(() => session.screen.cells.some((cell) => cell.editable), 'the field map to be read');
  await settle(session);

  assert.ok(
    viewer.screen.join('').includes('48;2;18;52;86'),
    'the viewer should have been sent its own tint as a background',
  );
});

test('a viewer that asked for no field colour is sent none, and costs no field read', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;

  const viewer = collectingViewer('plain');
  session.attach(viewer);
  await settle(session);

  assert.equal(session.fieldReadTag, null, 'nobody wants the field map, so none should be in flight');
  assert.equal(session.screen.cells.some((cell) => cell.editable), false);
});
