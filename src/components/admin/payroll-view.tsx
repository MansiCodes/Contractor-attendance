import { Fragment } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { EmptyState, StatusPill } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { payrollComplete, type ContractorPayroll, type Payroll, type PayrollFigures } from "@/lib/domain/payroll";
import { formatINR } from "@/lib/domain/report";
import { cn } from "@/lib/utils";

// Contractor-wise monthly payroll estimate, with a drill-down to each worker.
// An amount is shown only when every day behind it could be priced; otherwise
// the cell says "Needs configuration" and the flags say what is missing.

const th = "px-3 py-2.5 text-2xs font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase";
const td = "px-3 py-2.5";
const n2 = (n: number) => (n === 0 ? "0" : n.toFixed(2));
const money = (n: number | null) => (n === null ? <span className="text-pending italic">Needs configuration</span> : formatINR(n));

const TREATMENT: Record<string, string> = {
  added_to_contractor_payable: "added on top of wages",
  deducted_from_wages: "taken from wages",
};

function Flags({ f }: { f: PayrollFigures }) {
  const items = [
    f.missing.length > 0 ? `Needs configuration: ${f.missing.join(", ")}` : null,
    f.missingCheckoutDays > 0 ? `${f.missingCheckoutDays} day(s) without OUT are not counted` : null,
    f.pendingDays > 0 ? `${f.pendingDays} pending day(s) are not counted` : null,
  ].filter((x): x is string => !!x);
  if (items.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-xs text-pending">
      {items.map((i) => (
        <li key={i} className="flex gap-1">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {i}
        </li>
      ))}
    </ul>
  );
}

function Totals({ f, label }: { f: PayrollFigures; label: string }) {
  const complete = payrollComplete(f);
  return (
    <section className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-xl bg-card shadow-surface sm:grid-cols-4 sm:divide-y-0" aria-label={label} data-testid="payroll-totals">
      {(
        [
          ["Confirmed hours", n2(f.confirmedHours)],
          ["OT hours (paid)", n2(f.overtimeHours)],
          ["Commission", f.commission === null ? "—" : formatINR(f.commission)],
          ["Estimated total", f.totalPayable === null ? "Needs configuration" : formatINR(f.totalPayable)],
        ] as const
      ).map(([k, v]) => (
        <div key={k} className="px-4 py-3">
          <div className="text-xs font-medium text-muted-foreground">{k}</div>
          <div className={cn("tabular mt-1 text-lg font-semibold", v === "Needs configuration" && "text-base text-pending")}>{v}</div>
        </div>
      ))}
      {!complete && (
        <div className="col-span-2 border-t px-4 py-2.5 sm:col-span-4">
          <Flags f={f} />
        </div>
      )}
    </section>
  );
}

function MonthNav({ month, contractorId }: { month: string; contractorId: string | null }) {
  const [y, m] = month.split("-").map(Number);
  const shift = (d: number) => {
    const date = new Date(Date.UTC(y, m - 1 + d, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const href = (mm: string) => `/admin/attendance?${new URLSearchParams({ tab: "payroll", month: mm, ...(contractorId ? { contractor: contractorId } : {}) })}`;
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <div className="flex items-center gap-1">
      <Link href={href(shift(-1))} className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted" aria-label="Previous month">
        <ChevronLeft className="size-4" />
      </Link>
      <span className="min-w-36 text-center text-md font-semibold" data-testid="payroll-month">
        {label}
      </span>
      <Link href={href(shift(1))} className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted" aria-label="Next month">
        <ChevronRight className="size-4" />
      </Link>
    </div>
  );
}

export function PayrollView({ payroll, month, contractor }: { payroll: Payroll; month: string; contractor: ContractorPayroll | null | "all" }) {
  const contractorId = contractor && contractor !== "all" ? contractor.contractorId : null;
  const exportHref = `/api/export/payroll?${new URLSearchParams({ month, ...(contractorId ? { contractor: contractorId } : {}) })}`;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {contractorId && (
            <Link href={`/admin/attendance?tab=payroll&month=${month}`} className="inline-flex h-9 items-center gap-1 rounded-lg pr-2 text-sm font-medium text-muted-foreground hover:bg-muted">
              <ChevronLeft className="size-4" /> All contractors
            </Link>
          )}
          <MonthNav month={month} contractorId={contractorId} />
        </div>
        <Button asChild className="w-full sm:w-auto">
          <a href={exportHref} data-testid="export-payroll">
            <Download className="size-4" /> Export payroll (Excel)
          </a>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Estimates from confirmed attendance and each contractor&apos;s payment rule. Pending days and days without an OUT time are never counted. Nothing here is a
        disbursed amount.
      </p>

      {contractor === null || (contractor === "all" && payroll.contractors.length === 0) ? (
        <EmptyState title="No attendance in this month" description="Choose another month." />
      ) : contractor === "all" ? (
        <>
          <Totals f={payroll.totals} label="Totals for all contractors" />
          <div className="overflow-x-auto rounded-xl bg-card shadow-surface">
            <table className="w-full min-w-[56rem] text-sm" data-testid="payroll-table">
              <thead>
                <tr className="border-b text-left">
                  <th className={th}>Contractor</th>
                  <th className={cn(th, "text-right")}>Workers</th>
                  <th className={cn(th, "text-right")}>Confirmed hrs</th>
                  <th className={cn(th, "text-right")}>Standard units</th>
                  <th className={cn(th, "text-right")}>OT hrs</th>
                  <th className={cn(th, "text-right")}>Base wages</th>
                  <th className={cn(th, "text-right")}>OT wages</th>
                  <th className={cn(th, "text-right")}>Commission</th>
                  <th className={cn(th, "text-right")}>Est. total payable</th>
                </tr>
              </thead>
              <tbody className="tabular divide-y align-top">
                {payroll.contractors.map((c) => (
                  <Fragment key={c.contractorId}>
                  <tr className={cn("hover:bg-muted/40", !payrollComplete(c) && "border-b-0")}>
                    <td className={cn(td, "whitespace-nowrap")}>
                      <Link href={`/admin/attendance?tab=payroll&month=${month}&contractor=${c.contractorId}`} className="font-medium text-primary hover:underline">
                        {c.contractorName}
                      </Link>
                    </td>
                    <td className={cn(td, "text-right")}>{c.workers}</td>
                    <td className={cn(td, "text-right")}>{n2(c.confirmedHours)}</td>
                    <td className={cn(td, "text-right whitespace-nowrap")}>
                      {[c.standardDays ? `${n2(c.standardDays)} days` : null, c.standardHours ? `${n2(c.standardHours)} hrs` : null].filter(Boolean).join(" + ") || "0"}
                    </td>
                    <td className={cn(td, "text-right")}>{n2(c.overtimeHours)}</td>
                    <td className={cn(td, "text-right whitespace-nowrap")}>{money(c.baseWages)}</td>
                    <td className={cn(td, "text-right whitespace-nowrap")}>{money(c.overtimeWages)}</td>
                    <td className={cn(td, "text-right whitespace-nowrap")}>
                      {money(c.commission)}
                      {c.commission !== null && c.commission > 0 && c.commissionTreatment && <div className="text-xs text-muted-foreground">{TREATMENT[c.commissionTreatment]}</div>}
                    </td>
                    <td className={cn(td, "text-right font-semibold whitespace-nowrap")}>
                      {money(c.totalPayable)}
                      {!payrollComplete(c) && c.totalPayable !== null && (
                        <div>
                          <StatusPill tone="pending">Incomplete</StatusPill>
                        </div>
                      )}
                    </td>
                  </tr>
                  {!payrollComplete(c) && (
                    <tr>
                      <td colSpan={9} className="px-3 pt-0 pb-2.5">
                        <Flags f={c} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div>
            <h2 className="text-title font-semibold">{contractor.contractorName}</h2>
            <p className="text-sm text-muted-foreground">
              {contractor.workers} workers
              {contractor.commissionTreatment && ` · commission ${TREATMENT[contractor.commissionTreatment]}`}
            </p>
          </div>
          <Totals f={contractor} label={`Totals for ${contractor.contractorName}`} />
          <div className="overflow-x-auto rounded-xl bg-card shadow-surface">
            <table className="w-full min-w-[58rem] text-sm" data-testid="payroll-workers">
              <thead>
                <tr className="border-b text-left">
                  <th className={th}>Worker</th>
                  <th className={th}>Rate</th>
                  <th className={cn(th, "text-right")}>Present</th>
                  <th className={cn(th, "text-right")}>Hours</th>
                  <th className={cn(th, "text-right")}>Units</th>
                  <th className={cn(th, "text-right")}>OT hrs</th>
                  <th className={cn(th, "text-right")}>Base</th>
                  <th className={cn(th, "text-right")}>OT</th>
                  <th className={cn(th, "text-right")}>Commission</th>
                  <th className={cn(th, "text-right")}>Est. payable</th>
                </tr>
              </thead>
              <tbody className="tabular divide-y align-top">
                {contractor.workerRows.map((w) => (
                  <Fragment key={w.workerId}>
                  <tr className={cn(!payrollComplete(w) && "border-b-0")}>
                    <td className={cn(td, "whitespace-nowrap")}>
                      <div className="font-medium">{w.workerName}</div>
                      <div className="font-mono text-xs whitespace-pre text-muted-foreground">{w.employeeCode ?? w.workerCode}</div>
                    </td>
                    <td className={cn(td, "whitespace-nowrap")}>
                      {w.rateLabel}
                      {w.ruleVersions.length > 0 && <div className="text-xs text-muted-foreground">rule v{w.ruleVersions.join(", v")}</div>}
                    </td>
                    <td className={cn(td, "text-right")}>
                      {w.presentDays}
                      {w.missingCheckoutDays > 0 && <div className="text-xs text-pending">{w.missingCheckoutDays} no OUT</div>}
                    </td>
                    <td className={cn(td, "text-right")}>{n2(w.confirmedHours)}</td>
                    <td className={cn(td, "text-right whitespace-nowrap")}>
                      {[w.standardDays ? `${n2(w.standardDays)} d` : null, w.standardHours ? `${n2(w.standardHours)} h` : null].filter(Boolean).join(" + ") || "0"}
                    </td>
                    <td className={cn(td, "text-right")}>{n2(w.overtimeHours)}</td>
                    <td className={cn(td, "text-right whitespace-nowrap")}>{money(w.baseWages)}</td>
                    <td className={cn(td, "text-right whitespace-nowrap")}>{money(w.overtimeWages)}</td>
                    <td className={cn(td, "text-right whitespace-nowrap")}>{w.commissionApplies ? money(w.commission) : <span className="text-muted-foreground">Not applicable</span>}</td>
                    <td className={cn(td, "text-right font-semibold whitespace-nowrap")}>{money(w.totalPayable)}</td>
                  </tr>
                  {!payrollComplete(w) && (
                    <tr>
                      <td colSpan={10} className="px-3 pt-0 pb-2.5">
                        <Flags f={w} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
