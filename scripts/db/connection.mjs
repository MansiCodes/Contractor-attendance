// Database connection for the admin scripts (migrations, first admin). They use the
// database OWNER credentials (the RDS master user), never the app's runtime user.
//
// Either MIGRATION_DATABASE_URL, or DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
// (the form used by the one-off ECS task, which reads them from Secrets Manager).
// DATABASE_SSL: verify-full (default unless the host is local) | require | disable
// DATABASE_SSL_CA: path to the Amazon RDS CA bundle (included in the Docker image).
// --dev instead targets the local development database started by `npm run db:dev`.
import { readFileSync } from "node:fs";
import pg from "pg";

pg.types.setTypeParser(1082, (v) => v);

/** The local development database (scripts/dev-db.mjs). */
export const DEV_DATABASE = { host: "127.0.0.1", port: 54329, database: "postgres", user: "postgres" };
export const DEV_DATABASE_URL = `postgres://${DEV_DATABASE.user}@${DEV_DATABASE.host}:${DEV_DATABASE.port}/${DEV_DATABASE.database}`;

const isLocal = (host) => host === "localhost" || host === "127.0.0.1" || host === "::1";

export function connectionSettings(env = process.env, { dev = false } = {}) {
  if (dev) return { ...DEV_DATABASE, password: "", ssl: false, target: `${DEV_DATABASE.host}/${DEV_DATABASE.database}`, dev: true };
  let host = env.DB_HOST ?? "";
  let port = Number(env.DB_PORT || 5432);
  let database = env.DB_NAME ?? "";
  let user = env.DB_USER ?? "";
  let password = env.DB_PASSWORD ?? "";
  if (env.MIGRATION_DATABASE_URL) {
    const u = new URL(env.MIGRATION_DATABASE_URL);
    host = u.hostname;
    port = Number(u.port || 5432);
    database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    user = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
  }
  if (!host || !database || !user) {
    throw new Error("Set MIGRATION_DATABASE_URL, or DB_HOST, DB_NAME, DB_USER and DB_PASSWORD (database owner credentials), or pass --dev.");
  }
  const sslMode = (env.DATABASE_SSL || (isLocal(host) ? "disable" : "verify-full")).toLowerCase();
  let ssl = false;
  if (sslMode === "verify-full") ssl = { rejectUnauthorized: true, ca: env.DATABASE_SSL_CA ? readFileSync(env.DATABASE_SSL_CA, "utf8") : undefined };
  else if (sslMode === "require") ssl = { rejectUnauthorized: false };
  else if (sslMode !== "disable") throw new Error("DATABASE_SSL must be verify-full, require or disable");
  if (sslMode === "disable" && !isLocal(host)) throw new Error(`Refusing an unencrypted connection to ${host}. Use DATABASE_SSL=verify-full.`);
  return { host, port, database, user, password, ssl, target: `${host}/${database}`, dev: false };
}

export async function connect(env = process.env, opts = {}) {
  const s = connectionSettings(env, opts);
  const client = new pg.Client({
    host: s.host,
    port: s.port,
    database: s.database,
    user: s.user,
    password: s.password,
    ssl: s.ssl,
    application_name: "nf-attendance-admin",
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  return { client, target: s.target, user: s.user, dev: s.dev };
}
