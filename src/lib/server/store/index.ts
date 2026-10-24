import "server-only";
import { getAppMode } from "@/lib/config";
import type { Actor } from "@/lib/domain/types";
import type { DataStore } from "./types";

/**
 * The store for one signed-in user. Demo and database data are fully isolated: with
 * a database configured the demo module is never loaded, and a failing database
 * surfaces as an error instead of falling back to demo data.
 */
export async function getStore(actor: Actor): Promise<DataStore> {
  if (getAppMode() === "demo") {
    const { getDemoStore } = await import("./demo-store");
    return getDemoStore();
  }
  const [{ PostgresStore }, { pgDatabase }, { getObjectStorage }] = await Promise.all([
    import("./postgres-store"),
    import("../db/pool"),
    import("../storage"),
  ]);
  return new PostgresStore(pgDatabase(), { kind: "user", userId: actor.id }, getObjectStorage());
}

/**
 * Store for server jobs with no signed-in user: the scheduled WhatsApp dispatcher and
 * the provider webhook. It acts as the system account (an admin profile that cannot
 * sign in), so Row Level Security still applies. Only call it after the job's own
 * secret or signature has been verified.
 */
export async function getServiceStore(): Promise<DataStore> {
  if (getAppMode() === "demo") {
    const { getDemoStore } = await import("./demo-store");
    return getDemoStore();
  }
  const [{ PostgresStore }, { pgDatabase }, { getObjectStorage }] = await Promise.all([
    import("./postgres-store"),
    import("../db/pool"),
    import("../storage"),
  ]);
  return new PostgresStore(pgDatabase(), { kind: "system" }, getObjectStorage());
}
