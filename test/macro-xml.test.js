import test from "node:test";
import assert from "node:assert/strict";
import { macrosToXml, parseMacrosXml } from "../public/macro-xml.js";

test("a single macro round-trips through XML as one bare <HAScript>", () => {
  /** @type {import('../public/macro-xml.js').Macro} */
  const macro = {
    name: "Logon",
    steps: [
      { text: "TSO", action: "Enter", args: [] },
      { text: "user1", action: "Tab", args: [] },
      { text: "secret", action: "Enter", args: [] },
    ],
  };

  const xml = macrosToXml([macro]);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<HAScript name="Logon"/);
  assert.doesNotMatch(xml, /<Macros>/, "a single macro needs no wrapper");
  assert.match(xml, /value="TSO\[enter\]"/);
  assert.match(xml, /value="user1\[tab\]"/);

  const [parsed] = parseMacrosXml(xml);
  assert.deepEqual(parsed, macro);
});

test("several macros export wrapped in <Macros> and import back out as separate macros", () => {
  /** @type {import('../public/macro-xml.js').Macro[]} */
  const macros = [
    { name: "One", steps: [{ text: "a", action: "Enter", args: [] }] },
    { name: "Two", steps: [{ text: "b", action: "PF", args: ["3"] }] },
  ];

  const xml = macrosToXml(macros);
  assert.match(xml, /<Macros>/);

  const parsed = parseMacrosXml(xml);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed, macros);
});

test("importing a bare, unwrapped <HAScript> - what Host On-Demand itself exports - works", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HAScript name="Sample" description="" author="" timestamp="" invisible="false" usevars="false" promptall="false">
<screen entryscreen="true" exitscreen="true" transient="false">
<description><oia status="NOTINHIBITED" optional="false" invertmatch="false"/></description>
<actions>
<input value="3270" row="0" col="0" movecursor="true" xlatehostkeys="true" encrypted="false"/>
<input value="[enter]" row="0" col="0" movecursor="true" xlatehostkeys="true" encrypted="false"/>
</actions>
<nextscreens timeout="0"></nextscreens>
</screen></HAScript>`;

  const [macro] = parseMacrosXml(xml);
  assert.equal(macro?.name, "Sample");
  assert.deepEqual(macro?.steps, [
    { text: "3270", action: "", args: [] },
    { text: "", action: "Enter", args: [] },
  ]);
});

test("PF and PA keys carry their number through the bracket token", () => {
  /** @type {import('../public/macro-xml.js').Macro} */
  const macro = {
    name: "Keys",
    steps: [
      { text: "", action: "PF", args: ["12"] },
      { text: "", action: "PA", args: ["2"] },
    ],
  };
  const xml = macrosToXml([macro]);
  assert.match(xml, /\[pf12\]/);
  assert.match(xml, /\[pa2\]/);
  assert.deepEqual(parseMacrosXml(xml), [macro]);
});

test("an unrecognised bracket keyword is kept as literal text rather than dropped", () => {
  const xml = `<HAScript name="Odd" usevars="false"><screen><actions>
<input value="hi[mouseclick]bye[enter]"/>
</actions></screen></HAScript>`;
  const [macro] = parseMacrosXml(xml);
  assert.deepEqual(macro?.steps, [
    { text: "hi[mouseclick]bye", action: "Enter", args: [] },
  ]);
});

test("special characters in a macro name and typed text survive XML escaping", () => {
  /** @type {import('../public/macro-xml.js').Macro} */
  const macro = {
    name: "A & B <test>",
    steps: [{ text: '"quoted" & <tagged>', action: "Enter", args: [] }],
  };
  const xml = macrosToXml([macro]);
  const [parsed] = parseMacrosXml(xml);
  assert.deepEqual(parsed, macro);
});

test("parsing text with no <HAScript> at all yields no macros", () => {
  assert.deepEqual(parseMacrosXml("not xml"), []);
});
