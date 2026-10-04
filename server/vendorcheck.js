import { readFileSync } from "node:fs";
import { AppError } from "./errors.js";

/** @param {URL} root */
export function checkVendoredWs(root = new URL("../", import.meta.url)) {
  const lock = JSON.parse(
    readFileSync(new URL("package-lock.json", root), "utf8"),
  );
  const vendored = JSON.parse(
    readFileSync(new URL("vendor/ws/package.json", root), "utf8"),
  );
  const locked = lock.packages?.["node_modules/ws"]?.version;
  if (vendored.version === locked) return;
  throw new AppError(
    "E1008",
    `vendor/ws is ${vendored.version}, package-lock.json has ${locked}; run npm run vendor`,
  );
}
