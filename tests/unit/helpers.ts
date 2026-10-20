import { DemoStore } from "@/lib/server/store/demo-store";
import { createDemoState, DEMO_USERS } from "@/lib/server/store/demo-seed";
import type { ServiceContext } from "@/lib/server/services/context";
import type { Actor } from "@/lib/domain/types";

/** 20 Oct 2026, 12:30 IST — a fixed "now" so tests are deterministic. */
export const NOW = new Date("2026-10-20T07:00:00.000Z");
export const TODAY = "2026-10-20";

export const actors = {
  admin: { id: DEMO_USERS.admin, role: "admin", fullName: "Demo Admin", email: "admin@demo.invalid" } satisfies Actor,
  jaipur: { id: DEMO_USERS.jaipur, role: "operator", fullName: "Op Jaipur", email: "j@demo.invalid" } satisfies Actor,
  puneLucknow: { id: DEMO_USERS.puneLucknow, role: "operator", fullName: "Op Pune", email: "p@demo.invalid" } satisfies Actor,
  east: { id: DEMO_USERS.east, role: "operator", fullName: "Op East", email: "e@demo.invalid" } satisfies Actor,
};

export function freshStore() {
  return new DemoStore(createDemoState(NOW));
}

export function ctxFor(store: DemoStore, actor: Actor, now: Date = NOW): ServiceContext {
  return { actor, store, now };
}
