import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkVendoredWs } from "../server/vendorcheck.js";

test("vendored ws matches package-lock.json", () => {
  checkVendoredWs();
});

test("a vendored ws older than package-lock.json is reported as E1008", () => {
  const root = mkdtempSync(join(tmpdir(), "tn3270-vendor-"));
  mkdirSync(join(root, "vendor/ws"), { recursive: true });
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({ packages: { "node_modules/ws": { version: "8.22.0" } } }),
  );
  writeFileSync(
    join(root, "vendor/ws/package.json"),
    JSON.stringify({ version: "8.21.3" }),
  );

  assert.throws(() => checkVendoredWs(pathToFileURL(root + "/")), {
    code: "E1008",
    message: /vendor\/ws is 8\.21\.3, package-lock\.json has 8\.22\.0/,
  });
});
