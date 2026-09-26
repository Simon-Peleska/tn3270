import test from "node:test";
import assert from "node:assert/strict";
import { CODE_PAGE_CHARTS } from "../public/codepages.js";

test("single-byte charts have one display cell per EBCDIC byte from 40 to FF", () => {
  for (const [name, chart] of Object.entries(CODE_PAGE_CHARTS)) {
    assert.equal([...chart].length, 192, name);
    assert.doesNotMatch(chart, /\p{C}/u, name);
  }
});

test("known code-page differences and bracket positions are preserved", () => {
  assert.equal(CODE_PAGE_CHARTS["cp037"]?.[0x43 - 0x40], "ä");
  assert.equal(CODE_PAGE_CHARTS["cp273"]?.[0x43 - 0x40], "{");
  assert.equal(CODE_PAGE_CHARTS["cp1142"]?.[0x5a - 0x40], "€");
  assert.equal(CODE_PAGE_CHARTS["bracket"]?.[0xad - 0x40], "[");
  assert.equal(CODE_PAGE_CHARTS["bracket"]?.[0xbd - 0x40], "]");
});
