import "server-only";
import { getAppMode } from "@/lib/config";
import type { DataStore } from "./types";

/**
 * Returns the store for the current request. Demo and live data are fully
 * isolated: in live mode the demo module is never loaded, and a failing
 * Supabase call surfaces as an error instead of falling back to demo data.
 */
export async function getStore(): Promise<DataStore> {
  if (getAppMode() === "demo") {
    const { getDemoStore } = await import("./demo-store");
    return getDemoStore();
  }
  const [{ createServerSupabase }, { SupabaseStore }] = await Promise.all([
    import("@/lib/supabase/server"),
    import("./supabase-store"),
  ]);
  return new SupabaseStore(await createServerSupabase());
}
