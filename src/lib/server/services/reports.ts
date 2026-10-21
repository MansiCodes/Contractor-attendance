import { invalid } from "@/lib/errors";
import { assignmentCovers } from "@/lib/domain/register";
import { buildReport, payableLabel, type Report } from "@/lib/domain/report";
import { reportFilter } from "@/lib/domain/schemas";
import { addDays, monthRange, todayIn } from "@/lib/domain/time";
import type { AuditLog } from "@/lib/domain/types";
import { assertAdmin, headOfficeToday, type ServiceContext } from "./context";

const MAX_RANGE_DAYS = 366;

/** Company-wide attendance and payable report. Admin only. */
export async function getReport(ctx: ServiceContext, raw: unknown): Promise<Report> {
  assertAdmin(ctx);
  const f = reportFilter.parse(raw);
  if (f.from > f.to) throw invalid("'From' date must be before 'To' date");
  if (addDays(f.from, MAX_RANGE_DAYS) < f.to) throw invalid("Please choose a range of one year or less");

  const [projects, contractors, workers, assignments, records, rules, policies] = await Promise.all([
    ctx.store.listProjects(),
    ctx.store.listContractors(),
    ctx.store.listWorkers(),
    ctx.store.listWorkerAssignments(),
    ctx.store.listAttendance({
      projectIds: f.projectId ? [f.projectId] : undefined,
      contractorId: f.contractorId ?? null,
      from: f.from,
      to: f.to,
    }),
    ctx.store.listPaymentRules(),
    ctx.store.listAttendancePolicies(),
  ]);
  return buildReport({
    from: f.from,
    to: f.to,
    projectId: f.projectId ?? null,
    contractorId: f.contractorId ?? null,
    projects,
    contractors,
    workers,
    assignments,
    records,
    rules,
    todayByProject: Object.fromEntries(projects.map((p) => [p.id, todayIn(p.timezone, ctx.now)])),
    policies,
    now: ctx.now,
  });
}

export interface OverviewData {
  today: string;
  month: { from: string; to: string };
  cards: {
    activeSites: number;
    contractors: number;
    activeWorkers: number;
    presentToday: number;
    absentToday: number;
    pendingToday: number;
    outMissingToday: number;
  };
  attention: {
    projectId: string;
    projectName: string;
    contractorId: string;
    contractorName: string;
    total: number;
    pending: number;
    outMissing: number;
  }[];
  contractorRows: {
    contractorId: string;
    name: string;
    location: string;
    sites: number;
    workers: number;
    presentToday: number;
    monthWorkerDays: number;
    payable: string;
  }[];
}

export async function getOverview(ctx: ServiceContext, monthOf?: string | null): Promise<OverviewData> {
  assertAdmin(ctx);
  const today = await headOfficeToday(ctx);
  const month = monthRange(monthOf && monthOf <= today ? monthOf : today);
  const [projects, contractors, workers, assignments, cpas, records, rules] = await Promise.all([
    ctx.store.listProjects(),
    ctx.store.listContractors(),
    ctx.store.listWorkers(),
    ctx.store.listWorkerAssignments(),
    ctx.store.listContractorProjects(),
    ctx.store.listAttendance({ from: month.from < addDays(today, -1) ? month.from : addDays(today, -1), to: today > month.to ? today : month.to }),
    ctx.store.listPaymentRules(),
  ]);
  const activeProjects = projects.filter((p) => p.isActive);
  const todayByProject = Object.fromEntries(projects.map((p) => [p.id, todayIn(p.timezone, ctx.now)]));
  const base = { projects: activeProjects, contractors, workers, assignments, records, rules, todayByProject };

  // "Today" uses each site's own local date.
  const todayReport = buildReport({ ...base, from: addDays(today, -1), to: addDays(today, 1) });
  const todayRows = todayReport.rows.filter((r) => r.workDate === todayByProject[r.projectId]);
  const monthReport = buildReport({ ...base, from: month.from, to: month.to });

  const attentionMap = new Map<string, OverviewData["attention"][number]>();
  const presentByContractor = new Map<string, number>();
  const cards = { presentToday: 0, absentToday: 0, pendingToday: 0, outMissingToday: 0 };
  for (const r of todayRows) {
    const key = `${r.projectId}:${r.contractorId}`;
    let a = attentionMap.get(key);
    if (!a) {
      a = { projectId: r.projectId, projectName: r.projectName, contractorId: r.contractorId, contractorName: r.contractorName, total: 0, pending: 0, outMissing: 0 };
      attentionMap.set(key, a);
    }
    a.total++;
    if (r.status === "present") {
      cards.presentToday++;
      presentByContractor.set(r.contractorId, (presentByContractor.get(r.contractorId) ?? 0) + 1);
      if (r.calc.incomplete) {
        cards.outMissingToday++;
        a.outMissing++;
      }
    } else if (r.status === "absent") cards.absentToday++;
    else {
      cards.pendingToday++;
      a.pending++;
    }
  }

  const activeWorkerIds = new Set(
    assignments
      .filter((a) => assignmentCovers(a, todayByProject[a.projectId] ?? today) && activeProjects.some((p) => p.id === a.projectId))
      .map((a) => a.workerId),
  );
  const ruleContractors = new Set(rules.map((r) => r.contractorId));

  const contractorRows = contractors
    .filter((c) => c.isActive)
    .map((c) => {
      const sites = new Set(
        cpas.filter((a) => a.contractorId === c.id && assignmentCovers(a, today) && activeProjects.some((p) => p.id === a.projectId)).map((a) => a.projectId),
      );
      const workerCount = workers.filter((w) => w.contractorId === c.id && activeWorkerIds.has(w.id)).length;
      const group = monthReport.byContractor.find((g) => g.contractorId === c.id);
      const totals = group?.totals ?? { amount: 0, pricedDays: 0, unconfiguredDays: 0, presentDays: 0 };
      return {
        contractorId: c.id,
        name: c.name,
        location: c.location,
        sites: sites.size,
        workers: workerCount,
        presentToday: presentByContractor.get(c.id) ?? 0,
        monthWorkerDays: totals.presentDays,
        payable: payableLabel(totals, ruleContractors.has(c.id)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    today,
    month,
    cards: {
      activeSites: activeProjects.length,
      contractors: contractors.filter((c) => c.isActive).length,
      activeWorkers: activeWorkerIds.size,
      ...cards,
    },
    attention: [...attentionMap.values()]
      .filter((a) => a.pending > 0 || a.outMissing > 0)
      .sort((a, b) => b.pending - a.pending || a.projectName.localeCompare(b.projectName)),
    contractorRows,
  };
}

export interface AuditEntryDTO extends AuditLog {
  workerName: string;
  workerCode: string;
  projectName: string;
  changedByName: string;
}

export async function getAuditLog(
  ctx: ServiceContext,
  q: { projectId?: string | null; from?: string; to?: string; workerId?: string; limit?: number },
): Promise<AuditEntryDTO[]> {
  assertAdmin(ctx);
  const [logs, workers, projects, profiles] = await Promise.all([
    ctx.store.listAuditLogs({
      projectIds: q.projectId ? [q.projectId] : undefined,
      from: q.from,
      to: q.to,
      workerId: q.workerId,
      limit: Math.min(q.limit ?? 200, 1000),
    }),
    ctx.store.listWorkers(),
    ctx.store.listProjects(),
    ctx.store.listProfiles(),
  ]);
  const w = new Map(workers.map((x) => [x.id, x]));
  const p = new Map(projects.map((x) => [x.id, x]));
  const u = new Map(profiles.map((x) => [x.id, x]));
  return logs.map((l) => ({
    ...l,
    workerName: w.get(l.workerId)?.fullName ?? "Unknown worker",
    workerCode: w.get(l.workerId)?.code ?? "",
    projectName: p.get(l.projectId)?.name ?? "Unknown project",
    changedByName: l.changedBy ? u.get(l.changedBy)?.fullName ?? "Unknown user" : "System",
  }));
}
