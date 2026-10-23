import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultChoices,
  looseCode,
  parseMaster,
  parsePeriod,
  planMasterImport,
  toImportWrite,
  type ParsedMaster,
} from "@/lib/domain/master-import";
import { readWorkbookGrids } from "@/lib/import/xlsx-grid";
import type { Contractor } from "@/lib/domain/types";
import { buildMasterWorkbook } from "./master-fixture";

async function sample(): Promise<ParsedMaster> {
  return parseMaster(await readWorkbookGrids(await buildMasterWorkbook()));
}

const contractor = (id: string, name: string, legalName: string | null = null): Contractor => ({
  id, name, location: null, legalName, identityStatus: "confirmed", identityNote: null, photoPath: null, photoUrl: null,
  isActive: true, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
});

describe("Worker master import — parsing", () => {
  it("reads every sheet, skipping blank rows, merged cells and formula totals", async () => {
    const parsed = await sample();
    expect(parsed.sheets.map((s) => s.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    const alpha = parsed.sheets[0];
    expect(alpha.rows).toHaveLength(3);
    expect(alpha.heading).toBe("ALPHA KUMAR LABOUR SUPPLY");
    expect(alpha.period).toBe("SEP-2026");
    expect(alpha.periodStart).toBe("2026-09-01");
    expect(parsed.sheets[1].periodStart).toBe("2026-09-01"); // "MONTH 0F" typed with a zero
    expect(alpha.rows[1]).toMatchObject({ employeeCode: "AL1002", fullName: "TEST WORKER TWO", designation: "HELPER", rateAmount: 12500, row: 8 });
    expect(parsed.issues.some((i) => i.code === "summary_ignored")).toBe(true);
  });

  it("keeps employee IDs exactly as written and flags mixed 0F/OF prefixes", async () => {
    const parsed = await sample();
    const beta = parsed.sheets[1];
    expect(beta.rows.map((r) => r.employeeCode)).toEqual(["0F 8003", "0F8008", "OF8032", "OF8033", "OF8033", null]);
    expect(parsed.issues.find((i) => i.sheet === "Beta" && i.code === "code_prefix_mixed")).toBeTruthy();
    expect(parsed.issues.find((i) => i.sheet === "Beta" && i.code === "code_has_space" && i.row === 6)).toBeTruthy();
    expect(looseCode("0F 8003")).toBe(looseCode("OF8003"));
  });

  it("reads the second 'Department' column as Designation", async () => {
    const parsed = await sample();
    expect(parsed.sheets[1].rows[0]).toMatchObject({ department: "PRODUCTION", designation: "HELPER" });
    expect(parsed.issues.some((i) => i.sheet === "Beta" && i.code === "header_repeated")).toBe(true);
  });

  it("reports rows without an ID, duplicate IDs and S.No gaps", async () => {
    const parsed = await sample();
    const err = (sheet: string, code: string) => parsed.issues.filter((i) => i.sheet === sheet && i.code === code);
    expect(err("Beta", "missing_code")).toHaveLength(1);
    expect(err("Beta", "duplicate_in_sheet").map((i) => i.row)).toEqual([12, 14]);
    expect(err("Alpha", "serial_gap")[0].message).toContain("S.No 3");
    expect(parsed.issues.filter((i) => i.code === "duplicate_across_sheets").map((i) => `${i.sheet}!${i.row}`).sort()).toEqual(["Alpha!10", "Gamma!10"]);
    expect(parsed.sheets.map((s) => s.validRows)).toEqual([3, 5, 3]);
  });

  it("suggests a daily basis only with evidence; salary-like sheets stay unconfirmed", async () => {
    const parsed = await sample();
    const [alpha, beta, gamma] = parsed.sheets;
    expect(alpha.suggestedBasis).toBe("unconfirmed");
    expect(alpha.basisReasons.join(" ")).toContain("monthly");
    expect(beta.suggestedBasis).toBe("daily"); // Rules: "per day"
    expect(gamma.suggestedBasis).toBe("daily"); // "Day Rate" header
    expect(gamma.rows[1].rateAmount).toBe(520); // a worker-specific rate is kept
  });

  it("parses the Rules sheet into suggestions per contractor", async () => {
    const parsed = await sample();
    const byLabel = Object.fromEntries(parsed.rules.map((r) => [r.sheet, r]));
    expect(byLabel.Alpha).toMatchObject({ standardHours: 8, overtimeDayHours: 8, overtimeNightHours: 8, commissionEnabled: true, commissionPercent: 8, commissionScope: "all", rateBasis: null });
    expect(byLabel.Beta).toMatchObject({ overtimeDayHours: 8.5, overtimeNightHours: 8, commissionPercent: 7.5, commissionScope: "selected", rateBasis: "daily", rateAmount: 480 });
    expect(byLabel.Gamma).toMatchObject({ commissionEnabled: false, commissionPercent: null });
  });

  it("flags a sheet whose heading names a different contractor", async () => {
    const parsed = await sample();
    expect(parsed.sheets.map((s) => s.identityMismatch)).toEqual([false, false, true]);
    expect(parsed.issues.find((i) => i.code === "identity_mismatch")?.sheet).toBe("Gamma");
  });

  it("parses month headings", () => {
    expect(parsePeriod("WAGES SHEET FOR THE MONTH OF SEP-2026")).toEqual({ period: "SEP-2026", start: "2026-09-01" });
    expect(parsePeriod("for the month 0f Sept 2026")).toEqual({ period: "SEP-2026", start: "2026-09-01" });
    expect(parsePeriod("no month here")).toBeNull();
  });
});

describe("Worker master import — planning", () => {
  it("creates workers unassigned, new contractors per sheet, and a flagged one as Needs review", async () => {
    const parsed = await sample();
    const choices = defaultChoices(parsed, [], "2026-10-23");
    const plan = planMasterImport(parsed, { contractors: [], workers: [], payTerms: [] }, choices, new Set());
    expect(plan.totals.create).toBe(7); // Alpha 2 + Beta 3 + Gamma 2: duplicate and missing IDs are excluded
    expect(plan.sheets.find((s) => s.sheet === "Gamma")!.contractor).toMatchObject({ create: true, identityStatus: "needs_review", legalName: "DELTA SINGH CONTRACTORS" });
    expect(plan.sheets.find((s) => s.sheet === "Alpha")!.contractor).toMatchObject({ create: true, identityStatus: "confirmed" });
    const write = toImportWrite(plan, { contractors: [], workers: [], payTerms: [] }, { name: "master.xlsx", hash: "h", expectedLastBatchId: null }, {});
    expect(write.contractors).toHaveLength(3);
    expect(write.creates.every((c) => c.payTerms.effectiveFrom === "2026-09-01")).toBe(true);
    expect(write.creates.find((c) => c.employeeCode === "AL1001")!.payTerms).toMatchObject({ rateAmount: 21000, rateBasis: "unconfirmed" });
  });

  it("re-importing the same data creates nothing and reports rows as unchanged", async () => {
    const parsed = await sample();
    const c = [contractor("c-a", "Alpha", "ALPHA KUMAR LABOUR SUPPLY"), contractor("c-b", "Beta", "BETA MANPOWER SEVVICES"), contractor("c-g", "Gamma", "DELTA SINGH CONTRACTORS")];
    const choices = defaultChoices(parsed, c, "2026-10-23");
    expect(choices.map((x) => x.contractorId)).toEqual(["c-a", "c-b", "c-g"]);
    const first = planMasterImport(parsed, { contractors: c, workers: [], payTerms: [] }, choices, new Set());
    // Simulate what the first import stored.
    const write = toImportWrite(first, { contractors: c, workers: [], payTerms: [] }, { name: "m.xlsx", hash: "h", expectedLastBatchId: null }, {});
    const workers = write.creates.map((w, i) => ({
      id: `w${i}`, code: `W-${i}`, employeeCode: w.employeeCode, fullName: w.fullName, contractorId: "id" in w.contractor ? w.contractor.id : "",
      department: w.department, designation: w.designation, isActive: true, phone: null, notes: null, source: w.source, createdAt: "", updatedAt: "",
    }));
    const payTerms = write.creates.map((w, i) => ({ id: `t${i}`, workerId: `w${i}`, version: 1, ...w.payTerms, commissionEligible: null, notes: null, createdAt: "", createdBy: null }));
    const again = planMasterImport(parsed, { contractors: c, workers, payTerms }, choices, new Set());
    expect(again.totals.create).toBe(0);
    expect(again.totals.unchanged).toBe(workers.length);
    expect(toImportWrite(again, { contractors: c, workers, payTerms }, { name: "m.xlsx", hash: "h", expectedLastBatchId: null }, {}).creates).toHaveLength(0);
  });

  it("changes an existing worker only when the admin approves, and never merges look-alike IDs", async () => {
    const parsed = await sample();
    const c = [contractor("c-a", "Alpha", "ALPHA KUMAR LABOUR SUPPLY"), contractor("c-b", "Beta", "BETA MANPOWER SEVVICES")];
    const workers = [
      { id: "w1", code: "W-00001", employeeCode: "AL1001", fullName: "TEST WORKER 1", contractorId: "c-a", department: "PRODUCTION", designation: "OPERATOR", isActive: true, phone: null, notes: null, source: null, createdAt: "", updatedAt: "" },
      { id: "w2", code: "W-00002", employeeCode: "0F8032", fullName: "BETA THREE", contractorId: "c-b", department: "PRODUCTION", designation: "HELPER", isActive: true, phone: null, notes: null, source: null, createdAt: "", updatedAt: "" },
    ];
    const payTerms = [{ id: "t1", workerId: "w1", version: 1, effectiveFrom: "2026-09-01", rateAmount: 20000, rateBasis: "unconfirmed" as const, commissionEligible: null, source: null, notes: null, createdAt: "", createdBy: null }];
    const choices = defaultChoices(parsed, c, "2026-10-23").map((x) => (x.sheet === "Gamma" ? { ...x, include: false } : x));
    const plan = planMasterImport(parsed, { contractors: c, workers, payTerms }, choices, new Set());
    const al = plan.rows.find((r) => r.employeeCode === "AL1001")!;
    expect(al.plan).toMatchObject({ kind: "update", approved: false, newPayTerms: true });
    expect(al.plan.kind === "update" && al.plan.changes.map((x) => x.field)).toEqual(["fullName", "rateAmount"]);
    expect(plan.rows.find((r) => r.employeeCode === "OF8032")!.plan).toMatchObject({ kind: "skip" });
    const unapproved = toImportWrite(plan, { contractors: c, workers, payTerms }, { name: "m.xlsx", hash: "h", expectedLastBatchId: null }, {});
    expect(unapproved.updates).toHaveLength(0);

    const approved = planMasterImport(parsed, { contractors: c, workers, payTerms }, choices, new Set([al.key]));
    expect(approved.fingerprint).not.toBe(plan.fingerprint);
    const write = toImportWrite(approved, { contractors: c, workers, payTerms }, { name: "m.xlsx", hash: "h", expectedLastBatchId: null }, {});
    expect(write.updates).toMatchObject([
      { workerId: "w1", fields: { fullName: "TEST WORKER ONE", department: "PRODUCTION", designation: "OPERATOR" }, payTerms: expect.objectContaining({ rateAmount: 21000, effectiveFrom: "2026-09-01" }) },
    ]);
  });

  it("skips an ID that already belongs to another contractor", async () => {
    const parsed = await sample();
    const c = [contractor("c-x", "Other")];
    const workers = [{ id: "w9", code: "W-00009", employeeCode: "GM3001", fullName: "SOMEONE", contractorId: "c-x", department: null, designation: null, isActive: true, phone: null, notes: null, source: null, createdAt: "", updatedAt: "" }];
    const plan = planMasterImport(parsed, { contractors: c, workers, payTerms: [] }, defaultChoices(parsed, c, "2026-10-23"), new Set());
    expect(plan.rows.find((r) => r.employeeCode === "GM3001")!.plan).toMatchObject({ kind: "skip" });
  });
});

// The real master is never committed. Run with MASTER_XLSX=<path to Contractors Details.xlsx>.
const MASTER = process.env.MASTER_XLSX;
describe.skipIf(!MASTER || !existsSync(MASTER))("Real contractor master (local file only)", () => {
  it("finds 40 + 15 + 49 + 92 = 196 workers with IDs", async () => {
    const parsed = parseMaster(await readWorkbookGrids(new Uint8Array(readFileSync(MASTER!))));
    const counts = Object.fromEntries(parsed.sheets.map((s) => [s.name, s.validRows]));
    expect(counts).toEqual({ Shukla: 40, Optimum: 15, Sumit: 49, Excellent: 92 });
    const plan = planMasterImport(parsed, { contractors: [], workers: [], payTerms: [] }, defaultChoices(parsed, [], "2026-10-23"), new Set());
    expect(plan.totals.create).toBe(196);
    expect(parsed.sheets.find((s) => s.name === "Shukla")!.suggestedBasis).toBe("unconfirmed");
    expect(parsed.sheets.filter((s) => s.identityMismatch).map((s) => s.name)).toEqual(["Excellent"]);
    expect(parsed.sheets.find((s) => s.name === "Optimum")!.rows.map((r) => r.employeeCode)).toContain("0F 8003");
  });
});
