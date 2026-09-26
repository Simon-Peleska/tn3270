import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { ERRORS } from "../server/errors.js";

test("every source error code is registered", () => {
  for (const dir of ["public", "server"]) {
    for (const file of readdirSync(dir).filter((name) =>
      name.endsWith(".js"),
    )) {
      if (dir === "server" && file === "errors.js") continue;
      const source = readFileSync(`${dir}/${file}`, "utf8");
      for (const code of source.matchAll(/\bE[1-7]\d{3}\b/g))
        assert.ok(
          code[0] in ERRORS,
          `${dir}/${file} uses unregistered ${code[0]}`,
        );
    }
  }
});
