// Prints the scrypt hash of a password typed at a hidden prompt, for
// ADMIN_PASSWORD_HASH (scripts/create-admin.mjs) where no terminal is available.
// The account created from it must change the password at the first sign-in.
import { hashPassword, MIN_PASSWORD_LENGTH, promptHidden } from "./lib/password.mjs";

const password = await promptHidden("Password: ");
if (password.length < MIN_PASSWORD_LENGTH || password.length > 128) {
  console.error(`Use ${MIN_PASSWORD_LENGTH} to 128 characters.`);
  process.exit(1);
}
if ((await promptHidden("Type it again: ")) !== password) {
  console.error("The two passwords differ.");
  process.exit(1);
}
console.log(await hashPassword(password));
