import { cpSync, existsSync, rmSync } from "node:fs";

// `npm install --omit=dev` leaves no node_modules/ws; keep the vendored copy then.
if (existsSync("node_modules/ws")) {
  rmSync("vendor/ws", { recursive: true, force: true });
  cpSync("node_modules/ws", "vendor/ws", { recursive: true });
}
