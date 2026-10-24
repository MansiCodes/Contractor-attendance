// Applies the database schema to PostgreSQL (Amazon RDS in production): first
// db/platform/bootstrap.sql, then supabase/migrations/*.sql in name order. Each file
// and its SHA-256 are recorded in platform.schema_migrations, so a file runs once and
// a changed file that was already applied is refused (add a new migration instead).
//
//   node scripts/db/migrate.mjs                                    shows the target and the plan; changes nothing
//   node scripts/db/migrate.mjs --apply --confirm-target <host>/<database>
//   node scripts/db/migrate.mjs --dev [--apply]                    the local development database (npm run db:dev)
//
// --runtime-role (with --apply) also creates or updates the login the app connects
// with, from DB_RUNTIME_USER and DB_RUNTIME_PASSWORD. That login can do nothing by
// itself (NOINHERIT): every request switches to `authenticated` (Row Level Security)
// or `app_auth` (sign-in functions only). Its password is sent as a SCRAM verifier,
// so the plain text never reaches the server or its logs.
//
// Connection: see scripts/db/connection.mjs (database owner credentials).
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { connect } from "./connection.mjs";

const ROOT = process.cwd();
const BOOTSTRAP = { name: "platform/bootstrap.sql", path: join(ROOT, "db", "platform", "bootstrap.sql") };
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const LOCK_KEY = 7311920051;

const { values: args } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "confirm-target": { type: "string" },
    dev: { type: "boolean", default: false },
    "runtime-role": { type: "boolean", default: false },
  },
});

/** Line endings do not count: a Windows checkout has the same checksum. */
const checksum = (sql) => createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");

function migrationFiles() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return [BOOTSTRAP, ...files.map((f) => ({ name: f, path: join(MIGRATIONS_DIR, f) }))].map((m) => {
    const sql = readFileSync(m.path, "utf8");
    return { ...m, sql, checksum: checksum(sql) };
  });
}

/** A pre-hashed SCRAM-SHA-256 password, as PostgreSQL stores it. */
function scramVerifier(password) {
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** A refusal with a message for the operator. Thrown, so the connection still closes cleanly. */
class Stop extends Error {}
function fail(message) {
  throw new Stop(message);
}

const files = migrationFiles();
let conn;
try {
  conn = await connect(process.env, { dev: args.dev });
} catch (e) {
  console.error(`
Stopped: could not connect: ${e.message}`);
  process.exit(1);
}
const { client, target } = conn;

async function main() {
  const info = (
    await client.query(
      `select current_user as "user", current_database() as db, current_setting('server_version') as version,
              (select rolsuper from pg_roles where rolname = current_user) as superuser,
              to_regclass('platform.schema_migrations') is not null as has_ledger,
              to_regclass('public.profiles') is not null as has_tables`,
    )
  ).rows[0];
  console.log(`Target:   ${target}${conn.dev ? " (local development database)" : ""}`);
  console.log(`Server:   PostgreSQL ${info.version}, connected as ${info.user}${info.superuser ? " (superuser)" : ""}`);

  const applied = new Map();
  if (info.has_ledger) {
    for (const r of (await client.query("select name, checksum from platform.schema_migrations order by name")).rows) applied.set(r.name, r.checksum);
  } else if (info.has_tables) {
    fail("this database already has the app's tables but no migration ledger. It was not set up by this script; compare it with the migrations before going on.");
  }

  const known = new Set(files.map((f) => f.name));
  const changed = files.filter((f) => applied.has(f.name) && applied.get(f.name) !== f.checksum);
  const missing = [...applied.keys()].filter((n) => !known.has(n));
  const pending = files.filter((f) => !applied.has(f.name));
  const newestApplied = [...applied.keys()].filter((n) => n !== BOOTSTRAP.name).sort().pop();
  const outOfOrder = pending.filter((f) => f !== BOOTSTRAP && newestApplied && f.name < newestApplied);

  console.log(`Applied:  ${applied.size} file(s)`);
  console.log(`Pending:  ${pending.length ? "" : "none"}`);
  for (const f of pending) console.log(`  - ${f.name}`);
  if (changed.length) fail(`applied file(s) changed since they ran: ${changed.map((f) => f.name).join(", ")}. Restore them and put the change in a new migration.`);
  if (missing.length) fail(`applied file(s) are missing from this checkout: ${missing.join(", ")}. Is this the right version of the app?`);
  if (outOfOrder.length) fail(`pending file(s) are older than the newest applied one: ${outOfOrder.map((f) => f.name).join(", ")}. Rename them to run after ${newestApplied}.`);

  if (!args.apply) {
    if (pending.length || args["runtime-role"]) {
      console.log(`\nNothing was changed. To apply, run again with: --apply ${conn.dev ? "--dev" : `--confirm-target ${target}`}`);
    }
    return;
  }
  if (!conn.dev && args["confirm-target"] !== target) {
    fail(`--confirm-target must be exactly "${target}" to change this database.`);
  }

  const lock = await client.query("select pg_try_advisory_lock($1) as ok", [LOCK_KEY]);
  if (!lock.rows[0].ok) fail("another migration is running on this database.");

  await client.query(`create schema if not exists platform`);
  await client.query(`revoke all on schema platform from public`);
  await client.query(
    `create table if not exists platform.schema_migrations (
       name text primary key,
       checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
       applied_at timestamptz not null default now(),
       applied_by text not null default current_user
     )`,
  );

  for (const f of pending) {
    process.stdout.write(`Applying ${f.name} ... `);
    const started = Date.now();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout = '15s'");
      await client.query(f.sql);
      await client.query("insert into platform.schema_migrations (name, checksum) values ($1, $2)", [f.name, f.checksum]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      console.log("failed");
      fail(`${f.name} was rolled back: ${e.message}`);
    }
    console.log(`done (${Date.now() - started} ms)`);
  }

  if (args["runtime-role"]) {
    if (conn.dev) {
      console.log("Skipping --runtime-role: the local development database has a single user.");
    } else {
      const user = process.env.DB_RUNTIME_USER ?? "";
      const password = process.env.DB_RUNTIME_PASSWORD ?? "";
      if (!/^[a-z_][a-z0-9_]{2,62}$/.test(user)) fail("DB_RUNTIME_USER must be a lower-case name such as nf_app.");
      if (user === info.user) fail("the runtime login must not be the database owner.");
      if (password.length < 24 || !/^[\x21-\x7e]+$/.test(password)) fail("DB_RUNTIME_PASSWORD must be at least 24 printable ASCII characters.");
      const id = client.escapeIdentifier(user);
      const verifier = client.escapeLiteral(scramVerifier(password));
      const exists = (await client.query("select 1 from pg_roles where rolname = $1", [user])).rowCount > 0;
      await client.query("begin");
      await client.query(
        exists
          ? `alter role ${id} with login noinherit nocreatedb nocreaterole nobypassrls password ${verifier}`
          : `create role ${id} with login noinherit nocreatedb nocreaterole nobypassrls password ${verifier}`,
      );
      await client.query(`grant authenticated, app_auth to ${id}`);
      await client.query(`revoke all on database ${client.escapeIdentifier(info.db)} from public`);
      await client.query(`grant connect on database ${client.escapeIdentifier(info.db)} to ${id}`);
      await client.query("commit");
      console.log(`Runtime login ${user} ${exists ? "updated" : "created"} (NOINHERIT; may switch to authenticated and app_auth only).`);
    }
  }
  console.log(pending.length ? `\nApplied ${pending.length} file(s) to ${target}.` : "\nThe schema was already up to date.");
}

// Every path ends here, so the session always disconnects cleanly (an abrupt
// process.exit skips the rollback and leaves the server holding a reset connection).
try {
  await main();
} catch (e) {
  console.error(`\nStopped: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
