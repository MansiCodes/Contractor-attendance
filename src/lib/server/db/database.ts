// The app's connection to PostgreSQL, independent of the driver: node-postgres in
// development and production, PGlite in tests. Every statement runs inside a
// transaction that first says who it acts for, so the database's Row Level
// Security applies to every query, whatever the server code does.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are untyped until mapped
export type Row = Record<string, any>;

export interface Queryable {
  query<R extends Row = Row>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface Database {
  /** Runs `fn` in one transaction: committed if it resolves, rolled back if it throws. */
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

/** The account the scheduled jobs act as (an admin profile that cannot sign in). */
export const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Who a transaction acts for.
 * - user:   a signed-in person; RLS sees their id through auth.uid()
 * - system: the scheduled WhatsApp jobs; RLS sees the system admin account
 * - auth:   sign-in itself (no user yet); can only call the sign-in functions
 */
export type DbIdentity = { kind: "user"; userId: string } | { kind: "system" } | { kind: "auth" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runs `fn` in a transaction scoped to `identity` (role and auth.uid() are local to the transaction). */
export function scoped<T>(db: Database, identity: DbIdentity, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (q) => {
    if (identity.kind === "auth") {
      await q.query("set local role app_auth");
    } else {
      const id = identity.kind === "system" ? SYSTEM_USER_ID : identity.userId;
      if (!UUID.test(id)) throw new Error("Invalid user id for a database session");
      await q.query("select set_config('request.jwt.claim.sub', $1, true)", [id]);
      await q.query("set local role authenticated");
    }
    return fn(q);
  });
}
