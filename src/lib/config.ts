import { AppError } from "@/lib/errors";

// Decides whether the app runs on the isolated in-memory demo data or on Supabase.
// - APP_MODE=demo  → always demo (Supabase is never contacted)
// - APP_MODE=live  → always Supabase; missing credentials is a hard error, never a demo fallback
// - unset          → live when Supabase credentials exist, otherwise demo

export type AppMode = "demo" | "live";

type Env = Record<string, string | undefined>;

export function supabaseConfig(env: Env = process.env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = (env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  return url && anonKey ? { url, anonKey } : null;
}

export function getAppMode(env: Env = process.env): AppMode {
  const explicit = env.APP_MODE?.trim().toLowerCase();
  const hasSupabase = supabaseConfig(env) !== null;
  if (explicit === "live") {
    if (!hasSupabase) {
      throw new AppError(
        "APP_MODE is 'live' but NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set.",
        "config",
      );
    }
    return "live";
  }
  if (explicit === "demo") return "demo";
  if (explicit) throw new AppError(`Unknown APP_MODE '${explicit}'. Use 'demo' or 'live'.`, "config");
  return hasSupabase ? "live" : "demo";
}

export const isDemoMode = (env: Env = process.env) => getAppMode(env) === "demo";
