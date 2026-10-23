import { calculateDay, round2, ruleForDate, termsForDate, type DayCalculation } from "./calc";
import { dayLabels, NO_LABELS, operatorEditClosesAt, resolvePolicy, type AttendancePolicyVersion, type DayLabels, type EffectivePolicy } from "./policy";
import { assignmentCovers } from "./register";
import { addDays, instantToLocal } from "./time";
import type {
  AttendanceRecord,
  AttendanceStatus,
  CheckInSource,
  Contractor,
  PaymentRule,
  Project,
  Shift,
  Worker,
  WorkerAssignment,
  WorkerPayTerms,
} from "./types";

// One report builder feeds the on-screen report, the overview and the Excel
// export, so every total reconciles by construction.

export interface ReportRow {
  key: string;
  workerId: string;
  workerCode: string;
  /** the contractor's own employee ID */
  employeeCode: string | null;
  workerName: string;
  contractorId: string;
  contractorName: string;
  projectId: string;
  projectName: string;
  workDate: string;
  /** shift of the record (day when nothing is recorded) */
  shift: Shift;
  status: AttendanceStatus;
  checkIn: string | null;
  checkOut: string | null;
  checkOutNextDay: boolean;
  /** how IN was recorded (null for older records) */
  checkInSource: CheckInSource | null;
  calc: DayCalculation;
  /** attendance-policy labels: late, half day, overtime, absent – not marked. Never affect pay. */
  labels: DayLabels;
}

export interface ReportTotals {
  workers: number;
  presentDays: number;
  absentDays: number;
  /** nothing recorded yet (excludes days shown as "Absent – not marked") */
  pendingDays: number;
  /** auto-absent (report-only): nothing recorded and the operator window has closed */
  notMarkedAbsentDays: number;
  /** present but OUT not recorded — excluded from hours and payable */
  incompleteDays: number;
  /** sum of per-row rounded net hours (complete records only) */
  netHours: number;
  payableDays: number;
  payableHours: number;
  amount: number;
  /** rows that have a computed amount */
  pricedDays: number;
  /** rows that would be payable but have no rule */
  unconfiguredDays: number;
  /** rows whose rule is missing a setting the calculation needs ("Needs configuration") */
  needsConfigDays: number;
}

export interface ReportGroup {
  key: string;
  contractorId: string;
  contractorName: string;
  projectId: string | null;
  projectName: string | null;
  /** plants (stored as projects) this group covers */
  sites: number;
  /** contractor has at least one payment rule version */
  ruleConfigured: boolean;
  totals: ReportTotals;
}

/** Plant-wise totals across every contractor working at that plant. */
export interface PlantGroup {
  key: string;
  projectId: string;
  projectName: string;
  /** contractors with worker-days at this plant in the period */
  contractors: number;
  /** how many of those contractors have a payment rule version (0 = payable "Not configured") */
  contractorsWithRules: number;
  totals: ReportTotals;
}

export interface Report {
  from: string;
  to: string;
  rows: ReportRow[];
  byContractor: ReportGroup[];
  byContractorProject: ReportGroup[];
  byProject: PlantGroup[];
  totals: ReportTotals;
}

export interface ReportInput {
  from: string;
  to: string;
  projectId?: string | null;
  contractorId?: string | null;
  projects: Project[];
  contractors: Contractor[];
  workers: Worker[];
  assignments: WorkerAssignment[];
  records: AttendanceRecord[];
  rules: PaymentRule[];
  /** Workers' own rates and commission eligibility (for rules that use them). Admin data. */
  payTerms?: WorkerPayTerms[];
  /** Today's date per project timezone. Pending is only counted up to today. */
  todayByProject: Record<string, string>;
  /** Attendance policy versions; when given (with `now`), rows carry labels. */
  policies?: AttendancePolicyVersion[];
  now?: Date;
}

function emptyTotals(): ReportTotals {
  return {
    workers: 0,
    presentDays: 0,
    absentDays: 0,
    pendingDays: 0,
    notMarkedAbsentDays: 0,
    incompleteDays: 0,
    netHours: 0,
    payableDays: 0,
    payableHours: 0,
    amount: 0,
    pricedDays: 0,
    unconfiguredDays: 0,
    needsConfigDays: 0,
  };
}

function accumulate(totals: ReportTotals, row: ReportRow) {
  const c = row.calc;
  if (row.status === "present") totals.presentDays++;
  else if (row.status === "absent") totals.absentDays++;
  else if (row.labels.notMarkedAbsent) totals.notMarkedAbsentDays++;
  else totals.pendingDays++;
  if (c.incomplete) totals.incompleteDays++;
  if (c.complete && c.netHours !== null) totals.netHours += c.netHours;
  if (c.payableUnits !== null) {
    if (c.unit === "day") totals.payableDays += c.payableUnits;
    if (c.unit === "hour") totals.payableHours += c.payableUnits;
  }
  if (c.amountState === "ok" && c.amount !== null) {
    totals.amount += c.amount;
    totals.pricedDays++;
  }
  if (c.amountState === "not_configured") totals.unconfiguredDays++;
  if (c.amountState === "needs_configuration") totals.needsConfigDays++;
}

function finish(totals: ReportTotals, workerIds: Set<string>): ReportTotals {
  return {
    ...totals,
    workers: workerIds.size,
    amount: round2(totals.amount),
    netHours: round2(totals.netHours),
    payableDays: round2(totals.payableDays),
    payableHours: round2(totals.payableHours),
  };
}

export function buildReport(input: ReportInput): Report {
  const { from, to } = input;
  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  const contractorById = new Map(input.contractors.map((c) => [c.id, c]));
  const workerById = new Map(input.workers.map((w) => [w.id, w]));
  const matches = (projectId: string, contractorId: string) =>
    (!input.projectId || input.projectId === projectId) && (!input.contractorId || input.contractorId === contractorId);

  const rows: ReportRow[] = [];
  const recorded = new Set<string>();

  // Labels: the work-date policy decides what applies; the window that closes a day
  // for operators comes from the policy in force on the site's today.
  const policyCache = new Map<string, EffectivePolicy>();
  const policyFor = (projectId: string, date: string) => {
    const key = `${projectId}:${date}`;
    let p = policyCache.get(key);
    if (!p) policyCache.set(key, (p = resolvePolicy(input.policies ?? [], projectId, date)));
    return p;
  };
  const labelsFor = (project: Project, workDate: string, record: AttendanceRecord | null): DayLabels => {
    if (!input.policies || !input.now) return NO_LABELS;
    const today = input.todayByProject[project.id] ?? workDate;
    const closesAt = operatorEditClosesAt(policyFor(project.id, today), workDate, project.timezone);
    return dayLabels(policyFor(project.id, workDate), record, workDate, project.timezone, input.now.getTime() >= closesAt.getTime());
  };

  const makeRow = (
    workerId: string,
    projectId: string,
    contractorId: string,
    workDate: string,
    record: AttendanceRecord | null,
  ): ReportRow | null => {
    const worker = workerById.get(workerId);
    const project = projectById.get(projectId);
    if (!worker || !project) return null;
    const tz = project.timezone;
    const rule = ruleForDate(input.rules, contractorId, workDate);
    const calc = calculateDay(record, rule, rule?.rateSource === "worker" ? termsForDate(input.payTerms ?? [], workerId, workDate) : null);
    const inLocal = record?.checkInAt ? instantToLocal(record.checkInAt, tz) : null;
    const outLocal = record?.checkOutAt ? instantToLocal(record.checkOutAt, tz) : null;
    return {
      key: `${workerId}:${projectId}:${workDate}`,
      workerId,
      workerCode: worker.code,
      employeeCode: worker.employeeCode,
      workerName: worker.fullName,
      contractorId,
      contractorName: contractorById.get(contractorId)?.name ?? "Unknown contractor",
      projectId,
      projectName: project.name,
      workDate,
      shift: record?.shift ?? "day",
      status: calc.status,
      checkIn: record?.status === "present" ? inLocal?.time ?? null : null,
      checkOut: record?.status === "present" ? outLocal?.time ?? null : null,
      checkOutNextDay: !!(outLocal && outLocal.date > workDate),
      checkInSource: record?.status === "present" ? record.checkInSource : null,
      calc,
      labels: labelsFor(project, workDate, record),
    };
  };

  for (const r of input.records) {
    if (r.workDate < from || r.workDate > to || !matches(r.projectId, r.contractorId)) continue;
    const row = makeRow(r.workerId, r.projectId, r.contractorId, r.workDate, r);
    if (!row) continue;
    rows.push(row);
    recorded.add(row.key);
  }

  // Assigned worker-days with no record are "pending" (never assumed present).
  for (const a of input.assignments) {
    if (!matches(a.projectId, a.contractorId)) continue;
    const today = input.todayByProject[a.projectId];
    if (!today) continue;
    const start = a.startDate > from ? a.startDate : from;
    let end = to < today ? to : today;
    if (a.endDate !== null && a.endDate < end) end = a.endDate;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const key = `${a.workerId}:${a.projectId}:${d}`;
      if (recorded.has(key)) continue;
      if (!assignmentCovers(a, d)) continue;
      const row = makeRow(a.workerId, a.projectId, a.contractorId, d, null);
      if (row) {
        rows.push(row);
        recorded.add(key);
      }
    }
  }

  rows.sort(
    (x, y) =>
      x.workDate.localeCompare(y.workDate) ||
      x.projectName.localeCompare(y.projectName) ||
      x.contractorName.localeCompare(y.contractorName) ||
      x.workerName.localeCompare(y.workerName, "en-IN"),
  );

  const groupMaps = {
    contractor: new Map<string, { totals: ReportTotals; workers: Set<string>; sites: Set<string>; row: ReportRow }>(),
    contractorProject: new Map<string, { totals: ReportTotals; workers: Set<string>; sites: Set<string>; row: ReportRow }>(),
  };
  const plantMap = new Map<string, { totals: ReportTotals; workers: Set<string>; contractors: Set<string>; row: ReportRow }>();
  const grand = emptyTotals();
  const grandWorkers = new Set<string>();

  for (const row of rows) {
    accumulate(grand, row);
    grandWorkers.add(row.workerId);
    let plant = plantMap.get(row.projectId);
    if (!plant) {
      plant = { totals: emptyTotals(), workers: new Set(), contractors: new Set(), row };
      plantMap.set(row.projectId, plant);
    }
    accumulate(plant.totals, row);
    plant.workers.add(row.workerId);
    plant.contractors.add(row.contractorId);
    for (const [kind, key] of [
      ["contractor", row.contractorId],
      ["contractorProject", `${row.contractorId}:${row.projectId}`],
    ] as const) {
      const map = groupMaps[kind];
      let g = map.get(key);
      if (!g) {
        g = { totals: emptyTotals(), workers: new Set(), sites: new Set(), row };
        map.set(key, g);
      }
      accumulate(g.totals, row);
      g.workers.add(row.workerId);
      g.sites.add(row.projectId);
    }
  }

  const ruleContractors = new Set(input.rules.map((r) => r.contractorId));
  const toGroups = (kind: "contractor" | "contractorProject"): ReportGroup[] =>
    [...groupMaps[kind].entries()]
      .map(([key, g]) => ({
        key,
        contractorId: g.row.contractorId,
        contractorName: g.row.contractorName,
        projectId: kind === "contractorProject" ? g.row.projectId : null,
        projectName: kind === "contractorProject" ? g.row.projectName : null,
        sites: g.sites.size,
        ruleConfigured: ruleContractors.has(g.row.contractorId),
        totals: finish(g.totals, g.workers),
      }))
      .sort(
        (a, b) =>
          a.contractorName.localeCompare(b.contractorName) || (a.projectName ?? "").localeCompare(b.projectName ?? ""),
      );

  return {
    from,
    to,
    rows,
    byContractor: toGroups("contractor"),
    byContractorProject: toGroups("contractorProject"),
    byProject: [...plantMap.entries()]
      .map(([key, g]) => ({
        key,
        projectId: g.row.projectId,
        projectName: g.row.projectName,
        contractors: g.contractors.size,
        contractorsWithRules: [...g.contractors].filter((c) => ruleContractors.has(c)).length,
        totals: finish(g.totals, g.workers),
      }))
      .sort((a, b) => a.projectName.localeCompare(b.projectName)),
    totals: finish(grand, grandWorkers),
  };
}

export function formatINR(amount: number): string {
  return `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Human display of an estimated payable, never inventing a figure when a rule or a setting is missing. */
export function payableLabel(t: Pick<ReportTotals, "amount" | "pricedDays" | "unconfiguredDays" | "needsConfigDays">, ruleConfigured: boolean): string {
  if (!ruleConfigured) return "Not configured";
  if (t.pricedDays === 0 && t.unconfiguredDays > 0 && t.needsConfigDays === 0) return "Not configured";
  if (t.pricedDays === 0 && t.needsConfigDays > 0) return "Needs configuration";
  const parts = [formatINR(t.amount)];
  if (t.unconfiguredDays > 0) parts.push(`${t.unconfiguredDays} day(s) not configured`);
  if (t.needsConfigDays > 0) parts.push(`${t.needsConfigDays} day(s) need configuration`);
  return parts.join(" + ");
}
