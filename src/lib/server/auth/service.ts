import { invalid } from "@/lib/errors";
import type { Role } from "@/lib/domain/types";
import { scoped, type Database } from "../db/database";
import { mapDbError } from "../db/errors";
import { hashPassword, hashToken, isWellFormedToken, newSessionToken, passwordProblem, verifyPassword } from "./password";

// Sign-in for development and production (demo mode has its own demo sign-in).
// Passwords are checked here; the database stores only hashes and runs the account
// rules (lockout, active profile, session expiry) in its auth.* functions.

export const SESSION_COOKIE = "nf_session";
/** Sessions last 7 days and end earlier on sign-out, password change or deactivation. */
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

const WRONG = "Email or password is incorrect";

export type SignInResult =
  | { ok: true; token: string; expiresAt: Date; mustChangePassword: boolean }
  | { ok: false; error: string };

export async function signIn(db: Database, email: string, password: string, meta: { userAgent?: string | null; ip?: string | null } = {}): Promise<SignInResult> {
  const lookup = await scoped(db, { kind: "auth" }, (q) =>
    q.query<{ user_id: string; password_hash: string | null; locked_until: Date | string | null; is_active: boolean }>("select * from auth.sign_in_lookup($1)", [email]),
  );
  const user = lookup.rows[0];
  const correct = await verifyPassword(password, user?.password_hash ?? null);
  if (!user) return { ok: false, error: WRONG };
  const locked = user.locked_until !== null && new Date(user.locked_until).getTime() > Date.now();
  if (!correct) {
    // Every wrong password counts, also while locked; only the right password learns about the lock.
    await scoped(db, { kind: "auth" }, (q) => q.query("select auth.sign_in_failed($1)", [user.user_id]));
    return { ok: false, error: WRONG };
  }
  if (locked) return { ok: false, error: "This account is locked for a few minutes after several wrong passwords. Try again later." };
  if (!user.is_active) return { ok: false, error: "This account is not active. Contact NF head office." };
  const { token, hash } = newSessionToken();
  const started = await scoped(db, { kind: "auth" }, (q) =>
    q.query<{ expires_at: Date | string; must_change_password: boolean }>("select * from auth.sign_in_succeeded($1, $2, $3, $4, $5)", [
      user.user_id,
      hash,
      SESSION_TTL_SECONDS,
      meta.userAgent ?? null,
      meta.ip ?? null,
    ]),
  ).catch((e) => {
    throw mapDbError(e);
  });
  const row = started.rows[0];
  return { ok: true, token, expiresAt: new Date(row.expires_at), mustChangePassword: row.must_change_password };
}

export interface SessionInfo {
  userId: string;
  sessionId: string;
  mustChangePassword: boolean;
}

export async function resolveSession(db: Database, token: string | undefined | null): Promise<SessionInfo | null> {
  if (!isWellFormedToken(token)) return null;
  const res = await scoped(db, { kind: "auth" }, (q) =>
    q.query<{ user_id: string; session_id: string; must_change_password: boolean }>("select * from auth.session_user($1)", [hashToken(token)]),
  );
  const r = res.rows[0];
  return r ? { userId: r.user_id, sessionId: r.session_id, mustChangePassword: r.must_change_password } : null;
}

export async function signOut(db: Database, token: string | undefined | null) {
  if (!isWellFormedToken(token)) return;
  await scoped(db, { kind: "auth" }, (q) => q.query("select auth.end_session($1)", [hashToken(token)]));
}

/** The signed-in user's own password. Other sessions end; this one stays. */
export async function changeOwnPassword(db: Database, who: { userId: string; email: string; sessionId: string }, current: string, next: string) {
  const lookup = await scoped(db, { kind: "auth" }, (q) =>
    q.query<{ user_id: string; password_hash: string | null }>("select * from auth.sign_in_lookup($1)", [who.email]),
  );
  const user = lookup.rows[0];
  if (!user || user.user_id !== who.userId) throw invalid("Please sign in again");
  if (!(await verifyPassword(current, user.password_hash))) {
    await scoped(db, { kind: "auth" }, (q) => q.query("select auth.sign_in_failed($1)", [user.user_id]));
    throw invalid("The current password is not correct");
  }
  if (current === next) throw invalid("Choose a new password that is different from the current one");
  const problem = passwordProblem(next, who.email);
  if (problem) throw invalid(problem);
  const hash = await hashPassword(next);
  await scoped(db, { kind: "user", userId: who.userId }, (q) => q.query("select auth.change_own_password($1, $2)", [hash, who.sessionId])).catch((e) => {
    throw mapDbError(e);
  });
}

/** An admin creates an account with a temporary password (changed at the first sign-in). Returns the new id. */
export async function createAccount(db: Database, adminId: string, input: { email: string; fullName: string; role: Role; password: string }): Promise<string> {
  const problem = passwordProblem(input.password, input.email);
  if (problem) throw invalid(`Temporary password: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
  const hash = await hashPassword(input.password);
  const res = await scoped(db, { kind: "user", userId: adminId }, (q) =>
    q.query<{ id: string }>("select auth.admin_create_account($1, $2, $3::public.app_role, $4) as id", [input.email, input.fullName, input.role, hash]),
  ).catch((e) => {
    throw mapDbError(e);
  });
  return res.rows[0].id;
}

/** An admin sets a temporary password for someone; their sessions end. */
export async function resetPassword(db: Database, adminId: string, userId: string, password: string, email?: string) {
  const problem = passwordProblem(password, email);
  if (problem) throw invalid(`Temporary password: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
  const hash = await hashPassword(password);
  await scoped(db, { kind: "user", userId: adminId }, (q) => q.query("select auth.admin_reset_password($1, $2)", [userId, hash])).catch((e) => {
    throw mapDbError(e);
  });
}
