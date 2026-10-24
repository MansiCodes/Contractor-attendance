// Password hashing for the admin scripts. Same format as src/lib/server/auth/password.ts
// (a unit test checks the two agree): scrypt$N$r$p$<salt base64>$<hash base64>
import { randomBytes, scrypt as scryptCallback } from "node:crypto";

const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

export function hashPassword(password) {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) =>
    scryptCallback(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(`scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`),
    ),
  );
}

export const MIN_PASSWORD_LENGTH = 10;

/** Asks for a password on the terminal without echoing it. */
export function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error("A terminal is needed to type a password"));
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch) => {
      if (ch === "\u0003") {
        stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (ch === "\u0008" || ch === "\u007f") value = value.slice(0, -1);
      else value += ch;
    };
    stdin.on("data", onData);
  });
}
