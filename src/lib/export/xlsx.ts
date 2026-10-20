import ExcelJS from "exceljs";
import { round2 } from "@/lib/domain/calc";
import type { Report, ReportGroup } from "@/lib/domain/report";

// Builds the attendance workbook from the same Report object the screen uses,
// so exported totals always reconcile with the app. Numbers are written as
// numeric cells (dates and times as Excel date/time serials).

const DATE_FMT = "dd-mmm-yyyy";
const TIME_FMT = "hh:mm AM/PM";
const INR_FMT = '"₹"#,##0.00';
const NUM2 = "0.00";

const excelDate = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const excelTime = (time: string | null) => {
  if (!time) return null;
  const [h, m] = time.split(":").map(Number);
  return (h * 60 + m) / 1440;
};

export interface ExportMeta {
  generatedAt: string;
  generatedBy: string;
  projectLabel: string;
  contractorLabel: string;
}

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true };
  row.alignment = { vertical: "middle", wrapText: true };
  row.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF7" } };
    c.border = { bottom: { style: "thin", color: { argb: "FF9AA5B1" } } };
  });
}

export async function buildAttendanceWorkbook(report: Report, meta: ExportMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NF Attendance Register";
  wb.created = new Date();

  // ---------- Summary ----------
  const summary = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 7 }] });
  summary.getCell("A1").value = "Contractor attendance summary";
  summary.getCell("A1").font = { bold: true, size: 14 };
  summary.getCell("A2").value = `Period: ${report.from} to ${report.to}`;
  summary.getCell("A3").value = `Project: ${meta.projectLabel} · Contractor: ${meta.contractorLabel}`;
  summary.getCell("A4").value = `Generated ${meta.generatedAt} by ${meta.generatedBy}`;
  summary.getCell("A5").value =
    "Estimated payables only (not disbursed amounts). Pending entries and entries without an OUT time are excluded from hours and payables.";
  summary.getCell("A5").font = { italic: true, color: { argb: "FF555555" } };

  summary.columns = [
    { key: "contractor", width: 34 },
    { key: "project", width: 40 },
    { key: "workers", width: 10 },
    { key: "present", width: 12 },
    { key: "absent", width: 10 },
    { key: "pending", width: 10 },
    { key: "incomplete", width: 12 },
    { key: "hours", width: 12 },
    { key: "days", width: 12 },
    { key: "phours", width: 12 },
    { key: "amount", width: 18 },
    { key: "status", width: 26 },
  ];
  const header = summary.getRow(7);
  header.values = [
    "Contractor", "Project", "Workers", "Present days", "Absent days", "Pending", "OUT missing",
    "Net hours", "Payable days", "Payable hours", "Estimated payable (₹)", "Rate status",
  ];
  styleHeader(header);

  const addGroupRow = (g: ReportGroup, label: { contractor: string; project: string }, bold = false) => {
    const t = g.totals;
    const priced = g.ruleConfigured && t.pricedDays > 0;
    const row = summary.addRow({
      contractor: label.contractor,
      project: label.project,
      workers: t.workers,
      present: t.presentDays,
      absent: t.absentDays,
      pending: t.pendingDays,
      incomplete: t.incompleteDays,
      hours: t.netHours,
      days: t.payableDays,
      phours: t.payableHours,
      amount: priced ? t.amount : null,
      status: !g.ruleConfigured || (!priced && t.unconfiguredDays > 0) ? "Not configured" : t.unconfiguredDays > 0 ? `${t.unconfiguredDays} day(s) not configured` : "Configured",
    });
    row.getCell("hours").numFmt = NUM2;
    row.getCell("amount").numFmt = INR_FMT;
    if (bold) row.font = { bold: true };
    return row;
  };

  for (const c of report.byContractor) {
    for (const g of report.byContractorProject.filter((x) => x.contractorId === c.contractorId)) {
      addGroupRow(g, { contractor: g.contractorName, project: g.projectName ?? "" });
    }
    addGroupRow(c, { contractor: `${c.contractorName} — total`, project: `${c.sites} site(s)` }, true);
    summary.addRow({});
  }
  const t = report.totals;
  const grand = summary.addRow({
    contractor: "ALL CONTRACTORS",
    project: "",
    workers: t.workers,
    present: t.presentDays,
    absent: t.absentDays,
    pending: t.pendingDays,
    incomplete: t.incompleteDays,
    hours: t.netHours,
    days: t.payableDays,
    phours: t.payableHours,
    amount: t.amount,
    status: t.unconfiguredDays > 0 ? `${t.unconfiguredDays} day(s) not configured` : "",
  });
  grand.font = { bold: true };
  grand.getCell("hours").numFmt = NUM2;
  grand.getCell("amount").numFmt = INR_FMT;

  // ---------- Daily records ----------
  const sheet = wb.addWorksheet("Attendance", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "Date", key: "date", width: 13 },
    { header: "Worker ID", key: "code", width: 11 },
    { header: "Worker name", key: "name", width: 26 },
    { header: "Contractor", key: "contractor", width: 30 },
    { header: "Project", key: "project", width: 38 },
    { header: "Status", key: "status", width: 10 },
    { header: "IN", key: "in", width: 11 },
    { header: "OUT", key: "out", width: 11 },
    { header: "OUT next day", key: "nextDay", width: 8 },
    { header: "Gross hours", key: "gross", width: 10 },
    { header: "Unpaid break (min)", key: "break", width: 10 },
    { header: "Net working hours", key: "net", width: 10 },
    { header: "Overtime hours", key: "ot", width: 10 },
    { header: "Payable units", key: "units", width: 10 },
    { header: "Unit", key: "unit", width: 7 },
    { header: "Rule version", key: "rule", width: 8 },
    { header: "Estimated amount (₹)", key: "amount", width: 14 },
    { header: "Note", key: "note", width: 30 },
  ];
  styleHeader(sheet.getRow(1));

  for (const r of report.rows) {
    const c = r.calc;
    const note =
      r.status === "pending"
        ? "Pending confirmation — not counted"
        : c.incomplete
          ? "OUT not recorded — hours incomplete"
          : c.amountState === "not_configured"
            ? "Payment rule not configured"
            : "";
    const row = sheet.addRow({
      date: excelDate(r.workDate),
      code: r.workerCode,
      name: r.workerName,
      contractor: r.contractorName,
      project: r.projectName,
      status: r.status === "present" ? "Present" : r.status === "absent" ? "Absent" : "Pending",
      in: excelTime(r.checkIn),
      out: excelTime(r.checkOut),
      nextDay: r.checkOutNextDay ? "Yes" : null,
      gross: c.grossMinutes !== null ? round2(c.grossMinutes / 60) : null,
      break: c.complete ? c.breakMinutes : null,
      net: c.netHours,
      ot: c.overtimeMinutes > 0 ? round2(c.overtimeMinutes / 60) : null,
      units: c.payableUnits,
      unit: c.unit,
      rule: c.ruleVersion,
      amount: c.amountState === "ok" ? c.amount : null,
      note,
    });
    row.getCell("date").numFmt = DATE_FMT;
    row.getCell("in").numFmt = TIME_FMT;
    row.getCell("out").numFmt = TIME_FMT;
    row.getCell("gross").numFmt = NUM2;
    row.getCell("net").numFmt = NUM2;
    row.getCell("ot").numFmt = NUM2;
    row.getCell("amount").numFmt = INR_FMT;
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
