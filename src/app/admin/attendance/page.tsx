import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Download, History } from "lucide-react";
import { AttendanceRegister } from "@/components/attendance/register";
import { EmptyState, Group, SegmentedLinks, StatusPill, type Tone } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { loadRegister } from "@/lib/server/services/attendance";
import { getAuditLog, getReport } from "@/lib/server/services/reports";
import { requirePageContext } from "@/lib/server/session";
import { formatINR, payableLabel, type ReportGroup, type ReportRow } from "@/lib/domain/report";
import { addDays, formatDateShort, formatMinutes, formatTime12, instantToLocal, isValidDate, monthRange } from "@/lib/domain/time";
import { headOfficeTimezone, headOfficeToday } from "@/lib/server/services/context";
import type { AttendanceSnapshot } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Attendance" };

type Search = Promise<Record<string, string | undefined>>;

const TABS = [
  { key: "register", label: "Register" },
  { key: "report", label: "Reports" },
  { key: "log", label: "Change log" },
] as const;

export default async function AdminAttendancePage({ searchParams }: { searchParams: Search }) {
  const ctx = await requirePageContext("admin");
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "register";

  return (
    <div className="space-y-5">
      <SegmentedLinks label="Attendance views" items={TABS.map((t) => ({ href: `/admin/attendance?tab=${t.key}`, label: t.label, active: tab === t.key }))} />
      {tab === "register" && <RegisterTab sp={sp} ctx={ctx} />}
      {tab === "report" && <ReportTab sp={sp} ctx={ctx} />}
      {tab === "log" && <LogTab sp={sp} ctx={ctx} />}
    </div>
  );
}

type Ctx = Awaited<ReturnType<typeof requirePageContext>>;

async function RegisterTab({ sp, ctx }: { sp: Record<string, string | undefined>; ctx: Ctx }) {
  const view = await loadRegister(ctx, { projectId: sp.project, contractorId: sp.contractor, date: sp.date });
  return (
    <AttendanceRegister
      key={`${view.project?.id}:${view.contractorId}:${view.date}`}
      view={view}
      basePath="/admin/attendance"
      extraQuery={{ tab: "register" }}
      allowDateChange
      heading="Attendance register"
    />
  );
}

const hours = (h: number) => h.toFixed(2);
const units = (g: ReportGroup) =>
  [g.totals.payableDays ? `${g.totals.payableDays} days` : null, g.totals.payableHours ? `${g.totals.payableHours} hrs` : null].filter(Boolean).join(" + ") || "—";

const th = "px-4 py-2.5 text-2xs font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase";
const td = "px-4 py-2.5";

function GroupTable({ groups, withProject }: { groups: ReportGroup[]; withProject: boolean }) {
  if (groups.length === 0) return <EmptyState title="No attendance in this period" description="Try a wider date range or a different filter." />;
  return (
    <>
      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-xl bg-card shadow-surface md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className={th}>Contractor</th>
              {withProject ? <th className={th}>Project</th> : <th className={cn(th, "text-right")}>Sites</th>}
              <th className={cn(th, "text-right")}>Workers</th>
              <th className={cn(th, "text-right")}>Present</th>
              <th className={cn(th, "text-right")}>Absent</th>
              <th className={cn(th, "text-right")}>Pending</th>
              <th className={cn(th, "text-right")}>No OUT</th>
              <th className={cn(th, "text-right")}>Hours</th>
              <th className={cn(th, "text-right")}>Payable units</th>
              <th className={cn(th, "text-right")}>Est. payable</th>
            </tr>
          </thead>
          <tbody className="tabular divide-y">
            {groups.map((g) => (
              <tr key={g.key} className="transition-colors hover:bg-muted/50">
                <td className={cn(td, "font-medium whitespace-nowrap")}>{g.contractorName}</td>
                {withProject ? <td className={cn(td, "max-w-56 truncate")}>{g.projectName}</td> : <td className={cn(td, "text-right")}>{g.sites}</td>}
                <td className={cn(td, "text-right")}>{g.totals.workers}</td>
                <td className={cn(td, "text-right")}>{g.totals.presentDays}</td>
                <td className={cn(td, "text-right whitespace-nowrap")}>
                  {g.totals.absentDays}
                  {g.totals.notMarkedAbsentDays > 0 && <span className="text-xs text-absent"> +{g.totals.notMarkedAbsentDays} not marked</span>}
                </td>
                <td className={cn(td, "text-right", g.totals.pendingDays > 0 && "font-semibold text-pending")}>{g.totals.pendingDays}</td>
                <td className={cn(td, "text-right")}>{g.totals.incompleteDays}</td>
                <td className={cn(td, "text-right")}>{hours(g.totals.netHours)}</td>
                <td className={cn(td, "text-right whitespace-nowrap")}>{units(g)}</td>
                <td className={cn(td, "text-right font-medium whitespace-nowrap")}>{payableLabel(g.totals, g.ruleConfigured)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: stacked, readable */}
      <Group as="ul" className="md:hidden">
        {groups.map((g) => {
          const label = payableLabel(g.totals, g.ruleConfigured);
          return (
            <li key={g.key} className="space-y-2 px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-md font-semibold">{g.contractorName}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {withProject ? g.projectName : `${g.sites} ${g.sites === 1 ? "site" : "sites"}`} · {g.totals.workers} workers
                  </div>
                </div>
                <span className={cn("tabular shrink-0 text-sm font-semibold", label === "Not configured" && "font-normal text-muted-foreground italic")}>{label}</span>
              </div>
              <dl className="tabular grid grid-cols-4 gap-2 text-center">
                {(
                  [
                    ["Present", g.totals.presentDays, "text-present"],
                    [
                      "Absent",
                      g.totals.notMarkedAbsentDays > 0 ? `${g.totals.absentDays}+${g.totals.notMarkedAbsentDays}` : g.totals.absentDays,
                      "text-absent",
                    ],
                    ["Pending", g.totals.pendingDays, g.totals.pendingDays > 0 ? "text-pending" : ""],
                    ["Hours", hours(g.totals.netHours), ""],
                  ] as const
                ).map(([k, v, tone]) => (
                  <div key={k} className="rounded-lg bg-muted/70 py-1.5">
                    <dd className={cn("text-sm font-semibold", tone)}>{v}</dd>
                    <dt className="text-2xs text-muted-foreground">{k}</dt>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
      </Group>
    </>
  );
}

const STATUS_TONE: Record<ReportRow["status"], Tone> = { present: "present", absent: "absent", pending: "pending" };
const STATUS_LABEL: Record<ReportRow["status"], string> = { present: "Present", absent: "Absent", pending: "Pending" };

/** Attendance-policy labels for a row (display only; they never change pay). */
function rowNotes(r: ReportRow): string[] {
  const l = r.labels;
  return [
    r.checkInSource === "suggested" ? "IN as suggested" : null,
    l.lateMinutes !== null ? `Late ${formatMinutes(l.lateMinutes)}` : null,
    l.halfDay ? "Half day" : null,
    l.overtimeMinutes !== null ? `OT ${formatMinutes(l.overtimeMinutes)}` : null,
  ].filter((n): n is string => !!n);
}

function StatusCell({ r }: { r: ReportRow }) {
  const notes = rowNotes(r);
  return (
    <>
      {r.labels.notMarkedAbsent ? (
        <StatusPill tone="absent">Absent – not marked</StatusPill>
      ) : (
        <StatusPill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusPill>
      )}
      {notes.length > 0 && <div className="mt-0.5 text-xs text-pending">{notes.join(" · ")}</div>}
    </>
  );
}

function amountCell(r: ReportRow) {
  if (r.calc.amountState === "ok" && r.calc.amount !== null) return formatINR(r.calc.amount);
  if (r.calc.amountState === "not_configured") return <span className="text-muted-foreground italic">Not configured</span>;
  return "—";
}

async function ReportTab({ sp, ctx }: { sp: Record<string, string | undefined>; ctx: Ctx }) {
  const today = await headOfficeToday(ctx);
  const month = monthRange(today);
  const from = sp.from && isValidDate(sp.from) ? sp.from : month.from;
  const to = sp.to && isValidDate(sp.to) ? sp.to : month.to;
  const projectId = sp.project || null;
  const contractorId = sp.contractor || null;
  const [report, projects, contractors] = await Promise.all([
    getReport(ctx, { from, to, projectId, contractorId }),
    ctx.store.listProjects(),
    ctx.store.listContractors(),
  ]);
  const query = new URLSearchParams({ from, to, ...(projectId ? { project: projectId } : {}), ...(contractorId ? { contractor: contractorId } : {}) });
  const MAX_ROWS = 300;
  const t = report.totals;
  const prev = monthRange(addDays(month.from, -1));
  const presets = [
    { label: "This month", from: month.from, to: month.to },
    { label: "Last month", from: prev.from, to: prev.to },
    { label: "Last 7 days", from: addDays(today, -6), to: today },
  ];
  const presetHref = (p: { from: string; to: string }) =>
    `/admin/attendance?${new URLSearchParams({ tab: "report", from: p.from, to: p.to, ...(projectId ? { project: projectId } : {}), ...(contractorId ? { contractor: contractorId } : {}) })}`;
  const field = "h-11 w-full rounded-lg border border-input bg-card px-3 text-base outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/25 md:h-10 md:text-sm";
  const contractorName = contractors.find((c) => c.id === contractorId)?.name;

  return (
    <div className="space-y-6">
      {/* Filters + export: everything needed to produce the monthly sheet, in one place */}
      <section className="space-y-3 rounded-xl bg-card p-4 shadow-surface">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => {
              const active = p.from === from && p.to === to;
              return (
                <Link
                  key={p.label}
                  href={presetHref(p)}
                  className={cn(
                    "flex h-8 items-center rounded-full px-3 text-sm font-medium transition-colors",
                    active ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.label}
                </Link>
              );
            })}
          </div>
          <Button asChild size="lg" className="w-full sm:w-auto">
            <a href={`/api/export?${query.toString()}`} data-testid="export-xlsx">
              <Download className="size-4" /> Export Excel
            </a>
          </Button>
        </div>
        <form method="get" className="grid grid-cols-2 gap-2.5 md:grid-cols-[1fr_1fr_1.4fr_1.4fr_auto] md:items-end">
          <input type="hidden" name="tab" value="report" />
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            From
            <input type="date" name="from" defaultValue={from} className={field} />
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            To
            <input type="date" name="to" defaultValue={to} className={field} />
          </label>
          <label className="col-span-2 space-y-1 text-xs font-medium text-muted-foreground md:col-span-1">
            Project
            <select name="project" defaultValue={projectId ?? ""} className={cn(field, "select-native")}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 space-y-1 text-xs font-medium text-muted-foreground md:col-span-1">
            Contractor
            <select name="contractor" defaultValue={contractorId ?? ""} className={cn(field, "select-native")}>
              <option value="">All contractors</option>
              {contractors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary" className="col-span-2 h-11 md:col-span-1 md:h-10">
            Show report
          </Button>
        </form>
      </section>

      {/* Period summary (one line, so it reads the same as the exported sheet) */}
      <div className="space-y-1">
        <h2 className="text-base font-semibold tracking-tight">
          {formatDateShort(from)} – {formatDateShort(to)}
          {contractorName && <span className="font-normal text-muted-foreground"> · {contractorName}</span>}
        </h2>
        <p className="tabular text-sm text-muted-foreground">
          <strong className="font-semibold text-foreground">{t.workers}</strong> workers · <strong className="font-semibold text-present">{t.presentDays}</strong> present days ·{" "}
          <strong className="font-semibold text-absent">{t.absentDays}</strong> absent · <strong className={cn("font-semibold", t.pendingDays > 0 ? "text-pending" : "text-foreground")}>{t.pendingDays}</strong>{" "}
          pending{t.notMarkedAbsentDays > 0 && <> · <strong className="font-semibold text-absent">{t.notMarkedAbsentDays}</strong> absent – not marked</>} ·{" "}
          <strong className="font-semibold text-foreground">{hours(t.netHours)}</strong> hrs · Est. <strong className="font-semibold text-foreground">{formatINR(t.amount)}</strong>
          {t.unconfiguredDays > 0 && ` (+${t.unconfiguredDays} days not configured)`}
        </p>
      </div>

      <section className="space-y-2.5">
        <h3 className="text-sm font-semibold">By contractor</h3>
        <GroupTable groups={report.byContractor} withProject={false} />
      </section>
      <section className="space-y-2.5">
        <h3 className="text-sm font-semibold">By contractor and project</h3>
        <GroupTable groups={report.byContractorProject} withProject />
      </section>

      <section className="space-y-2.5">
        <h3 className="text-sm font-semibold">
          Daily records{" "}
          {report.rows.length > MAX_ROWS && (
            <span className="font-normal text-muted-foreground">
              (first {MAX_ROWS} of {report.rows.length} — export for all)
            </span>
          )}
        </h3>
        {report.rows.length === 0 ? (
          <EmptyState title="No daily records" description="Nothing was recorded in this period." />
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-xl bg-card shadow-surface md:block">
              <table className="w-full text-sm" data-testid="report-rows">
                <thead>
                  <tr className="border-b text-left">
                    <th className={th}>Date</th>
                    <th className={th}>Worker</th>
                    <th className={th}>Contractor</th>
                    <th className={th}>Project</th>
                    <th className={th}>Status</th>
                    <th className={th}>IN</th>
                    <th className={th}>OUT</th>
                    <th className={cn(th, "text-right")}>Hours</th>
                    <th className={cn(th, "text-right")}>Units</th>
                    <th className={cn(th, "text-right")}>Est. amount</th>
                  </tr>
                </thead>
                <tbody className="tabular divide-y">
                  {report.rows.slice(0, MAX_ROWS).map((r) => (
                    <tr key={r.key} className="transition-colors hover:bg-muted/50">
                      <td className="px-4 py-2 whitespace-nowrap">
                        <Link className="font-medium text-primary hover:underline" href={`/admin/attendance?tab=register&project=${r.projectId}&contractor=${r.contractorId}&date=${r.workDate}`}>
                          {formatDateShort(r.workDate)}
                        </Link>
                      </td>
                      <td className="px-4 py-2">
                        <span className="font-medium">{r.workerName}</span> <span className="text-xs text-muted-foreground">{r.workerCode}</span>
                      </td>
                      <td className="max-w-44 truncate px-4 py-2">{r.contractorName}</td>
                      <td className="max-w-52 truncate px-4 py-2">{r.projectName}</td>
                      <td className="px-4 py-2">
                        <StatusCell r={r} />
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">{r.checkIn ? formatTime12(r.checkIn) : "—"}</td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {r.checkOut ? `${formatTime12(r.checkOut)}${r.checkOutNextDay ? " (+1)" : ""}` : r.status === "present" ? <span className="text-pending">Not recorded</span> : "—"}
                      </td>
                      <td className="px-4 py-2 text-right">{r.calc.netHours !== null ? hours(r.calc.netHours) : r.calc.incomplete ? "Incomplete" : "—"}</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">{r.calc.payableUnits !== null ? `${r.calc.payableUnits} ${r.calc.unit === "hour" ? "h" : "d"}` : "—"}</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">{amountCell(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Group as="ul" className="md:hidden">
              {report.rows.slice(0, 60).map((r) => (
                <li key={r.key}>
                  <Link
                    href={`/admin/attendance?tab=register&project=${r.projectId}&contractor=${r.contractorId}&date=${r.workDate}`}
                    className="flex items-start gap-3 px-4 py-3 active:bg-muted"
                  >
                    <div className="tabular w-12 shrink-0 pt-0.5 text-xs font-semibold text-muted-foreground">{formatDateShort(r.workDate)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold">{r.workerName}</span>
                        <div className="text-right">
                          <StatusCell r={r} />
                        </div>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{r.contractorName}</div>
                      {r.status === "present" && (
                        <div className="tabular mt-1 flex flex-wrap gap-x-3 text-xs">
                          <span>IN {r.checkIn ? formatTime12(r.checkIn) : "—"}</span>
                          <span className={cn(!r.checkOut && "text-pending")}>
                            OUT {r.checkOut ? `${formatTime12(r.checkOut)}${r.checkOutNextDay ? " (+1)" : ""}` : "not recorded"}
                          </span>
                          {r.calc.netHours !== null && <span className="text-muted-foreground">{hours(r.calc.netHours)} h</span>}
                          <span className="ml-auto font-medium">{amountCell(r)}</span>
                        </div>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </Group>
            {report.rows.length > 60 && (
              <p className="text-xs text-muted-foreground md:hidden">Showing the first 60 records. Export Excel for the full list.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function snap(v: AttendanceSnapshot | null, tz: string) {
  if (!v) return "—";
  const t = (iso: string | null) => (iso ? formatTime12(instantToLocal(iso, tz).time) : "—");
  if (v.status === "present") return `Present · IN ${t(v.checkInAt)}${v.checkInSource === "suggested" ? " (suggested)" : ""} · OUT ${t(v.checkOutAt)}`;
  return v.status === "absent" ? "Absent" : "Pending";
}

async function LogTab({ sp, ctx }: { sp: Record<string, string | undefined>; ctx: Ctx }) {
  const [today, officeTz] = await Promise.all([headOfficeToday(ctx), headOfficeTimezone(ctx)]);
  const from = sp.from && isValidDate(sp.from) ? sp.from : addDays(today, -7);
  const to = sp.to && isValidDate(sp.to) ? sp.to : today;
  const projectId = sp.project || null;
  const [entries, projects] = await Promise.all([getAuditLog(ctx, { projectId, from, to, limit: 300 }), ctx.store.listProjects()]);
  const tzOf = new Map(projects.map((p) => [p.id, p.timezone]));
  const field = "h-11 w-full rounded-lg border border-input bg-card px-3 text-base outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/25 md:h-10 md:text-sm";

  return (
    <div className="space-y-5">
      <form method="get" className="grid grid-cols-2 gap-2.5 rounded-xl bg-card p-4 shadow-surface md:grid-cols-[1fr_1fr_1.6fr_auto] md:items-end">
        <input type="hidden" name="tab" value="log" />
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          Attendance date from
          <input type="date" name="from" defaultValue={from} className={field} />
        </label>
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          To
          <input type="date" name="to" defaultValue={to} className={field} />
        </label>
        <label className="col-span-2 space-y-1 text-xs font-medium text-muted-foreground md:col-span-1">
          Project
          <select name="project" defaultValue={projectId ?? ""} className={cn(field, "select-native")}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary" className="col-span-2 h-11 md:col-span-1 md:h-10">
          Show changes
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Every attendance entry and correction, newest first ({entries.length}
        {entries.length === 300 ? "+, narrow the dates to see more" : ""}). Entries cannot be edited or deleted.
      </p>
      {entries.length === 0 ? (
        <EmptyState icon={History} title="No changes in this period" />
      ) : (
        <Group as="ul" className="text-sm" data-testid="audit-log">
          {entries.map((e) => {
            const tz = tzOf.get(e.projectId) ?? officeTz;
            const at = instantToLocal(e.changedAt, tz);
            return (
              <li key={e.id} className="space-y-1.5 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="font-semibold">
                    {e.workerName} <span className="text-xs font-normal text-muted-foreground">{e.workerCode}</span>
                  </span>
                  <span className="tabular text-xs text-muted-foreground">
                    {formatDateShort(at.date)} {formatTime12(at.time)} · {e.changedByName} ({e.changedByRole === "admin" ? "Admin" : "Operator"})
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {e.projectName} · for {formatDateShort(e.workDate)}
                  </span>
                  <span className={cn("rounded-md px-1.5 py-0.5 text-2xs font-semibold", e.method === "bulk" ? "bg-pending-soft text-pending" : "bg-muted text-muted-foreground")}>
                    {e.method === "bulk" ? "Bulk confirmed" : "Individually entered"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-1.5 text-sm">
                  <span className="text-muted-foreground">{e.action === "create" ? "Recorded" : "Changed"}:</span>
                  {e.action !== "create" && (
                    <>
                      <span className="text-muted-foreground line-through decoration-muted-foreground/40">{snap(e.oldValues, tz)}</span>
                      <ArrowRight className="size-3.5 text-subtle-foreground" />
                    </>
                  )}
                  <span className="font-medium">{snap(e.newValues, tz)}</span>
                </div>
              </li>
            );
          })}
        </Group>
      )}
    </div>
  );
}
