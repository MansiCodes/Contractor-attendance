import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

// Password hashing (scrypt) and session tokens. Same format as scripts/lib/password.mjs,
// which the admin scripts use; a test checks both agree.
// Stored as: scrypt$N$r$p$<salt base64>$<hash base64>

const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(password.normalize("NFKC"), salt, keyLength, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P, KEY_LENGTH);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

// Verifying a missing account costs the same time as a real one, so response times
// do not reveal which emails have accounts.
const DUMMY = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(KEY_LENGTH).toString("base64")}`;

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? DUMMY).split("$");
  const valid = parts.length === 6 && parts[0] === "scrypt";
  const [, n, r, p, salt, hash] = valid ? parts : DUMMY.split("$");
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p), expected.length);
  return !!stored && valid && key.length === expected.length && timingSafeEqual(key, expected);
}

export const MIN_PASSWORD_LENGTH = 10;

/** Why a new password is not acceptable, or null. */
export function passwordProblem(password: string, email?: string | null): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > 128) return "Use at most 128 characters";
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 3 && password.toLowerCase().includes(local)) return "Do not use your email name in the password";
  if (/^(.)\1+$/.test(password)) return "Choose a less predictable password";
  return null;
}

/** A random session token for the cookie, and the SHA-256 kept in the database. */
export function newSessionToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest();

export const isWellFormedToken = (token: string | undefined | null): token is string => !!token && /^[A-Za-z0-9_-]{43}$/.test(token);

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A temporary password an admin can pass on; the user must change it at the first sign-in. */
export function temporaryPassword(length = 14): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
