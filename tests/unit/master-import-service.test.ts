import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyMasterImport, assignUnassignedWorkers, importedRulesFor, previewMasterImport, setContractorIdentity } from "@/lib/server/services/master-import";
import { workerSummaries } from "@/lib/server/services/directory";
import { adminDirectory } from "@/lib/server/services/admin";
import { actors, ctxFor, freshStore } from "./helpers";
import { buildMasterWorkbook } from "./master-fixture";

const file = async () => ({ name: "master.xlsx", bytes: await buildMasterWorkbook() });

async function previewAndApply(store = freshStore(), opts: { approvedChanges?: string[] } = {}) {
  const ctx = ctxFor(store, actors.admin);
  const f = await file();
  const preview = await previewMasterImport(ctx, f, {});
  const options = { choices: preview.choices, approvedChanges: opts.approvedChanges ?? [], fingerprint: preview.plan.fingerprint };
  const result = await applyMasterImport(ctx, f, options);
  return { store, ctx, preview, result, f };
}

describe("Worker master import (service + demo store)", () => {
  it("is admin-only", async () => {
    const store = freshStore();
    await expect(previewMasterImport(ctxFor(store, actors.pvc), await file(), {})).rejects.toThrow(/admin/i);
    await expect(applyMasterImport(ctxFor(store, actors.pvc), await file(), {})).rejects.toThrow(/admin/i);
    await expect(assignUnassignedWorkers(ctxFor(store, actors.pvc), { workerIds: ["w1"], projectId: "p1", startDate: "2026-10-20" })).rejects.toThrow(/admin/i);
  });

  it("imports valid rows as Unassigned workers with exact IDs, pay terms and new contractors", async () => {
    const { store, ctx, result } = await previewAndApply();
    expect(result.created).toBe(7); // 10 rows with IDs, less the duplicates
    const contractors = await store.listContractors();
    const gamma = contractors.find((c) => c.name === "Gamma")!;
    expect(gamma).toMatchObject({ legalName: "DELTA SINGH CONTRACTORS", identityStatus: "needs_review", location: null });
    expect(contractors.find((c) => c.name === "Beta")!.identityStatus).toBe("confirmed");

    const workers = await store.listWorkers();
    const beta = workers.find((w) => w.employeeCode === "0F 8003")!;
    expect(beta).toMatchObject({ fullName: "BETA ONE", designation: "HELPER", source: "master.xlsx · Beta · row 6" });
    expect(workers.some((w) => w.employeeCode === "OF8033")).toBe(false); // duplicate in sheet → not imported
    expect(workers.some((w) => w.employeeCode === "AL1004")).toBe(false); // in two sheets → not imported

    const summaries = workerSummaries(await adminDirectory(ctx), {});
    const imported = summaries.filter((w) => w.employeeCode && !w.employeeCode.startsWith("D"));
    expect(imported).toHaveLength(7);
    expect(imported.every((w) => w.isActive && w.currentProjectId === null)).toBe(true);

    const terms = await store.listWorkerPayTerms();
    expect(terms.find((t) => t.workerId === beta.id)).toMatchObject({ rateAmount: 480, rateBasis: "daily", effectiveFrom: "2026-09-01", commissionEligible: null });
    const alpha = workers.find((w) => w.employeeCode === "AL1001")!;
    expect(terms.find((t) => t.workerId === alpha.id)).toMatchObject({ rateAmount: 21000, rateBasis: "unconfirmed" });
  });

  it("re-importing the same file adds nothing and is recognised", async () => {
    const { store, ctx, f } = await previewAndApply();
    const before = (await store.listWorkers()).length;
    const again = await previewMasterImport(ctx, f, {});
    expect(again.previousImports).toHaveLength(1);
    expect(again.plan.totals.create).toBe(0);
    expect(again.plan.totals.unchanged).toBe(7);
    await expect(applyMasterImport(ctx, f, { choices: again.choices, approvedChanges: [], fingerprint: again.plan.fingerprint })).rejects.toThrow(/Nothing to import/);
    expect((await store.listWorkers()).length).toBe(before);
  });

  it("refuses to apply when the data changed after the preview", async () => {
    const store = freshStore();
    const ctx = ctxFor(store, actors.admin);
    const f = await file();
    const preview = await previewMasterImport(ctx, f, {});
    // Someone else imports in between.
    await applyMasterImport(ctx, f, { choices: preview.choices, approvedChanges: [], fingerprint: preview.plan.fingerprint });
    await expect(applyMasterImport(ctx, f, { choices: preview.choices, approvedChanges: [], fingerprint: preview.plan.fingerprint })).rejects.toThrow(/changed since this preview/);
    await expect(applyMasterImport(ctx, f, { choices: preview.choices, approvedChanges: [] })).rejects.toThrow(/Preview the import/);
  });

  it("keeps the Rules text as suggestions for the contractor", async () => {
    const { store, ctx } = await previewAndApply();
    const beta = (await store.listContractors()).find((c) => c.name === "Beta")!;
    const found = await importedRulesFor(ctx, beta.id);
    expect(found?.rules).toMatchObject({ commissionPercent: 7.5, commissionScope: "selected", overtimeDayHours: 8.5, overtimeNightHours: 8 });
  });

  it("assigns Unassigned workers to a plant only with the contractor on that plant", async () => {
    const { store, ctx } = await previewAndApply();
    const beta = (await store.listWorkers()).filter((w) => w.employeeCode?.match(/^(0F|OF)/));
    const ids = beta.map((w) => w.id);
    await expect(assignUnassignedWorkers(ctx, { workerIds: ids, projectId: "p1", startDate: "2026-10-20" })).rejects.toThrow(/not assigned to this plant/);
    expect(await assignUnassignedWorkers(ctx, { workerIds: ids, projectId: "p1", startDate: "2026-10-20", addContractorToPlant: true })).toBe(ids.length);
    const summaries = workerSummaries(await adminDirectory(ctx), {});
    expect(summaries.filter((w) => ids.includes(w.id)).every((w) => w.currentProjectId === "p1")).toBe(true);
    // Assigning again is refused (use Transfer instead).
    await expect(assignUnassignedWorkers(ctx, { workerIds: ids.slice(0, 1), projectId: "p2", startDate: "2026-10-21", addContractorToPlant: true })).rejects.toThrow(/already has a plant/);
  });

  it("lets an admin confirm a contractor flagged for review", async () => {
    const { store, ctx } = await previewAndApply();
    const gamma = (await store.listContractors()).find((c) => c.name === "Gamma")!;
    await setContractorIdentity(ctx, gamma.id, { identityStatus: "confirmed", legalName: gamma.legalName, identityNote: "Confirmed with HR" });
    expect((await store.listContractors()).find((c) => c.id === gamma.id)).toMatchObject({ identityStatus: "confirmed", identityNote: "Confirmed with HR" });
    await expect(setContractorIdentity(ctxFor(store, actors.pvc), gamma.id, { identityStatus: "confirmed" })).rejects.toThrow(/admin/i);
  });

  it("rejects files that are not .xlsx workbooks", async () => {
    const ctx = ctxFor(freshStore(), actors.admin);
    await expect(previewMasterImport(ctx, { name: "x.csv", bytes: new Uint8Array([1, 2]) }, {})).rejects.toThrow(/\.xlsx/);
    await expect(previewMasterImport(ctx, { name: "x.xlsx", bytes: new Uint8Array([1, 2, 3]) }, {})).rejects.toThrow(/not a valid/);
  });
});

const MASTER = process.env.MASTER_XLSX;
describe.skipIf(!MASTER || !existsSync(MASTER))("Real contractor master into the demo store (local file only)", () => {
  it("imports all 196 workers, keeps Shukla unconfirmed and Excellent for review, and re-import adds none", async () => {
    const store = freshStore();
    const ctx = ctxFor(store, actors.admin);
    const f = { name: "Contractors Details.xlsx", bytes: new Uint8Array(readFileSync(MASTER!)) };
    const preview = await previewMasterImport(ctx, f, {});
    expect(preview.choices.find((c) => c.sheet === "Shukla")!.rateBasis).toBe("unconfirmed");
    const res = await applyMasterImport(ctx, f, { choices: preview.choices, approvedChanges: [], fingerprint: preview.plan.fingerprint });
    expect(res.created).toBe(196);
    const contractors = await store.listContractors();
    expect(contractors.find((c) => c.name === "Excellent")).toMatchObject({ identityStatus: "needs_review", legalName: "GAJENDRA RANA CONTRACTORS" });
    const again = await previewMasterImport(ctx, f, {});
    expect(again.plan.totals.create).toBe(0);
    expect(again.plan.totals.unchanged).toBe(196);
  });
});
