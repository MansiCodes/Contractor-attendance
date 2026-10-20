import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { supabaseConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";

/** Supabase client acting as the signed-in user (RLS applies). */
export async function createServerSupabase() {
  const cfg = supabaseConfig();
  if (!cfg) throw new AppError("Supabase is not configured", "config");
  const cookieStore = await cookies();
  return createServerClient(cfg.url, cfg.anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies are refreshed by the proxy instead.
        }
      },
    },
  });
}

/**
 * Service-role client. Server-only; used solely for creating operator accounts
 * after the caller has been verified as an active admin.
 */
export function createAdminSupabase() {
  const cfg = supabaseConfig();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY)?.trim();
  if (!cfg || !key) {
    throw new AppError("SUPABASE_SERVICE_ROLE_KEY is required to create operator accounts", "config");
  }
  return createClient(cfg.url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
