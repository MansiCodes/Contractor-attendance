import { z } from "zod";
import { invalid, notFound } from "@/lib/errors";
import { latestPayTerms } from "@/lib/domain/master-import";
import { dateString, id } from "@/lib/domain/schemas";
import type { WorkerPayTerms } from "@/lib/domain/types";
import type { WorkerPayTermsWrite } from "../store/types";
import { assertAdmin, type ServiceContext } from "./context";

// Worker pay terms: each worker's own rate, its basis, and commission eligibility.
// Every change is a new effective-dated version; earlier months keep their terms.

const money = z.coerce.number().min(0, "Cannot be negative").max(1_000_000);

const payTermsChange = z
  .object({
    workerIds: z.array(id).min(1, "Select at least one worker").max(1000),
    effectiveFrom: dateString,
    /** only when changing one worker; undefined keeps the current amount */
    rateAmount: z.preprocess((v) => (v === "" ? null : v), money.nullable()).optional(),
    rateBasis: z.enum(["monthly", "daily", "hourly", "unconfirmed"]).optional(),
    /** undefined keeps the current eligibility; null = not selected */
    commissionEligible: z.boolean().nullable().optional(),
    notes: z
      .string()
      .trim()
      .max(300)
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .refine((v) => v.rateAmount === undefined || v.workerIds.length === 1, { message: "A rate amount can only be set for one worker at a time", path: ["rateAmount"] })
  .refine((v) => v.rateAmount !== undefined || v.rateBasis !== undefined || v.commissionEligible !== undefined, { message: "Nothing to change" });

/**
 * Appends a pay terms version for each selected worker, copying what is not
 * being changed from their latest version. All or nothing.
 */
export async function changeWorkerPayTerms(ctx: ServiceContext, raw: unknown): Promise<WorkerPayTerms[]> {
  assertAdmin(ctx);
  const input = payTermsChange.parse(raw);
  const [workers, terms] = await Promise.all([ctx.store.listWorkers(), ctx.store.listWorkerPayTerms()]);
  const items: WorkerPayTermsWrite[] = input.workerIds.map((workerId) => {
    const worker = workers.find((w) => w.id === workerId);
    if (!worker) throw notFound("Worker");
    const prev = latestPayTerms(terms, workerId);
    if (prev && input.effectiveFrom < prev.effectiveFrom) {
      throw invalid(`${worker.fullName} has pay terms from ${prev.effectiveFrom}. Choose that date or later.`);
    }
    return {
      workerId,
      effectiveFrom: input.effectiveFrom,
      rateAmount: input.rateAmount !== undefined ? input.rateAmount : prev?.rateAmount ?? null,
      rateBasis: input.rateBasis ?? prev?.rateBasis ?? "unconfirmed",
      commissionEligible: input.commissionEligible !== undefined ? input.commissionEligible : prev?.commissionEligible ?? null,
      source: `Changed by ${ctx.actor.fullName}`,
      notes: input.notes,
      // Copied fields come from this version; if another change lands first, this one is refused.
      basedOnVersion: prev?.version ?? 0,
    };
  });
  return ctx.store.createWorkerPayTerms(items, ctx.actor);
}
