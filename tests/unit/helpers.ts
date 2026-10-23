import { DemoStore } from "@/lib/server/store/demo-store";
import { createDemoState, DEMO_USERS } from "@/lib/server/store/demo-seed";
import type { ServiceContext } from "@/lib/server/services/context";
import type { Actor } from "@/lib/domain/types";

/** 20 Oct 2026, 12:30 IST — a fixed "now" so tests are deterministic. */
export const NOW = new Date("2026-10-20T07:00:00.000Z");
export const TODAY = "2026-10-20";

export const actors = {
  admin: { id: DEMO_USERS.admin, role: "admin", fullName: "Demo Admin", email: "admin@demo.invalid" } satisfies Actor,
  pvc: { id: DEMO_USERS.pvc, role: "operator", fullName: "Op PVC", email: "pvc@demo.invalid" } satisfies Actor,
  ledUpcast: { id: DEMO_USERS.ledUpcast, role: "operator", fullName: "Op LED & Upcast", email: "led@demo.invalid" } satisfies Actor,
  quad: { id: DEMO_USERS.quad, role: "operator", fullName: "Op Quad", email: "quad@demo.invalid" } satisfies Actor,
};

export function freshStore() {
  return new DemoStore(createDemoState(NOW));
}

export function ctxFor(store: DemoStore, actor: Actor, now: Date = NOW): ServiceContext {
  return { actor, store, now };
}
