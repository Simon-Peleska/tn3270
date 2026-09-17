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
  assert.equal(last?.type === 'error' ? last.code : '', 'E3006');
});

test('a session counts as untouched until someone types at it', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const viewer = collectingViewer('viewer');
  session.attach(viewer);

  /** @returns {boolean} what the last status told the browsers */
  const reported = () => {
    const status = viewer.messages.filter((m) => m.type === 'status').at(-1);
    return status?.type === 'status' ? status.touched : false;
  };

  // Connecting and configuring are not using the session; they are what the
  // settings page does before the operator has done anything at all.
  session.handleClientMessage(viewer, { type: 'hostColors', enabled: false });
  session.handleClientMessage(viewer, { type: 'oversize', value: '100x40' });
  assert.equal(session.touched, false);

  session.handleClientMessage(viewer, { type: 'text', value: 'abc' });
  assert.equal(session.touched, true);
  assert.equal(reported(), true, 'the browsers must be told the moment it changes');
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

test('the controller can turn sharing off, refusing a second viewer but not itself', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer('controller');
  session.attach(controller);
  session.handleClientMessage(controller, { type: 'sharing', allowView: false, allowEdit: false });

  assert.throws(() => session.attach(collectingViewer('second')), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'E3007');
    return true;
  });

  session.detach(controller);
  const rejoined = collectingViewer('rejoined');
  session.attach(rejoined);
  assert.equal(rejoined.role, 'controller', 'the first viewer back in is never locked out by its own setting');
});

test('an observer cannot change the sharing settings', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer('controller');
  const observer = collectingViewer('observer');
  session.attach(controller);
  session.attach(observer);

  session.handleClientMessage(observer, { type: 'sharing', allowView: false, allowEdit: true });

  assert.equal(session.allowSharing, true, 'an observer cannot touch it');
  assert.equal(session.allowSharedEditing, false);
  const error = observer.messages.at(-1);
  assert.equal(error?.type, 'error');
  assert.equal(error?.type === 'error' ? error.code : '', 'E3006');
});

test('turning shared editing on promotes every viewer, and off demotes everyone but the controller who did it', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer('controller');
  const observer = collectingViewer('observer');
  session.attach(controller);
  session.attach(observer);
  assert.equal(observer.role, 'observer');

  session.handleClientMessage(controller, { type: 'sharing', allowView: true, allowEdit: true });
  assert.equal(session.allowSharedEditing, true);
  assert.equal(observer.role, 'controller', 'already attached, not just the next to join');

  const third = collectingViewer('third');
  session.attach(third);
  assert.equal(third.role, 'controller', 'a new viewer types too, once shared editing is on');

  session.handleClientMessage(controller, { type: 'sharing', allowView: true, allowEdit: false });
  assert.equal(observer.role, 'observer', 'demoted the moment shared editing is turned off');
  assert.equal(third.role, 'observer');
  assert.equal(controller.role, 'controller', 'the one who turned it off keeps control');
});

test('hello and status report the session\'s sharing settings', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer('controller');
  session.attach(controller);
  const hello = controller.messages[0];
  assert.equal(hello?.type, 'hello');
  assert.equal(hello?.type === 'hello' ? hello.allowSharing : null, true);
  assert.equal(hello?.type === 'hello' ? hello.allowSharedEditing : null, false);

  session.handleClientMessage(controller, { type: 'sharing', allowView: false, allowEdit: false });
  const status = controller.messages.at(-1);
  assert.equal(status?.type, 'status');
  assert.equal(status?.type === 'status' ? status.allowSharing : null, false);
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
      type: 'screen', model: 2, rows: 24, cols: 80, oversize: '',
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
    type: 'screen', model: 4, rows: 24, cols: 80, oversize: '',
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

test('a Backspace at the very start of a field does nothing, rather than locking the keyboard', async (t) => {
  // Left doesn't know about fields, so from the first cell of one it lands on
  // the attribute byte behind it — and Delete there is a protected-field
  // error that locks the keyboard, not a no-op. The host places the cursor on
  // exactly that first cell to begin with, so no typing is needed to reach it.
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;
  const { screen } = session;
  await settle(session);

  const controller = collectingViewer('controller');
  session.attach(controller);

  const before = { ...screen.cursor };
  session.handleClientMessage(controller, { type: 'action', action: 'Backspace' });
  await settle(session);

  assert.deepEqual(screen.cursor, before, 'the cursor must not move');
  assert.equal(session.oia.keyboardLocked, false, 'the keyboard must not lock');
});

test('typing on the attribute byte just left of a field nudges the cursor into it, rather than locking the keyboard', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;
  const { screen } = session;
  await settle(session);
  await waitUntil(() => screen.fieldsFormatted, 'the field map to load');

  const controller = collectingViewer('controller');
  session.attach(controller);
  const start = { ...screen.cursor };

  // The cell right before the field is its attribute byte, protected; typing
  // there directly would be a protected-cell error that locks the keyboard.
  session.handleClientMessage(controller, { type: 'action', action: 'MoveCursor1', args: [String(start.row + 1), String(start.col)] });
  await settle(session);

  session.handleClientMessage(controller, { type: 'text', value: 'x' });
  await settle(session);
  assert.equal(session.oia.keyboardLocked, false, 'typing on the attribute byte must not lock the keyboard');
  assert.equal(screen.cursor.col, start.col + 1, 'the character should land in the field, advancing the cursor past it');

  session.handleClientMessage(controller, { type: 'action', action: 'MoveCursor1', args: [String(start.row + 1), String(start.col + 1)] });
  session.handleClientMessage(controller, { type: 'copyField' });
  await settle(session);

  const fieldContent = controller.messages.find((message) => message.type === 'fieldContent');
  assert.equal(fieldContent?.type === 'fieldContent' ? fieldContent.text : null, 'x');
});

test('a hints request answers with one letter per editable field, using the cached field map', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;
  await settle(session);

  const controller = collectingViewer('controller');
  session.attach(controller);
  await waitUntil(() => session.screen.cells.some((cell) => cell.editable), 'the field map to be read');

  session.handleClientMessage(controller, { type: 'hints' });
  await settle(session);

  const hints = controller.messages.find((message) => message.type === 'hints');
  assert.ok(hints?.type === 'hints', 'a hints message should have been sent');
  assert.ok(hints.hints.length > 0, 'the screen has editable fields to hint');
  const letters = hints.hints.map((hint) => hint.letter);
  assert.equal(new Set(letters).size, letters.length, 'no letter should be handed to two fields');
});

test('clicking a cell moves the cursor there', async (t) => {
  // The browser sends the clicked cell as 1-origin row/col, which is what
  // MoveCursor1 takes; 0-origin would land the cursor one row and one column
  // short of where the operator pointed.
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;
  await settle(session);

  const controller = collectingViewer('controller');
  session.attach(controller);

  session.handleClientMessage(controller, { type: 'action', action: 'MoveCursor1', args: ['5', '12'] });
  await settle(session);

  assert.equal(session.screen.cursor.row, 4);
  assert.equal(session.screen.cursor.col, 11);
});

test('pasted text is typed literally, backslashes and all', async (t) => {
  // String() reads a backslash as the start of an escape — "\b" is a backspace
  // — so a paste that went through it would silently lose characters the
  // operator copied. PasteString treats the whole thing as text.
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;
  await settle(session);

  const controller = collectingViewer('controller');
  session.attach(controller);
  const before = session.screen.cursor.col;

  session.handleClientMessage(controller, { type: 'paste', text: 'a\\b' });
  await settle(session);

  assert.equal(session.screen.cursor.col, before + 3);
});

test('pasting more than a field holds is truncated at its edge, not spilled into the protected field after it', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;
  const { screen } = session;
  await settle(session);
  await waitUntil(() => screen.fieldsFormatted, 'the field map to load');

  const controller = collectingViewer('controller');
  session.attach(controller);
  const start = { ...screen.cursor };

  // The field runs from the cursor to the end of the row (see the trace); a
  // row past it is a separate, fully protected field, so a paste that runs
  // past the field's edge must stop there rather than lock the keyboard.
  const fieldWidth = screen.cols - start.col;
  session.handleClientMessage(controller, { type: 'paste', text: 'x'.repeat(fieldWidth + 3) });
  await settle(session);
  assert.equal(session.oia.keyboardLocked, false, 'landing on the protected field must not lock the keyboard');

  // b3270's own screen indications do not report what a scripted paste typed
  // (unlike a live keystroke), so the field is read back to check it directly.
  session.handleClientMessage(controller, { type: 'action', action: 'MoveCursor1', args: [String(start.row + 1), String(start.col + 1)] });
  session.handleClientMessage(controller, { type: 'copyField' });
  await settle(session);

  const fieldContent = controller.messages.find((message) => message.type === 'fieldContent');
  assert.equal(fieldContent?.type === 'fieldContent' ? fieldContent.text : null, 'x'.repeat(fieldWidth));
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

test('fitting the screen to the window grows it while disconnected, and off puts it back', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;
  assert.equal(session.screen.rows, 43, 'the fixture starts on a model 4');

  const controller = collectingViewer('controller');
  session.attach(controller);

  session.handleClientMessage(controller, { type: 'oversize', value: '120x50' });
  await waitUntil(() => session.screen.rows === 50, 'the grid to grow to what the browser asked for');
  assert.equal(session.screen.cols, 120);

  const at = controller.events.findIndex((event) => event.kind === 'message' && event.message.type === 'screen');
  assert.notEqual(at, -1, 'the viewer must be told the new size');
  assert.deepEqual(controller.events[at]?.kind === 'message' ? controller.events[at].message : null, {
    type: 'screen', model: 4, rows: 50, cols: 120, oversize: '120x50',
  });

  session.handleClientMessage(controller, { type: 'oversize', value: '' });
  await waitUntil(() => session.screen.rows === 43, 'the model\'s own size to come back');
  assert.equal(session.screen.cols, 80);
});

test('a model too wide for the fitted screen falls back to its own size', async (t) => {
  // b3270 refuses a model whose columns the standing oversize is under
  // ("Invalid oversize rows (24): Less than model 4 rows (43)"), so the two
  // have to be reconciled here before either is sent.
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer('controller');
  session.attach(controller);

  session.handleClientMessage(controller, { type: 'oversize', value: '100x50' });
  await waitUntil(() => session.screen.cols === 100, 'the fitted screen');

  session.handleClientMessage(controller, { type: 'model', model: 5 });
  await waitUntil(() => session.screen.cols === 132, 'the model 5 screen');
  assert.equal(session.screen.rows, 27);
  assert.equal(session.oversize, '', 'a screen the model outgrew is no screen size at all');
});

test('fitting the screen under a live connection drops it and reopens the same host', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session, host } = fixture;
  await waitUntil(() => session.screen.rowText(0).includes('_____'), 'the screen to be drawn');
  const expectedHost = `127.0.0.1:${host.port}`;

  const controller = collectingViewer('controller');
  session.attach(controller);
  session.handleClientMessage(controller, { type: 'oversize', value: '100x50' });

  // The host is told the screen size once, when the connection is made, so
  // there is no way to change it but to make the connection again.
  await waitUntil(() => session.screen.cols === 100, 'the grid to become the size asked for');
  await waitUntil(
    () => session.oia.connectionState !== 'not-connected',
    'the host connection to come back',
  );
  assert.equal(session.oversize, '100x50');
  assert.equal(session.lastHost, expectedHost);
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

test('a viewer that asked for no field colour is sent none, even though the field map is still read', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;

  const viewer = collectingViewer('plain');
  session.attach(viewer);

  // Nobody wants a tint, but the field map is read regardless — Backspace
  // needs it on every session, not just one with a viewer tinting fields.
  await waitUntil(() => session.screen.cells.some((cell) => cell.editable), 'the field map to be read');
  await settle(session);

  assert.equal(viewer.screen.join('').includes('48;2;'), false, 'nobody asked for a tint, so none was sent');
});

/**
 * The recorder: every action and typed keystroke becomes a step carrying the
 * screen it was typed against, streamed live to every viewer so a `RecorderPage`
 * can build its export without polling. A password field is the one exception —
 * see readbuffer.test.js for how it is detected.
 */

test('recording captures the screen and each step, and stops cleanly', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer('controller');
  session.attach(controller);

  session.handleClientMessage(controller, { type: 'recorder', action: 'start' });
  assert.notEqual(session.recording, null, 'a recording should now be in progress');

  session.handleClientMessage(controller, { type: 'text', value: 'abc' });
  session.handleClientMessage(controller, { type: 'action', action: 'Enter' });

  const steps = controller.messages
    .filter((m) => m.type === 'recorderStep')
    .map((m) => (m.type === 'recorderStep' ? m.step : null));
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], { screen: session.recording?.steps[0].screen, action: 'String', args: ['abc'] });
  assert.deepEqual(steps[1], { screen: session.recording?.steps[1].screen, action: 'Enter', args: [] });
  assert.ok(Array.isArray(steps[0]?.screen), 'a step carries the whole screen, not just the keystroke');

  session.handleClientMessage(controller, { type: 'recorder', action: 'stop' });
  assert.equal(session.recording, null, 'stopping clears the recording');

  // Typing after a stop is not part of any recording anymore.
  session.handleClientMessage(controller, { type: 'text', value: 'ignored' });
  const after = controller.messages.filter((m) => m.type === 'recorderStep');
  assert.equal(after.length, 2, 'nothing more should have been recorded once stopped');
});

test('nothing is recorded while nobody has started a recording', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer('controller');
  session.attach(controller);

  session.handleClientMessage(controller, { type: 'text', value: 'abc' });
  session.handleClientMessage(controller, { type: 'action', action: 'Enter' });

  assert.equal(controller.messages.some((m) => m.type === 'recorderStep'), false);
});

test('an observer cannot start or stop a recording', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer('controller');
  const observer = collectingViewer('observer');
  session.attach(controller);
  session.attach(observer);

  session.handleClientMessage(observer, { type: 'recorder', action: 'start' });

  assert.equal(session.recording, null, 'an observer cannot touch it');
  const last = observer.messages.at(-1);
  assert.equal(last?.type, 'error');
  assert.equal(last?.type === 'error' ? last.code : '', 'E3006');
});

test('a run of keystrokes into a password field collapses to a single marker', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer('controller');
  session.attach(controller);

  session.handleClientMessage(controller, { type: 'recorder', action: 'start' });
  // Set directly rather than through a real ReadBuffer round trip: see
  // readbuffer.test.js for the attribute-bit detection this state comes from.
  session.passwordField = true;

  session.handleClientMessage(controller, { type: 'text', value: 's' });
  session.handleClientMessage(controller, { type: 'text', value: 'ec' });
  session.handleClientMessage(controller, { type: 'text', value: 'ret' });

  const steps = /** @type {import('../server/protocol.js').RecorderStep[]} */ (session.recording?.steps ?? []);
  assert.equal(steps.length, 1, 'the whole run collapses into one entry');
  assert.equal(steps[0].password, true);
  assert.equal(steps[0].action, undefined, 'no action and no args, so nothing typed ever leaks out');
  assert.equal(steps[0].args, undefined);

  // The Enter that submits the field is not the field's own content, and is
  // needed to replay the form — so it is recorded normally, password or not.
  session.handleClientMessage(controller, { type: 'action', action: 'Enter' });
  assert.equal(steps.length, 2);
  assert.equal(steps[1].action, 'Enter');

  // Back to an ordinary field, typing is recorded in full again.
  session.passwordField = false;
  session.handleClientMessage(controller, { type: 'text', value: 'next' });
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[2], { screen: steps[2].screen, action: 'String', args: ['next'] });
});
