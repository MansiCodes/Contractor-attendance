import { z } from "zod";
import { conflict, invalid, notFound } from "@/lib/errors";
import { assignmentCovers } from "@/lib/domain/register";
import {
  contractorInput,
  contractorUpdate,
  dateString,
  id,
  operatorCreate,
  paymentRuleInput,
  projectInput,
  workerCreate,
  workerDeactivate,
  workerReactivate,
  workerTransfer,
  workerUpdate,
} from "@/lib/domain/schemas";
import { DEFAULT_TIMEZONE, todayIn } from "@/lib/domain/time";
import type { Contractor, Profile, Project, Worker } from "@/lib/domain/types";
import { assertAdmin, type ServiceContext } from "./context";

// Every function here is admin-only and re-validates its input.

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

const today = (ctx: ServiceContext) => todayIn(DEFAULT_TIMEZONE, ctx.now);

async function getContractor(ctx: ServiceContext, contractorId: string): Promise<Contractor> {
  const c = (await ctx.store.listContractors()).find((x) => x.id === contractorId);
  if (!c) throw notFound("Contractor");
  return c;
}

async function getProject(ctx: ServiceContext, projectId: string): Promise<Project> {
  const p = (await ctx.store.listProjects()).find((x) => x.id === projectId);
  if (!p) throw notFound("Project");
  return p;
}

async function getWorker(ctx: ServiceContext, workerId: string): Promise<Worker> {
  const w = (await ctx.store.listWorkers()).find((x) => x.id === workerId);
  if (!w) throw notFound("Worker");
  return w;
}

/** A worker can only be deployed where their contractor is assigned to the site. */
async function assertContractorOnProject(ctx: ServiceContext, contractorId: string, projectId: string, date: string) {
  const project = await getProject(ctx, projectId);
  if (!project.isActive) throw invalid("That project site is inactive");
  const cpas = await ctx.store.listContractorProjects();
  const ok = cpas.some((a) => a.contractorId === contractorId && a.projectId === projectId && assignmentCovers(a, date));
  if (!ok) throw invalid("This contractor is not assigned to that project. Assign the contractor to the project first.");
}

// ---------- contractors ----------

export async function createContractor(ctx: ServiceContext, raw: unknown) {
  assertAdmin(ctx);
  return ctx.store.createContractor(contractorInput.parse(raw), ctx.actor);
}

export async function updateContractor(ctx: ServiceContext, contractorId: string, raw: unknown) {
  assertAdmin(ctx);
  await getContractor(ctx, contractorId);
  await ctx.store.updateContractor(contractorId, contractorUpdate.parse(raw), ctx.actor);
}

export async function setContractorPhoto(ctx: ServiceContext, contractorId: string, file: { bytes: Uint8Array; contentType: string }) {
  assertAdmin(ctx);
  await getContractor(ctx, contractorId);
  if (!PHOTO_TYPES.includes(file.contentType)) throw invalid("Photo must be a JPEG, PNG or WebP image");
  if (file.bytes.byteLength === 0) throw invalid("The photo file is empty");
  if (file.bytes.byteLength > MAX_PHOTO_BYTES) throw invalid("Photo must be smaller than 2 MB");
  await ctx.store.setContractorPhoto(contractorId, file, ctx.actor);
}

// ---------- projects ----------

export async function createProject(ctx: ServiceContext, raw: unknown) {
  assertAdmin(ctx);
  return ctx.store.createProject(projectInput.parse(raw), ctx.actor);
}

export async function updateProject(ctx: ServiceContext, projectId: string, raw: unknown) {
  assertAdmin(ctx);
  await getProject(ctx, projectId);
  await ctx.store.updateProject(projectId, projectInput.parse(raw), ctx.actor);
}

export async function addContractorToProject(ctx: ServiceContext, raw: unknown) {
  assertAdmin(ctx);
  const input = z.object({ contractorId: id, projectId: id, startDate: dateString.optional() }).parse(raw);
  await getContractor(ctx, input.contractorId);
  await getProject(ctx, input.projectId);
  await ctx.store.addContractorToProject(input.contractorId, input.projectId, input.startDate ?? today(ctx), ctx.actor);
}

export async function removeContractorFromProject(ctx: ServiceContext, raw: unknown) {
  assertAdmin(ctx);
  const input = z.object({ assignmentId: id }).parse(raw);
  await ctx.store.endContractorProject(input.assignmentId, today(ctx), ctx.actor);
}

// ---------- workers ----------

export async function createWorker(ctx: ServiceContext, raw: unknown) {
  assertAdmin(ctx);
  const input = workerCreate.parse(raw);
  const contractor = await getContractor(ctx, input.contractorId);
  if (!contractor.isActive) throw invalid("That contractor is inactive");
  await assertContractorOnProject(ctx, input.contractorId, input.projectId, input.startDate);
  return ctx.store.createWorker(input, ctx.actor);
}

export async function updateWorker(ctx: ServiceContext, workerId: string, raw: unknown) {
  assertAdmin(ctx);
  await getWorker(ctx, workerId);
  await ctx.store.updateWorker(workerId, workerUpdate.parse(raw), ctx.actor);
}

export async function deactivateWorker(ctx: ServiceContext, workerId: string, raw: unknown) {
  assertAdmin(ctx);
  const worker = await getWorker(ctx, workerId);
  if (!worker.isActive) throw conflict("Worker is already inactive");
  const { lastWorkingDate } = workerDeactivate.parse(raw);
  await ctx.store.deactivateWorker(workerId, lastWorkingDate, ctx.actor);
}

export async function reactivateWorker(ctx: ServiceContext, workerId: string, raw: unknown) {
  assertAdmin(ctx);
  const worker = await getWorker(ctx, workerId);
  if (worker.isActive) throw conflict("Worker is already active");
  const input = workerReactivate.parse(raw);
  await assertContractorOnProject(ctx, worker.contractorId, input.projectId, input.startDate);
  const last = (await ctx.store.listWorkerAssignments())
    .filter((a) => a.workerId === workerId)
    .sort((a, b) => (b.endDate ?? "9999").localeCompare(a.endDate ?? "9999"))[0];
  if (last?.endDate && input.startDate <= last.endDate) {
    throw invalid(`Start date must be after the previous assignment ended (${last.endDate})`);
  }
  await ctx.store.reactivateWorker(workerId, input.projectId, input.startDate, ctx.actor);
}

export async function transferWorker(ctx: ServiceContext, workerId: string, raw: unknown) {
  assertAdmin(ctx);
  const worker = await getWorker(ctx, workerId);
  if (!worker.isActive) throw invalid("Worker is inactive. Reactivate instead.");
  const input = workerTransfer.parse(raw);
  await assertContractorOnProject(ctx, input.contractorId, input.projectId, input.effectiveDate);
  await ctx.store.transferWorker(workerId, input.projectId, input.contractorId, input.effectiveDate, ctx.actor);
}

// ---------- operators ----------

export async function createOperator(ctx: ServiceContext, raw: unknown): Promise<Profile> {
  assertAdmin(ctx);
  const input = operatorCreate.parse(raw);
  if (ctx.store.kind === "supabase" && !input.password) throw invalid("Set a temporary password for the operator");
  return ctx.store.createOperator(input, ctx.actor);
}

export async function setOperatorActive(ctx: ServiceContext, raw: unknown) {
  assertAdmin(ctx);
  const input = z.object({ profileId: id, isActive: z.boolean() }).parse(raw);
  if (input.profileId === ctx.actor.id) throw invalid("You cannot deactivate your own account");
  const profile = await ctx.store.getProfile(input.profileId);
  if (!profile) throw notFound("User");
  if (profile.role !== "operator") throw invalid("Only operator accounts can be changed here");
  await ctx.store.setProfileActive(input.profileId, input.isActive, ctx.actor);
}

export async function setOperatorAccess(ctx: ServiceContext, raw: unknown) {
  assertAdmin(ctx);
  const input = z.object({ operatorId: id, projectId: id, granted: z.boolean() }).parse(raw);
  const profile = await ctx.store.getProfile(input.operatorId);
  if (!profile || profile.role !== "operator") throw notFound("Operator");
  await getProject(ctx, input.projectId);
  if (input.granted) await ctx.store.grantOperatorAccess(input.operatorId, input.projectId, ctx.actor);
  else await ctx.store.revokeOperatorAccess(input.operatorId, input.projectId, ctx.actor);
}

// ---------- payment rules ----------

export async function createPaymentRule(ctx: ServiceContext, raw: unknown) {
  assertAdmin(ctx);
  const input = paymentRuleInput.parse(raw);
  await getContractor(ctx, input.contractorId);
  if (input.effectiveFrom < today(ctx) && !input.allowBackdate) {
    throw invalid("This rule starts in the past and would change past totals. Tick the confirmation box to proceed.");
  }
  const rules = (await ctx.store.listPaymentRules()).filter((r) => r.contractorId === input.contractorId);
  const latest = rules.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  if (latest && input.effectiveFrom < latest.effectiveFrom) {
    throw invalid(`A newer rule already starts on ${latest.effectiveFrom}. New versions must start on or after that date.`);
  }
  const { allowBackdate: _ignored, ...fields } = input;
  void _ignored;
  if (fields.rateType === "per_day") fields.hourRate = null;
  else {
    fields.dayRate = null;
    fields.fullDayHours = null;
    fields.halfDayHours = null;
  }
  if (!fields.overtimeEnabled) {
    fields.overtimeAfterHours = null;
    fields.overtimeHourRate = null;
  }
  return ctx.store.createPaymentRule(fields, ctx.actor);
}

// ---------- read models for admin screens ----------

export async function adminDirectory(ctx: ServiceContext) {
  assertAdmin(ctx);
  const [profiles, contractors, projects, cpas, workers, assignments, access, rules] = await Promise.all([
    ctx.store.listProfiles(),
    ctx.store.listContractors(),
    ctx.store.listProjects(),
    ctx.store.listContractorProjects(),
    ctx.store.listWorkers(),
    ctx.store.listWorkerAssignments(),
    ctx.store.listOperatorAccess(),
    ctx.store.listPaymentRules(),
  ]);
  return { today: today(ctx), profiles, contractors, projects, cpas, workers, assignments, access, rules };
}
