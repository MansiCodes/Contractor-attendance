import "server-only";
import { readFileSync } from "node:fs";
import { Pool, types } from "pg";
import { databaseConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import type { Database, Queryable } from "./database";

// One connection pool per server process. Each request borrows a connection for a
// single transaction and returns it, so a handful of connections serve everyone.

// DATE columns stay "yyyy-MM-dd" strings (never shifted through a JS Date).
types.setTypeParser(1082, (v) => v);

const g = globalThis as unknown as { __nfPool?: Pool };

function createPool(): Pool {
  const cfg = databaseConfig();
  let ssl: false | { rejectUnauthorized: boolean; ca?: string } = false;
  if (cfg.ssl === "verify-full") {
    let ca: string | undefined;
    if (cfg.sslCaFile) {
      try {
        ca = readFileSync(cfg.sslCaFile, "utf8");
      } catch {
        throw new AppError(`DATABASE_SSL_CA file ${cfg.sslCaFile} could not be read`, "config");
      }
    }
    ssl = { rejectUnauthorized: true, ca };
  } else if (cfg.ssl === "require") {
    ssl = { rejectUnauthorized: false };
  }
  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl,
    max: cfg.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    application_name: "nf-attendance",
  });
  // A dropped idle connection must not crash the server; the pool replaces it.
  pool.on("error", (e) => console.error("[db] idle connection error:", e.message));
  return pool;
}

export function getPool(): Pool {
  if (!g.__nfPool) g.__nfPool = createPool();
  return g.__nfPool;
}

/** node-postgres as a Database: one pooled connection per transaction. */
export function pgDatabase(pool: Pool = getPool()): Database {
  return {
    async transaction(fn) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query("begin");
        const result = await fn(client as unknown as Queryable);
        await client.query("commit");
        return result;
      } catch (e) {
        try {
          await client.query("rollback");
        } catch {
          broken = true; // the connection is unusable: drop it instead of reusing it
        }
        throw e;
      } finally {
        client.release(broken ? true : undefined);
      }
    },
  };
}
