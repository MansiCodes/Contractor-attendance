// Runs the production server exactly as the container image does: the standalone
// output from `next build`, with .next/static and public/ copied beside server.js
// (see Dockerfile). Used by the browser tests; also handy to try a build locally.
//
//   npm run build
//   node scripts/start-standalone.mjs          (PORT and APP_MODE from the environment)
import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.cwd();
const standalone = resolve(root, ".next", "standalone");
if (!existsSync(join(standalone, "server.js"))) {
  console.error("No standalone build found. Run `npm run build` first.");
  process.exit(1);
}
cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), { recursive: true });
cpSync(join(root, "public"), join(standalone, "public"), { recursive: true });

const server = spawn(process.execPath, ["server.js"], { cwd: standalone, env: process.env, stdio: "inherit" });
const stop = (signal) => server.kill(signal);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (code) => process.exit(code ?? 0));
