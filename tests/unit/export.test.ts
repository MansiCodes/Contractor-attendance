import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildAttendanceWorkbook } from "@/lib/export/xlsx";
import { getReport } from "@/lib/server/services/reports";
import { actors, ctxFor, freshStore, TODAY } from "./helpers";

const round2 = (n: number) => Math.round(n * 100) / 100;

describe("13. Excel export reconciles with the app", () => {
  it("writes numeric cells whose sums equal the on-screen totals", async () => {
    const store = freshStore();
    const report = await getReport(ctxFor(store, actors.admin), { from: "2026-10-01", to: TODAY });
    const buf = await buildAttendanceWorkbook(report, { generatedAt: "now", generatedBy: "test", projectLabel: "All projects", contractorLabel: "All contractors" });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Attendance")!;
    const header = (sheet.getRow(1).values as string[]).slice(1);
    const col = (name: string) => header.indexOf(name) + 1;
    expect(sheet.rowCount - 1).toBe(report.rows.length);

    let amount = 0;
    let hours = 0;
    let present = 0;
    let numericAmountCells = 0;
    sheet.eachRow((row, i) => {
      if (i === 1) return;
      const a = row.getCell(col("Estimated amount (₹)")).value;
      const h = row.getCell(col("Net working hours")).value;
      if (a !== null && a !== undefined) {
        expect(typeof a).toBe("number");
        amount += a as number;
        numericAmountCells++;
      }
      if (h !== null && h !== undefined && row.getCell(col("Status")).value === "Present") {
        expect(typeof h).toBe("number");
        hours += h as number;
      }
      if (row.getCell(col("Status")).value === "Present") present++;
      expect(row.getCell(col("Date")).value).toBeInstanceOf(Date);
      // Time cells are numeric day-fractions in the file; ExcelJS reads date-formatted numbers back as Date.
      const inCell = row.getCell(col("IN"));
      if (inCell.value !== null && inCell.value !== undefined) expect(inCell.type).toBe(ExcelJS.ValueType.Date);
    });
    expect(numericAmountCells).toBeGreaterThan(0);
    expect(round2(amount)).toBe(report.totals.amount);
    expect(round2(hours)).toBe(report.totals.netHours);
    expect(present).toBe(report.totals.presentDays);

    // Summary sheet grand total row matches too.
    const summary = wb.getWorksheet("Summary")!;
    let grand: ExcelJS.Row | null = null;
    summary.eachRow((row) => {
      if (row.getCell(1).value === "ALL CONTRACTORS") grand = row;
    });
    expect(grand).not.toBeNull();
    const g = grand as unknown as ExcelJS.Row;
    expect(g.getCell(4).value).toBe(report.totals.presentDays);
    expect(g.getCell(8).value).toBe(report.totals.netHours);
    expect(g.getCell(11).value).toBe(report.totals.amount);
    expect(typeof g.getCell(11).value).toBe("number");
  });

  it("adds a plant-wise sheet whose totals match the report and the contractor totals", async () => {
    const store = freshStore();
    const report = await getReport(ctxFor(store, actors.admin), { from: "2026-10-01", to: TODAY });
    const buf = await buildAttendanceWorkbook(report, { generatedAt: "now", generatedBy: "test", projectLabel: "All plants", contractorLabel: "All contractors" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Plant-wise", "Attendance"]);
    const sheet = wb.getWorksheet("Plant-wise")!;
    const header = (sheet.getRow(1).values as string[]).slice(1);
    const col = (name: string) => header.indexOf(name) + 1;
    expect(sheet.rowCount - 1).toBe(report.byProject.length);
    let present = 0;
    let amount = 0;
    sheet.eachRow((row, i) => {
      if (i === 1) return;
      present += row.getCell(col("Present days")).value as number;
      amount += (row.getCell(col("Estimated payable (₹)")).value as number | null) ?? 0;
    });
    expect(present).toBe(report.totals.presentDays);
    expect(round2(amount)).toBe(report.totals.amount);
  });

  it("leaves unconfigured payables blank (not zero) and says why", async () => {
    const store = freshStore();
    const report = await getReport(ctxFor(store, actors.admin), { from: "2026-10-01", to: TODAY, contractorId: "c4" });
    const buf = await buildAttendanceWorkbook(report, { generatedAt: "now", generatedBy: "test", projectLabel: "All", contractorLabel: "c4" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const summary = wb.getWorksheet("Summary")!;
    const statuses: unknown[] = [];
    summary.eachRow((row, i) => {
      if (i > 7 && row.getCell(1).value) statuses.push(row.getCell(12).value);
    });
    expect(statuses).toContain("Not configured");
  });
});
