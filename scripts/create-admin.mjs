// Creates (or promotes) the first NF admin account in a live Supabase project.
// Usage: node scripts/create-admin.mjs admin@example.com "Full Name" "temporary-password"
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
// (for example: node --env-file=.env.local scripts/create-admin.mjs ...).
import { createClient } from "@supabase/supabase-js";

const [email, fullName, password] = process.argv.slice(2);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
if (!email || !fullName || !password || !url || !key) {
  console.error('Usage: node --env-file=.env.local scripts/create-admin.mjs <email> "<full name>" <password>');
  console.error("Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: fullName },
  app_metadata: { role: "admin" },
});

let userId = data?.user?.id;
if (error) {
  if (!/already/i.test(error.message)) {
    console.error("Could not create user:", error.message);
    process.exit(1);
  }
  const { data: list } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  userId = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id;
  if (!userId) {
    console.error("User exists but could not be found.");
    process.exit(1);
  }
  console.log("User already existed — promoting to admin.");
}

const { error: pErr } = await supabase.from("profiles").update({ role: "admin", is_active: true, full_name: fullName }).eq("id", userId);
if (pErr) {
  console.error("Could not set admin role on profile:", pErr.message, "— have the migrations been applied?");
  process.exit(1);
}
console.log(`Admin ready: ${email}`);
