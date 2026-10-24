// A local PostgreSQL for development mode that needs no installation: PGlite
// (PostgreSQL compiled to WebAssembly) served over the PostgreSQL protocol on
// 127.0.0.1 only. Data is kept in .data/dev-db, which git ignores.
//
//   npm run db:dev              start it (keep this terminal open)
//   npm run db:dev:migrate      apply the migrations to it
//   npm run db:dev:admin -- <email> "<full name>"
//   npm run dev:pg              the app in development mode against it
//
// PGlite serves one connection at a time, so the app uses a pool of one. For a
// database closer to Amazon RDS, use a real PostgreSQL 17 (docker-compose.yml).
import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { DEV_DATABASE, DEV_DATABASE_URL } from "./db/connection.mjs";

const dir = process.env.DEV_DB_DIR || ".data/dev-db";
mkdirSync(dir, { recursive: true });
const db = await PGlite.create(dir, { extensions: { btree_gist } });
const server = new PGLiteSocketServer({ db, host: DEV_DATABASE.host, port: DEV_DATABASE.port, maxConnections: 1 });
await server.start();
console.log(`Development database: ${DEV_DATABASE_URL} (data in ${dir})`);
console.log("Press Ctrl+C to stop.");

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
