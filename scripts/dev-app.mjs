// Runs `next dev` in development mode against the local development database
// (npm run db:dev), with photos stored on disk under .data/uploads. Settings given
// here win over .env.local; WhatsApp stays simulated outside production.
import { spawn } from "node:child_process";
import { DEV_DATABASE_URL } from "./db/connection.mjs";

const env = {
  ...process.env,
  APP_MODE: "development",
  DATABASE_URL: process.env.DEV_APP_DATABASE_URL || DEV_DATABASE_URL,
  DATABASE_SSL: "disable",
  // The PGlite server takes one connection; a real local PostgreSQL can take more.
  DATABASE_POOL_MAX: process.env.DEV_APP_DATABASE_URL ? "5" : "1",
  STORAGE_DRIVER: "local",
};
const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", ...process.argv.slice(2)], { env, stdio: "inherit" });
next.on("exit", (code) => process.exit(code ?? 0));
