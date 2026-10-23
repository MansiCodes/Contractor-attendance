import ExcelJS from "exceljs";
import { round2 } from "@/lib/domain/calc";
import { payrollComplete, type Payroll, type PayrollFigures } from "@/lib/domain/payroll";
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
  summary.getCell("A3").value = `Plant: ${meta.projectLabel} · Contractor: ${meta.contractorLabel}`;
  summary.getCell("A4").value = `Generated ${meta.generatedAt} by ${meta.generatedBy}`;
  summary.getCell("A5").value =
    "Estimated payables only (not disbursed amounts). Pending entries and entries without an OUT time are excluded from hours and payables. Late, half-day and policy overtime labels never change payables.";
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
    { key: "notMarked", width: 12 },
  ];
  const header = summary.getRow(7);
  header.values = [
    "Contractor", "Plant", "Workers", "Present days", "Absent days", "Pending", "OUT missing",
    "Net hours", "Payable days", "Payable hours", "Estimated payable (₹)", "Rate status", "Absent – not marked",
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
      status: !g.ruleConfigured || (!priced && t.unconfiguredDays > 0)
        ? "Not configured"
        : [t.unconfiguredDays > 0 ? `${t.unconfiguredDays} day(s) not configured` : null, t.needsConfigDays > 0 ? `${t.needsConfigDays} day(s) need configuration (not in the amount)` : null]
            .filter(Boolean)
            .join("; ") || "Configured",
      notMarked: t.notMarkedAbsentDays,
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
    addGroupRow(c, { contractor: `${c.contractorName} — total`, project: `${c.sites} plant(s)` }, true);
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
    status: [t.unconfiguredDays > 0 ? `${t.unconfiguredDays} day(s) not configured` : null, t.needsConfigDays > 0 ? `${t.needsConfigDays} day(s) need configuration (not in the amount)` : null]
      .filter(Boolean)
      .join("; "),
    notMarked: t.notMarkedAbsentDays,
  });
  grand.font = { bold: true };
  grand.getCell("hours").numFmt = NUM2;
  grand.getCell("amount").numFmt = INR_FMT;

  // ---------- Plant-wise ----------
  const plants = wb.addWorksheet("Plant-wise", { views: [{ state: "frozen", ySplit: 1 }] });
  plants.columns = [
    { header: "Plant", key: "plant", width: 36 },
    { header: "Contractors", key: "contractors", width: 12 },
    { header: "Workers", key: "workers", width: 10 },
    { header: "Present days", key: "present", width: 12 },
    { header: "Absent days", key: "absent", width: 10 },
    { header: "Absent – not marked", key: "notMarked", width: 12 },
    { header: "Pending", key: "pending", width: 10 },
    { header: "OUT missing", key: "incomplete", width: 12 },
    { header: "Net hours", key: "hours", width: 12 },
    { header: "Estimated payable (₹)", key: "amount", width: 18 },
    { header: "Days without a payment rule", key: "unconfigured", width: 14 },
  ];
  styleHeader(plants.getRow(1));
  for (const g of report.byProject) {
    const t = g.totals;
    const row = plants.addRow({
      plant: g.projectName,
      contractors: g.contractors,
      workers: t.workers,
      present: t.presentDays,
      absent: t.absentDays,
      notMarked: t.notMarkedAbsentDays,
      pending: t.pendingDays,
      incomplete: t.incompleteDays,
      hours: t.netHours,
      amount: t.pricedDays > 0 ? t.amount : null,
      unconfigured: t.unconfiguredDays,
    });
    row.getCell("hours").numFmt = NUM2;
    row.getCell("amount").numFmt = INR_FMT;
  }

  // ---------- Daily records ----------
  const sheet = wb.addWorksheet("Attendance", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "Date", key: "date", width: 13 },
    { header: "Worker ID", key: "code", width: 11 },
    { header: "Employee ID", key: "empCode", width: 12 },
    { header: "Worker name", key: "name", width: 26 },
    { header: "Contractor", key: "contractor", width: 30 },
    { header: "Plant", key: "project", width: 38 },
    { header: "Shift", key: "shift", width: 8 },
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
    { header: "IN recorded as", key: "source", width: 14 },
    { header: "Late (min)", key: "late", width: 9 },
    { header: "Half day (label)", key: "halfDay", width: 9 },
    { header: "Overtime beyond policy (min)", key: "otLabel", width: 11 },
  ];
  styleHeader(sheet.getRow(1));

  for (const r of report.rows) {
    const c = r.calc;
    const note =
      r.labels.notMarkedAbsent
        ? "Absent – not marked (auto-absent, report only)"
        : r.status === "pending"
        ? "Pending confirmation — not counted"
        : c.incomplete
          ? "OUT not recorded — hours incomplete"
          : c.amountState === "not_configured"
            ? "Payment rule not configured"
            : c.amountState === "needs_configuration"
              ? `Needs configuration: ${c.missing.join(", ")}`
              : "";
    const row = sheet.addRow({
      date: excelDate(r.workDate),
      code: r.workerCode,
      empCode: r.employeeCode,
      name: r.workerName,
      contractor: r.contractorName,
      project: r.projectName,
      shift: r.shift === "night" ? "Night" : "Day",
      status: r.status === "present" ? "Present" : r.status === "absent" ? "Absent" : r.labels.notMarkedAbsent ? "Absent (not marked)" : "Pending",
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
      source: r.checkInSource === "suggested" ? "Suggested time" : r.checkInSource === "entered" ? "Entered" : null,
      late: r.labels.lateMinutes,
      halfDay: r.labels.halfDay ? "Yes" : null,
      otLabel: r.labels.overtimeMinutes,
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

// ---------------------------------------------------------------------------
// Payroll estimate
// ---------------------------------------------------------------------------

const TREATMENT_TEXT: Record<string, string> = {
  added_to_contractor_payable: "Paid to the contractor on top of wages",
  deducted_from_wages: "Taken out of the workers' wages",
};

const payrollFlags = (f: PayrollFigures) =>
  [
    f.missing.length > 0 ? `Needs configuration: ${f.missing.join(", ")}` : null,
    f.missingCheckoutDays > 0 ? `${f.missingCheckoutDays} day(s) without OUT excluded` : null,
    f.pendingDays > 0 ? `${f.pendingDays} day(s) pending, not counted` : null,
  ]
    .filter(Boolean)
    .join("; ");

/**
 * Contractor-wise payroll estimate plus one sheet of worker rows. Unknown figures
 * are left empty and the "Flags" column says why, so no total is misleading.
 */
export async function buildPayrollWorkbook(payroll: Payroll, meta: Omit<ExportMeta, "projectLabel">): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NF Attendance Register";
  wb.created = new Date();

  const summary = wb.addWorksheet("Payroll", { views: [{ state: "frozen", ySplit: 6 }] });
  summary.getCell("A1").value = "Contractor payroll estimate";
  summary.getCell("A1").font = { bold: true, size: 14 };
  summary.getCell("A2").value = `Period: ${payroll.from} to ${payroll.to} · Contractor: ${meta.contractorLabel}`;
  summary.getCell("A3").value = `Generated ${meta.generatedAt} by ${meta.generatedBy}`;
  summary.getCell("A4").value =
    "Estimates only, not disbursed amounts. Empty amounts could not be calculated: see Flags. Pending days and days without an OUT time are never counted.";
  summary.getCell("A4").font = { italic: true, color: { argb: "FF555555" } };
  summary.columns = [
    { key: "contractor", width: 32 },
    { key: "workers", width: 9 },
    { key: "hours", width: 11 },
    { key: "days", width: 11 },
    { key: "hrs", width: 11 },
    { key: "ot", width: 10 },
    { key: "base", width: 15 },
    { key: "otw", width: 14 },
    { key: "commission", width: 14 },
    { key: "treatment", width: 32 },
    { key: "total", width: 17 },
    { key: "complete", width: 10 },
    { key: "flags", width: 60 },
  ];
  const head = summary.getRow(6);
  head.values = [
    "Contractor", "Workers", "Confirmed hours", "Standard days", "Standard hours", "OT hours", "Base wages (₹)", "OT wages (₹)",
    "Commission (₹)", "Commission is", "Estimated total payable (₹)", "Complete", "Flags",
  ];
  styleHeader(head);
  const addRow = (name: string, workers: number | null, f: PayrollFigures, treatment: string | null, bold = false) => {
    const row = summary.addRow({
      contractor: name, workers, hours: f.confirmedHours, days: f.standardDays, hrs: f.standardHours, ot: f.overtimeHours,
      base: f.baseWages, otw: f.overtimeWages, commission: f.commission, treatment,
      total: f.totalPayable, complete: payrollComplete(f) ? "Yes" : "No", flags: payrollFlags(f),
    });
    for (const k of ["hours", "days", "hrs", "ot"]) row.getCell(k).numFmt = NUM2;
    for (const k of ["base", "otw", "commission", "total"]) row.getCell(k).numFmt = INR_FMT;
    if (bold) row.font = { bold: true };
  };
  for (const c of payroll.contractors) addRow(c.contractorName, c.workers, c, c.commissionTreatment ? TREATMENT_TEXT[c.commissionTreatment] : null);
  addRow("All contractors", null, payroll.totals, null, true);

  const sheet = wb.addWorksheet("Workers", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "Contractor", key: "contractor", width: 28 },
    { header: "Employee ID", key: "emp", width: 13 },
    { header: "Worker ID", key: "code", width: 11 },
    { header: "Worker name", key: "name", width: 26 },
    { header: "Rate", key: "rate", width: 28 },
    { header: "Present days", key: "present", width: 9 },
    { header: "Absent days", key: "absent", width: 9 },
    { header: "OUT missing", key: "nocheckout", width: 9 },
    { header: "Confirmed hours", key: "hours", width: 10 },
    { header: "Standard days", key: "days", width: 10 },
    { header: "Standard hours", key: "hrs", width: 10 },
    { header: "OT hours", key: "ot", width: 9 },
    { header: "Base wages (₹)", key: "base", width: 14 },
    { header: "OT wages (₹)", key: "otw", width: 13 },
    { header: "Commission applies", key: "applies", width: 10 },
    { header: "Commission (₹)", key: "commission", width: 13 },
    { header: "Estimated payable (₹)", key: "total", width: 15 },
    { header: "Rule versions", key: "versions", width: 9 },
    { header: "Flags", key: "flags", width: 60 },
  ];
  styleHeader(sheet.getRow(1));
  for (const c of payroll.contractors) {
    for (const w of c.workerRows) {
      const row = sheet.addRow({
        contractor: c.contractorName, emp: w.employeeCode, code: w.workerCode, name: w.workerName, rate: w.rateLabel,
        present: w.presentDays, absent: w.absentDays, nocheckout: w.missingCheckoutDays, hours: w.confirmedHours, days: w.standardDays,
        hrs: w.standardHours, ot: w.overtimeHours, base: w.baseWages, otw: w.overtimeWages, applies: w.commissionApplies ? "Yes" : "No",
        commission: w.commission, total: w.totalPayable, versions: w.ruleVersions.join(", "), flags: payrollFlags(w),
      });
      for (const k of ["hours", "days", "hrs", "ot"]) row.getCell(k).numFmt = NUM2;
      for (const k of ["base", "otw", "commission", "total"]) row.getCell(k).numFmt = INR_FMT;
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
