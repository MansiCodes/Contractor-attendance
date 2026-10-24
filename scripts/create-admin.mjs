// Creates the first NF admin account (later admins and all operators are created in
// the app). Runs against PostgreSQL with the database owner credentials (see
// scripts/db/connection.mjs); the password is never printed or logged.
//
//   node scripts/create-admin.mjs <email> "<full name>" [--promote] [--dev]
//
// The password is typed at a hidden prompt. Where there is no terminal (a one-off
// ECS task), set ADMIN_PASSWORD_HASH to the output of `npm run hash-password`
// instead; that password then has to be changed at the first sign-in, because the
// hash is visible in the task's settings.
// --promote makes an existing account an active admin and replaces its password.
import { parseArgs } from "node:util";
import { connect } from "./db/connection.mjs";
import { hashPassword, MIN_PASSWORD_LENGTH, promptHidden } from "./lib/password.mjs";

const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000001";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { promote: { type: "boolean", default: false }, dev: { type: "boolean", default: false } },
});
const [rawEmail, rawName] = positionals;
const email = rawEmail?.trim().toLowerCase();
const fullName = rawName?.trim();

function fail(message) {
  console.error(`Stopped: ${message}`);
  process.exit(1);
}

if (!email || !fullName) fail('usage: node scripts/create-admin.mjs <email> "<full name>" [--promote] [--dev]');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith(".invalid")) fail("enter a valid email address.");

let passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim();
let mustChange = true;
if (passwordHash) {
  if (!/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(passwordHash)) fail("ADMIN_PASSWORD_HASH is not a hash from npm run hash-password.");
} else {
  const password = await promptHidden(`New password for ${email}: `);
  const local = email.split("@")[0];
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 128) fail(`use ${MIN_PASSWORD_LENGTH} to 128 characters.`);
  if (local.length >= 3 && password.toLowerCase().includes(local)) fail("do not use your email name in the password.");
  if ((await promptHidden("Type it again: ")) !== password) fail("the two passwords differ.");
  passwordHash = await hashPassword(password);
  mustChange = false;
}

let conn;
try {
  conn = await connect(process.env, { dev: args.dev });
} catch (e) {
  fail(`could not connect: ${e.message}`);
}
const { client, target } = conn;
console.log(`Target: ${target}`);

try {
  await client.query("begin");
  // Acts as the built-in system admin, so the same checks and audit trail apply as in the app.
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [SYSTEM_USER_ID]);
  const existing = (await client.query("select id from auth.users where lower(btrim(email)) = $1", [email])).rows[0];
  // Thrown (not fail()) so the transaction is rolled back and the connection closed below.
  if (existing && !args.promote) throw new Error("an account with this email already exists. Add --promote to make it an admin and replace its password.");
  let id = existing?.id;
  if (!id) {
    id = (await client.query("select auth.admin_create_account($1, $2, 'admin', $3) as id", [email, fullName, passwordHash])).rows[0].id;
    await client.query("update auth.users set must_change_password = $2 where id = $1", [id, mustChange]);
  } else {
    await client.query(
      `update auth.users set password_hash = $2, must_change_password = $3, password_changed_at = now(), failed_attempts = 0, locked_until = null where id = $1`,
      [id, passwordHash, mustChange],
    );
    await client.query("update public.profiles set role = 'admin', is_active = true, full_name = $2 where id = $1", [id, fullName]);
    await client.query("update auth.sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [id]);
  }
  await client.query("commit");
  console.log(`Admin ready: ${email}${existing ? " (promoted)" : ""}.${mustChange ? " The password must be changed at the first sign-in." : ""}`);
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(`Stopped: ${/relation .* does not exist|function .* does not exist/.test(e.message) ? "the schema is missing. Run the migrations first." : e.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
