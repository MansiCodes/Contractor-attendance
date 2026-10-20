import { conflict, forbidden, invalid } from "@/lib/errors";
import { assignmentCovers, registerEntries } from "@/lib/domain/register";
import { buildReport } from "@/lib/domain/report";
import { attendanceBatch } from "@/lib/domain/schemas";
import { addDays, instantToLocal, isValidDate, nowTimeIn, resolveShift, todayIn } from "@/lib/domain/time";
import type { AttendanceStatus, ChangeMethod, Project } from "@/lib/domain/types";
import type { AttendanceWrite } from "../store/types";
import { accessibleProjectIds, accessibleProjects, assertProjectAccess, type ServiceContext } from "./context";

/** An OUT time may not be recorded ahead of the clock (small allowance for clock skew). */
const OUT_FUTURE_TOLERANCE_MIN = 5;
/** IN may be confirmed slightly ahead of the shift start, but not hours in advance. */
const IN_FUTURE_TOLERANCE_MIN = 60;

export interface SavedEntryDTO {
  recordId: string;
  status: AttendanceStatus;
  checkIn: string | null;
  checkOut: string | null;
  checkOutNextDay: boolean;
  version: number;
  method: ChangeMethod;
}

export interface RegisterRowDTO {
  workerId: string;
  workerCode: string;
  workerName: string;
  contractorId: string;
  assigned: boolean;
  saved: SavedEntryDTO | null;
}

export interface RegisterView {
  projects: { id: string; name: string; location: string }[];
  project: Pick<Project, "id" | "name" | "location" | "timezone" | "defaultCheckIn" | "allowOvernight" | "operatorBackdateDays"> | null;
  contractors: { id: string; name: string; photoUrl: string | null; workerCount: number }[];
  contractorId: string | null;
  date: string;
  today: string;
  nowTime: string;
  /** earliest date the current user may edit */
  minEditableDate: string;
  editable: boolean;
  readOnlyReason: string | null;
  rows: RegisterRowDTO[];
}

function editWindow(ctx: ServiceContext, project: Project) {
  const today = todayIn(project.timezone, ctx.now);
  const minEditableDate = ctx.actor.role === "admin" ? "2000-01-01" : addDays(today, -project.operatorBackdateDays);
  return { today, minEditableDate };
}

export async function loadRegister(
  ctx: ServiceContext,
  query: { projectId?: string | null; contractorId?: string | null; date?: string | null },
): Promise<RegisterView> {
  const projects = await accessibleProjects(ctx);
  const visible = ctx.actor.role === "admin" ? projects : projects.filter((p) => p.isActive);
  const project = visible.find((p) => p.id === query.projectId) ?? visible.find((p) => p.isActive) ?? visible[0] ?? null;
  const projectList = visible.map((p) => ({ id: p.id, name: p.name, location: p.location }));

  if (!project) {
    const today = todayIn("Asia/Kolkata", ctx.now);
    return {
      projects: projectList, project: null, contractors: [], contractorId: null, date: today, today,
      nowTime: nowTimeIn("Asia/Kolkata", ctx.now), minEditableDate: today, editable: false,
      readOnlyReason: "No project sites are assigned to you yet. Please contact NF head office.", rows: [],
    };
  }

  const { today, minEditableDate } = editWindow(ctx, project);
  let date = query.date && isValidDate(query.date) ? query.date : today;
  if (date > today) date = today;

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

  const rows: RegisterRowDTO[] = entries.map((e) => {
    const r = e.record;
    let saved: SavedEntryDTO | null = null;
    if (r) {
      const inL = r.checkInAt ? instantToLocal(r.checkInAt, project.timezone) : null;
      const outL = r.checkOutAt ? instantToLocal(r.checkOutAt, project.timezone) : null;
      saved = {
        recordId: r.id, status: r.status, checkIn: inL?.time ?? null, checkOut: outL?.time ?? null,
        checkOutNextDay: !!outL && outL.date > date, version: r.version, method: r.method,
      };
    }
    return { workerId: e.worker.id, workerCode: e.worker.code, workerName: e.worker.fullName, contractorId: e.contractorId, assigned: e.assigned, saved };
  });

  let editable = true;
  let readOnlyReason: string | null = null;
  if (date < minEditableDate) {
    editable = false;
    readOnlyReason = "Past dates can only be corrected by NF head office.";
  } else if (!project.isActive) {
    editable = ctx.actor.role === "admin";
    readOnlyReason = editable ? null : "This project site is inactive.";
  }

  return {
    projects: projectList,
    project: {
      id: project.id, name: project.name, location: project.location, timezone: project.timezone,
      defaultCheckIn: project.defaultCheckIn, allowOvernight: project.allowOvernight, operatorBackdateDays: project.operatorBackdateDays,
    },
    contractors: contractorList,
    contractorId,
    date,
    today,
    nowTime: nowTimeIn(project.timezone, ctx.now),
    minEditableDate,
    editable,
    readOnlyReason,
    rows,
  };
}

export interface SaveResult {
  saved: number;
  rows: { workerId: string; saved: SavedEntryDTO | null }[];
}

export async function saveAttendance(ctx: ServiceContext, raw: unknown): Promise<SaveResult> {
  const input = attendanceBatch.parse(raw);
  const project = await assertProjectAccess(ctx, input.projectId);
  const isAdmin = ctx.actor.role === "admin";
  if (!project.isActive && !isAdmin) throw forbidden("This project site is inactive");

  const { today, minEditableDate } = editWindow(ctx, project);
  if (input.workDate > today) throw invalid("Attendance cannot be recorded for a future date");
  if (input.workDate < minEditableDate) throw forbidden("Past dates can only be corrected by NF head office");

  const [workers, assignments, records] = await Promise.all([
    ctx.store.listWorkers(),
    ctx.store.listWorkerAssignments(),
    ctx.store.listAttendance({ projectIds: [project.id], from: input.workDate, to: input.workDate }),
  ]);
  const entries = registerEntries({
    projectId: project.id, contractorId: input.contractorId, date: input.workDate, workers, assignments, records,
  });
  const byWorker = new Map(entries.map((e) => [e.worker.id, e]));
  const nowMs = ctx.now.getTime();

  const writes: AttendanceWrite[] = [];
  for (const item of input.items) {
    const entry = byWorker.get(item.workerId);
    if (!entry) throw forbidden("A worker in this save is not on this site's register for that date");
    const name = entry.worker.fullName;
    const rec = entry.record;
    if ((rec?.version ?? null) !== item.expectedVersion) {
      throw conflict(`${name}'s attendance was changed by someone else. Reload to see the latest entries.`);
    }

    let checkInAt: string | null = null;
    let checkOutAt: string | null = null;
    if (item.status === "pending") {
      if (!rec) continue; // nothing recorded, nothing to reset
    } else if (item.status === "present") {
      if (!item.checkIn) throw invalid(`${name}: IN time is required to mark present`);
      const shift = resolveShift(input.workDate, item.checkIn, item.checkOut, project.timezone, project.allowOvernight);
      if (!shift.ok) throw invalid(`${name}: ${shift.error}`);
      if (new Date(shift.checkInAt).getTime() > nowMs + IN_FUTURE_TOLERANCE_MIN * 60000) {
        throw invalid(`${name}: IN time is in the future`);
      }
      if (shift.checkOutAt && new Date(shift.checkOutAt).getTime() > nowMs + OUT_FUTURE_TOLERANCE_MIN * 60000) {
        throw invalid(`${name}: OUT time cannot be in the future`);
      }
      checkInAt = shift.checkInAt;
      checkOutAt = shift.checkOutAt;
    }

    if (rec && rec.status === item.status && rec.checkInAt === checkInAt && rec.checkOutAt === checkOutAt) continue;
    writes.push({
      workerId: item.workerId, contractorId: entry.contractorId, status: item.status, checkInAt, checkOutAt,
      method: item.method, expectedVersion: item.expectedVersion,
    });
  }

  if (writes.length === 0) return { saved: 0, rows: [] };
  const saved = await ctx.store.saveAttendance(project.id, input.workDate, writes, ctx.actor);
  return {
    saved: saved.length,
    rows: saved.map((r) => {
      const inL = r.checkInAt ? instantToLocal(r.checkInAt, project.timezone) : null;
      const outL = r.checkOutAt ? instantToLocal(r.checkOutAt, project.timezone) : null;
      return {
        workerId: r.workerId,
        saved: {
          recordId: r.id, status: r.status, checkIn: inL?.time ?? null, checkOut: outL?.time ?? null,
          checkOutNextDay: !!outL && outL.date > input.workDate, version: r.version, method: r.method,
        },
      };
    }),
  };
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
  const today = todayIn(selected[0].timezone, ctx.now);
  const from = addDays(today, -(q.days - 1));
  const projectIds = selected.map((p) => p.id);
  const [contractors, workers, assignments, records] = await Promise.all([
    ctx.store.listContractors(),
    ctx.store.listWorkers(),
    ctx.store.listWorkerAssignments(),
    ctx.store.listAttendance({ projectIds: ids === null ? projectIds : projectIds.filter((p) => ids.includes(p)), from, to: today }),
  ]);
  const report = buildReport({
    from, to: today, projects: selected, contractors, workers,
    assignments: assignments.filter((a) => projectIds.includes(a.projectId)),
    records, rules: [],
    todayByProject: Object.fromEntries(selected.map((p) => [p.id, todayIn(p.timezone, ctx.now)])),
  });
  const map = new Map<string, DaySummary>();
  for (const row of report.rows) {
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
