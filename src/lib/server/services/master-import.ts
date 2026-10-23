import { createHash } from "node:crypto";
import { z } from "zod";
import { conflict, invalid, notFound } from "@/lib/errors";
import {
  defaultChoices,
  parseMaster,
  planMasterImport,
  toImportWrite,
  type ContractorRulesText,
  type ImportIssue,
  type MasterImportPlan,
  type ParsedMaster,
  type SheetChoice,
} from "@/lib/domain/master-import";
import { assignmentCovers } from "@/lib/domain/register";
import { dateString, id } from "@/lib/domain/schemas";
import { readWorkbookGrids } from "@/lib/import/xlsx-grid";
import { assertAdmin, headOfficeToday, type ServiceContext } from "./context";

// Worker master import: preview (read-only) and apply (one atomic store call).
// Apply re-reads the same file and re-plans against the current data; if the
// result differs from what the admin previewed, nothing is written.

export const MAX_MASTER_BYTES = 3 * 1024 * 1024;

export interface UploadedFile {
  name: string;
  bytes: Uint8Array;
}

const sheetChoice = z.object({
  sheet: z.string().min(1).max(100),
  include: z.boolean(),
  contractorId: id.nullable(),
  newContractorName: z.string().trim().max(120),
  identityConfirmed: z.boolean(),
  rateBasis: z.enum(["monthly", "daily", "hourly", "unconfirmed"]),
  effectiveFrom: dateString,
});

const importOptions = z.object({
  choices: z.array(sheetChoice).max(50).optional(),
  approvedChanges: z.union([z.literal("all"), z.array(z.string().max(140)).max(5000)]).default([]),
  /** the preview's fingerprint; apply refuses when the plan no longer matches */
  fingerprint: z.string().max(40).optional(),
});

function checkFile(file: UploadedFile) {
  if (!/\.xlsx$/i.test(file.name)) throw invalid("Upload the workbook as an Excel .xlsx file");
  if (file.bytes.byteLength === 0) throw invalid("The file is empty");
  if (file.bytes.byteLength > MAX_MASTER_BYTES) throw invalid("The file is larger than 3 MB");
  // .xlsx files are zip archives: "PK\x03\x04"
  if (file.bytes[0] !== 0x50 || file.bytes[1] !== 0x4b) throw invalid("This file is not a valid .xlsx workbook");
}

async function parse(file: UploadedFile): Promise<ParsedMaster> {
  checkFile(file);
  try {
    return parseMaster(await readWorkbookGrids(file.bytes));
  } catch (e) {
    throw invalid((e as Error).message || "The workbook could not be read");
  }
}

async function existingMaster(ctx: ServiceContext) {
  const [contractors, workers, payTerms, batches] = await Promise.all([
    ctx.store.listContractors(),
    ctx.store.listWorkers(),
    ctx.store.listWorkerPayTerms(),
    ctx.store.listImportBatches(),
  ]);
  return { contractors, workers, payTerms, batches };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface MasterImportPreview {
  fileName: string;
  fileHash: string;
  previousImports: { at: string; by: string | null }[];
  sheets: {
    name: string;
    heading: string | null;
    period: string | null;
    rateHeader: string | null;
    validRows: number;
    totalRows: number;
    suggestedBasis: SheetChoice["rateBasis"];
    basisReasons: string[];
    identityMismatch: boolean;
    rules: ContractorRulesText | null;
  }[];
  ignoredSheets: string[];
  issues: ImportIssue[];
  choices: SheetChoice[];
  plan: MasterImportPlan;
  contractors: { id: string; name: string; legalName: string | null }[];
}

export async function previewMasterImport(ctx: ServiceContext, file: UploadedFile, rawOptions: unknown): Promise<MasterImportPreview> {
  assertAdmin(ctx);
  const options = importOptions.parse(rawOptions ?? {});
  const parsed = await parse(file);
  const existing = await existingMaster(ctx);
  const today = await headOfficeToday(ctx);
  const defaults = defaultChoices(parsed, existing.contractors, today);
  // Keep the admin's choices for sheets that are still in the file; defaults for the rest.
  const choices = defaults.map((d) => options.choices?.find((c) => c.sheet === d.sheet) ?? d);
  const plan = planMasterImport(parsed, existing, choices, options.approvedChanges === "all" ? "all" : new Set(options.approvedChanges));
  const fileHash = sha256(file.bytes);
  const profiles = new Map((await ctx.store.listProfiles()).map((p) => [p.id, p.fullName]));
  return {
    fileName: file.name,
    fileHash,
    previousImports: existing.batches
      .filter((b) => b.kind === "worker_master" && b.fileHash === fileHash)
      .map((b) => ({ at: b.createdAt, by: b.createdBy ? profiles.get(b.createdBy) ?? null : null })),
    sheets: parsed.sheets.map((s) => ({
      name: s.name,
      heading: s.heading,
      period: s.period,
      rateHeader: s.rateHeader,
      validRows: s.validRows,
      totalRows: s.rows.length,
      suggestedBasis: s.suggestedBasis,
      basisReasons: s.basisReasons,
      identityMismatch: s.identityMismatch,
      rules: s.rules,
    })),
    ignoredSheets: parsed.ignoredSheets,
    issues: parsed.issues,
    choices,
    plan,
    contractors: existing.contractors.map((c) => ({ id: c.id, name: c.name, legalName: c.legalName })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function applyMasterImport(ctx: ServiceContext, file: UploadedFile, rawOptions: unknown) {
  assertAdmin(ctx);
  const options = importOptions.parse(rawOptions ?? {});
  if (!options.choices || !options.fingerprint) throw invalid("Preview the import before applying it");
  const parsed = await parse(file);
  const existing = await existingMaster(ctx);
  for (const c of options.choices) {
    if (c.contractorId && !existing.contractors.some((x) => x.id === c.contractorId)) throw notFound("Contractor");
    if (c.include && !c.contractorId && c.newContractorName.trim().length < 2) throw invalid(`Enter a name for the new contractor from sheet "${c.sheet}"`);
  }
  const plan = planMasterImport(parsed, existing, options.choices, options.approvedChanges === "all" ? "all" : new Set(options.approvedChanges));
  if (plan.fingerprint !== options.fingerprint) {
    throw conflict("The workers changed since this preview (or the file is different). Review the preview again before importing.");
  }
  const lastBatch = existing.batches.filter((b) => b.kind === "worker_master").sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  const write = toImportWrite(plan, existing, { name: file.name.slice(0, 200), hash: sha256(file.bytes), expectedLastBatchId: lastBatch?.id ?? null }, {
    totals: plan.totals,
    sheets: plan.sheets.map((s) => ({
      sheet: s.sheet,
      include: s.include,
      contractorId: s.contractor.id,
      contractorName: s.contractor.name,
      createdContractor: s.contractor.create,
      identityStatus: s.contractor.identityStatus,
      rateBasis: s.rateBasis,
      effectiveFrom: s.effectiveFrom,
      counts: s.counts,
      rules: parsed.sheets.find((p) => p.name === s.sheet)?.rules ?? null,
    })),
    issues: { errors: parsed.issues.filter((i) => i.level === "error").length, warnings: parsed.issues.filter((i) => i.level === "warning").length },
  });
  if (write.creates.length === 0 && write.updates.length === 0 && write.contractors.length === 0) {
    throw invalid("Nothing to import: every worker in the file is already up to date or skipped.");
  }
  return ctx.store.applyMasterImport(write, ctx.actor);
}

/**
 * Rules text found for a contractor in earlier imports (newest first), shown as
 * suggestions when an admin sets up the contractor's payment rule. Never applied
 * automatically.
 */
export async function importedRulesFor(ctx: ServiceContext, contractorId: string): Promise<{ rules: ContractorRulesText; fileName: string; importedAt: string } | null> {
  assertAdmin(ctx);
  const [batches, contractors] = await Promise.all([ctx.store.listImportBatches(), ctx.store.listContractors()]);
  const contractor = contractors.find((c) => c.id === contractorId);
  if (!contractor) return null;
  for (const b of [...batches].filter((x) => x.kind === "worker_master").sort((a, c) => c.createdAt.localeCompare(a.createdAt))) {
    const sheets = (b.summary.sheets ?? []) as { contractorId: string | null; contractorName: string; createdContractor: boolean; rules: ContractorRulesText | null }[];
    const hit = sheets.find((s) => s.rules && (s.contractorId === contractorId || (s.createdContractor && s.contractorName === contractor.name)));
    if (hit?.rules) return { rules: hit.rules, fileName: b.fileName, importedAt: b.createdAt };
  }
  return null;
}

// ---------- after the import ----------

const assignInput = z.object({
  workerIds: z.array(id).min(1, "Select at least one worker").max(1000),
  projectId: id,
  startDate: dateString,
  /** also assign each worker's contractor to the plant when it is not there yet */
  addContractorToPlant: z.boolean().default(false),
});

/** Gives Unassigned workers their first plant. Never moves a worker who already has one. */
export async function assignUnassignedWorkers(ctx: ServiceContext, raw: unknown) {
  assertAdmin(ctx);
  const input = assignInput.parse(raw);
  const [workers, assignments, projects, cpas] = await Promise.all([
    ctx.store.listWorkers(),
    ctx.store.listWorkerAssignments(),
    ctx.store.listProjects(),
    ctx.store.listContractorProjects(),
  ]);
  const plant = projects.find((p) => p.id === input.projectId);
  if (!plant) throw notFound("Plant");
  if (!plant.isActive) throw invalid("That plant is inactive");
  const selected = input.workerIds.map((wid) => workers.find((w) => w.id === wid));
  if (selected.some((w) => !w)) throw notFound("Worker");
  for (const w of selected) {
    if (!w!.isActive) throw invalid(`${w!.fullName} is inactive. Reactivate instead.`);
    if (assignments.some((a) => a.workerId === w!.id && (a.endDate === null || a.endDate >= input.startDate)))
      throw invalid(`${w!.fullName} already has a plant. Use Transfer to move them.`);
  }
  const contractorIds = [...new Set(selected.map((w) => w!.contractorId))];
  const missing = contractorIds.filter((c) => !cpas.some((a) => a.contractorId === c && a.projectId === plant.id && assignmentCovers(a, input.startDate)));
  if (missing.length > 0) {
    if (!input.addContractorToPlant) throw invalid("The contractor is not assigned to this plant yet. Tick “Also add the contractor to this plant” to do both.");
    for (const c of missing) {
      if (cpas.some((a) => a.contractorId === c && a.projectId === plant.id && a.endDate === null)) {
        throw invalid("The contractor's assignment to this plant starts after the chosen date. Pick a later start date.");
      }
      await ctx.store.addContractorToProject(c, plant.id, input.startDate, ctx.actor);
    }
  }
  return ctx.store.assignWorkers(input.workerIds, plant.id, input.startDate, ctx.actor);
}

const identityInput = z.object({
  identityStatus: z.enum(["confirmed", "needs_review"]),
  legalName: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((v) => (v ? v : null)),
  identityNote: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((v) => (v ? v : null)),
});

export async function setContractorIdentity(ctx: ServiceContext, contractorId: string, raw: unknown) {
  assertAdmin(ctx);
  const contractor = (await ctx.store.listContractors()).find((c) => c.id === contractorId);
  if (!contractor) throw notFound("Contractor");
  const input = identityInput.parse(raw);
  await ctx.store.setContractorIdentity(contractorId, input, ctx.actor);
}
