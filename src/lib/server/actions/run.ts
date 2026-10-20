import "server-only";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { AppError } from "@/lib/errors";
import { getContext } from "../session";
import type { ServiceContext } from "../services/context";

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export function toActionError(e: unknown): { ok: false; error: string; code?: string } {
  if (e instanceof AppError) return { ok: false, error: e.message, code: e.code };
  if (e instanceof ZodError) {
    const issue = e.issues[0];
    return { ok: false, error: issue ? issue.message : "Invalid input", code: "invalid" };
  }
  console.error("[action] unexpected error", e);
  return { ok: false, error: "Something went wrong on the server. Please try again.", code: "server" };
}

/** Runs a service call for a server action: authenticates, maps errors, refreshes pages. */
export async function runAction<T>(fn: (ctx: ServiceContext) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const ctx = await getContext();
    const data = await fn(ctx);
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return toActionError(e);
  }
}
