import { conflict, forbidden, invalid, staleSettings } from "@/lib/errors";
import { FALLBACK_TIMEZONE, evaluateEntry, operatorEditClosesAt, policyForShift, type PolicyValues, type ResolvedPolicy } from "@/lib/domain/policy";
import { assignmentCovers, registerEntries } from "@/lib/domain/register";
import { buildReport } from "@/lib/domain/report";
import { attendanceBatch } from "@/lib/domain/schemas";
import { addDays, formatTime12, instantToLocal, isValidDate, nowTimeIn, todayIn } from "@/lib/domain/time";
import type { AttendanceRecord, AttendanceStatus, ChangeMethod, CheckInSource, Project, Shift } from "@/lib/domain/types";
import type { AttendanceWrite } from "../store/types";
import { accessibleProjectIds, accessibleProjects, assertProjectAccess, canEditDate, sitePolicies, type ServiceContext } from "./context";

// Every rule here (suggested IN, overnight, future-time limits, the operator edit
// window) comes from the site's attendance policy; nothing is hardcoded.

export interface SavedEntryDTO {
  recordId: string;
  status: AttendanceStatus;
  checkIn: string | null;
  checkOut: string | null;
  checkOutNextDay: boolean;
  /** exact stored instants, so an untouched time is never rewritten */
  checkInAt: string | null;
  checkOutAt: string | null;
  checkInSource: CheckInSource | null;
  shift: Shift;
  version: number;
  method: ChangeMethod;
}

export interface RegisterRowDTO {
  workerId: string;
  workerCode: string;
  /** the contractor's own employee ID: the matching key on paper registers */
  employeeCode: string | null;
  workerName: string;
  contractorId: string;
  assigned: boolean;
  saved: SavedEntryDTO | null;
}

/** The site's rules as the register needs them (effective values only: no history or notes). */
export interface RegisterPolicyDTO {
  /** in force on the register date, as it applies to the register's shift */
  day: PolicyValues;
  /** in force on the site's today */
  capture: Pick<PolicyValues, "inFutureToleranceMin" | "outFutureToleranceMin" | "operatorBackdateDays" | "editCutoffTime">;
  /** when site operators lose edit access to this date (ISO) */
  operatorEditClosesAt: string;
  /** that moment has passed (for "Absent – not marked") */
  operatorWindowClosed: boolean;
  /** sent back on save to detect a settings change while editing */
  token: string;
}

export interface RegisterView {
  projects: { id: string; name: string; location: string }[];
  project: Pick<Project, "id" | "name" | "location" | "timezone"> | null;
  policy: RegisterPolicyDTO | null;
  contractors: { id: string; name: string; photoUrl: string | null; workerCount: number }[];
  contractorId: string | null;
  date: string;
  /** the register shows this shift: its records, plus workers with nothing recorded yet */
  shift: Shift;
  today: string;
  nowTime: string;
  editable: boolean;
  readOnlyReason: string | null;
  rows: RegisterRowDTO[];
  /** workers already recorded on the other shift that day (not on this register) */
  otherShift: { workerId: string; workerName: string; employeeCode: string | null; workerCode: string; status: AttendanceStatus }[];
}

function toSavedDTO(r: AttendanceRecord, timezone: string): SavedEntryDTO {
  const inL = r.checkInAt ? instantToLocal(r.checkInAt, timezone) : null;
  const outL = r.checkOutAt ? instantToLocal(r.checkOutAt, timezone) : null;
  return {
    recordId: r.id, status: r.status, checkIn: inL?.time ?? null, checkOut: outL?.time ?? null,
    checkOutNextDay: !!outL && outL.date > r.workDate, checkInAt: r.checkInAt, checkOutAt: r.checkOutAt,
    checkInSource: r.checkInSource, shift: r.shift, version: r.version, method: r.method,
  };
}

/** Effective values only, without which versions they came from. */
function withoutIds(p: ResolvedPolicy): PolicyValues {
  const { companyPolicyId, sitePolicyId, ...values } = p;
  void companyPolicyId;
  void sitePolicyId;
  return values;
}

function closedReason(date: string, today: string, closesAt: Date, timezone: string) {
  if (date < today) return "Past dates can only be corrected by NF head office.";
  return `Today's attendance closed for plant attendance operators at ${formatTime12(instantToLocal(closesAt.toISOString(), timezone).time)}. Please contact NF head office for corrections.`;
}

export async function loadRegister(
  ctx: ServiceContext,
  query: { projectId?: string | null; contractorId?: string | null; date?: string | null; shift?: string | null },
): Promise<RegisterView> {
  const shift: Shift = query.shift === "night" ? "night" : "day";
  const projects = await accessibleProjects(ctx);
  const visible = ctx.actor.role === "admin" ? projects : projects.filter((p) => p.isActive);
  const project = visible.find((p) => p.id === query.projectId) ?? visible.find((p) => p.isActive) ?? visible[0] ?? null;
  const projectList = visible.map((p) => ({ id: p.id, name: p.name, location: p.location }));

  if (!project) {
    const today = todayIn(FALLBACK_TIMEZONE, ctx.now);
    return {
      projects: projectList, project: null, policy: null, contractors: [], contractorId: null, date: today, shift, today,
      nowTime: nowTimeIn(FALLBACK_TIMEZONE, ctx.now), editable: false,
      readOnlyReason: "No plants are assigned to you yet. Please contact NF head office.", rows: [], otherShift: [],
    };
  }

  const today = todayIn(project.timezone, ctx.now);
  let date = query.date && isValidDate(query.date) ? query.date : today;
  if (date > today) date = today;
  const policies = await sitePolicies(ctx, project, date);
  const closesAt = operatorEditClosesAt(policies.capture, date, project.timezone);

  const [contractors, cpas, workers, assignments, records] = await Promise.all([
    ctx.store.listContractors(),
    ctx.store.listContractorProjects(),
    ctx.store.listWorkers(),
    ctx.store.listWorkerAssignments(),
    ctx.store.listAttendance({ projectIds: [project.id], from: date, to: date }),
  ]);

  // Contractors on this sheet: assigned to the site on this date, or with workers/records here.
  const onSite = new Set<string>();
  for (const a of cpas) if (a.projectId === project.id && assignmentCovers(a, date)) onSite.add(a.contractorId);
  const workerCounts = new Map<string, number>();
  for (const a of assignments) {
    if (a.projectId !== project.id || !assignmentCovers(a, date)) continue;
    onSite.add(a.contractorId);
    workerCounts.set(a.contractorId, (workerCounts.get(a.contractorId) ?? 0) + 1);
  }
  for (const r of records) onSite.add(r.contractorId);

  const contractorList = contractors
    .filter((c) => onSite.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, photoUrl: c.photoUrl, workerCount: workerCounts.get(c.id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const contractorId = contractorList.find((c) => c.id === query.contractorId)?.id ?? contractorList[0]?.id ?? null;

  const entries = contractorId
    ? registerEntries({ projectId: project.id, contractorId, date, workers, assignments, records })
    : [];

  // One record per worker and day: a worker recorded on the other shift is not on this register.
  const rows: RegisterRowDTO[] = entries
    .filter((e) => !e.record || e.record.shift === shift)
    .map((e) => ({
      workerId: e.worker.id, workerCode: e.worker.code, employeeCode: e.worker.employeeCode, workerName: e.worker.fullName, contractorId: e.contractorId,
      assigned: e.assigned, saved: e.record ? toSavedDTO(e.record, project.timezone) : null,
    }));
  const otherShift = entries
    .filter((e) => e.record && e.record.shift !== shift)
    .map((e) => ({ workerId: e.worker.id, workerName: e.worker.fullName, employeeCode: e.worker.employeeCode, workerCode: e.worker.code, status: e.record!.status }));

  let editable = true;
  let readOnlyReason: string | null = null;
  if (!canEditDate(ctx, project, date, policies)) {
    editable = false;
    readOnlyReason = closedReason(date, today, closesAt, project.timezone);
  } else if (!project.isActive) {
    editable = ctx.actor.role === "admin";
    readOnlyReason = editable ? null : "This plant is inactive.";
  }

  const day = policyForShift(withoutIds(policies.day), shift);
  return {
    projects: projectList,
    project: { id: project.id, name: project.name, location: project.location, timezone: project.timezone },
    policy: {
      day,
      capture: {
        inFutureToleranceMin: policies.capture.inFutureToleranceMin,
        outFutureToleranceMin: policies.capture.outFutureToleranceMin,
        operatorBackdateDays: policies.capture.operatorBackdateDays,
        editCutoffTime: policies.capture.editCutoffTime,
      },
      operatorEditClosesAt: closesAt.toISOString(),
      operatorWindowClosed: ctx.now.getTime() >= closesAt.getTime(),
      token: policies.token,
    },
    contractors: contractorList,
    contractorId,
    date,
    shift,
    today,
    nowTime: nowTimeIn(project.timezone, ctx.now),
    editable,
    readOnlyReason,
    rows,
    otherShift,
  };
}

export interface SaveResult {
  saved: number;
  rows: { workerId: string; saved: SavedEntryDTO | null }[];
}

/**
 * Saves a batch for one site, contractor and date. Individual taps and bulk actions
 * arrive here the same way and every item goes through the same evaluateEntry().
 */
export async function saveAttendance(ctx: ServiceContext, raw: unknown): Promise<SaveResult> {
  const input = attendanceBatch.parse(raw);
  const project = await assertProjectAccess(ctx, input.projectId);
  const isAdmin = ctx.actor.role === "admin";
  if (!project.isActive && !isAdmin) throw forbidden("This plant is inactive");

  const policies = await sitePolicies(ctx, project, input.workDate);
  if (input.workDate > policies.today) throw invalid("Attendance cannot be recorded for a future date");
  if (!canEditDate(ctx, project, input.workDate, policies)) {
    throw forbidden(closedReason(input.workDate, policies.today, operatorEditClosesAt(policies.capture, input.workDate, project.timezone), project.timezone).replace(/\.$/, ""));
  }
  if (input.policyToken && input.policyToken !== policies.token) {
    throw staleSettings("Attendance settings for this plant changed while you were editing. Reload to see them; your unsaved changes stay on this device.");
  }

  const [workers, assignments, records] = await Promise.all([
    ctx.store.listWorkers(),
    ctx.store.listWorkerAssignments(),
    ctx.store.listAttendance({ projectIds: [project.id], from: input.workDate, to: input.workDate }),
  ]);
  const entries = registerEntries({
    projectId: project.id, contractorId: input.contractorId, date: input.workDate, workers, assignments, records,
  });
  const byWorker = new Map(entries.map((e) => [e.worker.id, e]));
  const entryCtx = { workDate: input.workDate, timezone: project.timezone, dayPolicy: policyForShift(policies.day, input.shift), capturePolicy: policies.capture, now: ctx.now };

  const writes: AttendanceWrite[] = [];
  for (const item of input.items) {
    const entry = byWorker.get(item.workerId);
    if (!entry) throw forbidden("A worker in this save is not on this plant's register for that date");
    const name = entry.worker.fullName;
    const rec = entry.record;
    if ((rec?.version ?? null) !== item.expectedVersion) {
      throw conflict(`${name}'s attendance was changed by someone else. Reload to see the latest entries.`);
    }
    if (item.status === "pending" && !rec) continue; // nothing recorded, nothing to reset
    if (rec && rec.shift !== input.shift) {
      throw invalid(`${name} is recorded on the ${rec.shift} shift for this date. Open the ${rec.shift} shift to change it.`);
    }

    const verdict = evaluateEntry(entryCtx, item, rec);
    if (!verdict.ok) throw invalid(`${name}: ${verdict.error}`);
    if (rec && rec.status === item.status && rec.checkInAt === verdict.checkInAt && rec.checkOutAt === verdict.checkOutAt) continue;
    writes.push({
      workerId: item.workerId, contractorId: entry.contractorId, status: item.status, checkInAt: verdict.checkInAt,
      checkOutAt: verdict.checkOutAt, checkInSource: verdict.checkInSource, shift: input.shift, method: item.method, expectedVersion: item.expectedVersion,
    });
  }

  if (writes.length === 0) return { saved: 0, rows: [] };
  const saved = await ctx.store.saveAttendance(project.id, input.workDate, writes, ctx.actor);
  return { saved: saved.length, rows: saved.map((r) => ({ workerId: r.workerId, saved: toSavedDTO(r, project.timezone) })) };
}

export interface DaySummary {
  date: string;
  projectId: string;
  projectName: string;
  contractorId: string;
  contractorName: string;
  total: number;
  present: number;
  absent: number;
  pending: number;
  outMissing: number;
}

/** Daily attendance counts (no payment data) for the sites the user can access. */
export async function dailySummaries(ctx: ServiceContext, q: { days: number; projectId?: string | null }): Promise<DaySummary[]> {
  const projects = await accessibleProjects(ctx);
  const ids = await accessibleProjectIds(ctx);
  const selected = projects.filter((p) => !q.projectId || p.id === q.projectId);
  if (selected.length === 0) return [];
  // Each site counts its own last N days, ending at its own local today.
  const todayByProject = Object.fromEntries(selected.map((p) => [p.id, todayIn(p.timezone, ctx.now)]));
  const todays = Object.values(todayByProject).sort();
  const from = addDays(todays[0], -(q.days - 1));
  const to = todays[todays.length - 1];
  const projectIds = selected.map((p) => p.id);
  const [contractors, workers, assignments, records] = await Promise.all([
    ctx.store.listContractors(),
    ctx.store.listWorkers(),
    ctx.store.listWorkerAssignments(),
    ctx.store.listAttendance({ projectIds: ids === null ? projectIds : projectIds.filter((p) => ids.includes(p)), from, to }),
  ]);
  const report = buildReport({
    from, to, projects: selected, contractors, workers,
    assignments: assignments.filter((a) => projectIds.includes(a.projectId)),
    records, rules: [], todayByProject,
  });
  const map = new Map<string, DaySummary>();
  for (const row of report.rows) {
    if (row.workDate < addDays(todayByProject[row.projectId], -(q.days - 1))) continue;
    const key = `${row.workDate}:${row.projectId}:${row.contractorId}`;
    let s = map.get(key);
    if (!s) {
      s = { date: row.workDate, projectId: row.projectId, projectName: row.projectName, contractorId: row.contractorId, contractorName: row.contractorName, total: 0, present: 0, absent: 0, pending: 0, outMissing: 0 };
      map.set(key, s);
    }
    s.total++;
    if (row.status === "present") {
      s.present++;
      if (row.calc.incomplete) s.outMissing++;
    } else if (row.status === "absent") s.absent++;
    else s.pending++;
  }
  return [...map.values()].sort(
    (a, b) => b.date.localeCompare(a.date) || a.projectName.localeCompare(b.projectName) || a.contractorName.localeCompare(b.contractorName),
  );
}
