"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Info, Loader2, RefreshCw, Upload, XCircle } from "lucide-react";
import { StatusPill } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RATE_BASIS_LABEL, type ImportIssue, type PlannedRow, type SheetChoice } from "@/lib/domain/master-import";
import type { RateBasis } from "@/lib/domain/types";
import { applyMasterImportAction, previewMasterImportAction } from "@/lib/server/actions/import";
import type { MasterImportPreview } from "@/lib/server/services/master-import";
import { cn } from "@/lib/utils";
import { Field, selectClass } from "./form-bits";

const NEW = "__new__";
const inr = (n: number | null) => (n === null ? "—" : `₹${n.toLocaleString("en-IN")}`);

function IssueIcon({ level }: { level: ImportIssue["level"] }) {
  if (level === "error") return <XCircle className="mt-0.5 size-4 shrink-0 text-absent" aria-label="Error" />;
  if (level === "warning") return <AlertTriangle className="mt-0.5 size-4 shrink-0 text-pending" aria-label="Warning" />;
  return <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Note" />;
}

function actionPill(r: PlannedRow) {
  switch (r.plan.kind) {
    case "create":
      return <StatusPill tone="present">New</StatusPill>;
    case "update":
      return <StatusPill tone={r.plan.approved ? "primary" : "pending"}>{r.plan.approved ? "Will update" : "Change found"}</StatusPill>;
    case "unchanged":
      return <StatusPill tone="neutral">Unchanged</StatusPill>;
    default:
      return <StatusPill tone="absent">Skipped</StatusPill>;
  }
}

/** Upload → preview → apply for the contractor worker master workbook. */
export function MasterImport() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<MasterImportPreview | null>(null);
  const [choices, setChoices] = useState<SheetChoice[]>([]);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [openSheet, setOpenSheet] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; updated: number } | null>(null);
  const [pending, start] = useTransition();

  const form = (opts: object) => {
    const fd = new FormData();
    fd.set("file", file!);
    fd.set("options", JSON.stringify(opts));
    return fd;
  };

  const runPreview = (opts: object) =>
    start(async () => {
      try {
        const res = await previewMasterImportAction(form(opts));
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setPreview(res.data);
        setChoices(res.data.choices);
        setDirty(false);
        setResult(null);
      } catch {
        toast.error("Could not reach the server. Check your connection and try again.");
      }
    });

  const apply = () =>
    start(async () => {
      try {
        const res = await applyMasterImportAction(form({ choices, approvedChanges: [...approved], fingerprint: preview!.plan.fingerprint }));
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(`Imported: ${res.data.created} new, ${res.data.updated} updated`);
        setResult({ created: res.data.created, updated: res.data.updated });
        setPreview(null);
        router.refresh();
      } catch {
        toast.error("Could not reach the server. Check your connection and try again.");
      }
    });

  const setChoice = (sheet: string, patch: Partial<SheetChoice>) => {
    setChoices((cs) => cs.map((c) => (c.sheet === sheet ? { ...c, ...patch } : c)));
    setDirty(true);
  };

  const updates = useMemo(() => preview?.plan.rows.filter((r) => r.plan.kind === "update") ?? [], [preview]);
  const toggleApproved = (key: string, on: boolean) => {
    setApproved((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
    setDirty(true);
  };

  const issuesBy = (level: ImportIssue["level"]) => preview?.issues.filter((i) => i.level === level) ?? [];
  const willWrite = preview ? preview.plan.totals.create + preview.plan.totals.updateApproved + preview.plan.sheets.filter((s) => s.include && s.contractor.create).length : 0;

  return (
    <div className="space-y-6">
      {/* 1. File */}
      <section className="rounded-xl bg-card p-4 shadow-surface sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
            <FileSpreadsheet className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-md font-semibold">Contractor worker master (.xlsx)</p>
            <p className="text-sm text-muted-foreground">
              One sheet per contractor with Emp ID, Employee Name, Department, Designation and rate. Nothing is saved until you review the preview and import.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            data-testid="master-file"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setResult(null);
              setApproved(new Set());
            }}
          />
          <Button variant="outline" onClick={() => fileInput.current?.click()} className="sm:w-auto">
            <Upload /> {file ? "Choose another file" : "Choose file"}
          </Button>
          <span className="min-w-0 truncate text-sm text-muted-foreground">{file ? file.name : "No file chosen"}</span>
          <Button className="sm:ml-auto" disabled={!file || pending} onClick={() => runPreview({})} data-testid="preview-import">
            {pending && !preview ? <Loader2 className="animate-spin" /> : null} Preview import
          </Button>
        </div>
      </section>

      {result && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-present/30 bg-present-soft p-4 text-sm" role="status">
          <CheckCircle2 className="size-5 text-present" />
          <span className="flex-1">
            Imported {result.created} new {result.created === 1 ? "worker" : "workers"}
            {result.updated > 0 && ` and updated ${result.updated}`}. New workers are <strong>Unassigned</strong> until you assign them to a plant.
          </span>
          <Link href="/admin/workers?view=unassigned" className="font-medium text-primary hover:underline">
            Assign plants →
          </Link>
        </div>
      )}

      {preview && (
        <>
          {preview.previousImports.length > 0 && (
            <div className="flex gap-2 rounded-xl border border-pending/30 bg-pending-soft p-3 text-sm" role="note">
              <Info className="mt-0.5 size-4 shrink-0 text-pending" />
              <span>
                This exact file was already imported{" "}
                {preview.previousImports
                  .map((p) => `on ${new Date(p.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}${p.by ? ` by ${p.by}` : ""}`)
                  .join("; ")}
                . Importing it again only adds what is new; existing workers are never duplicated.
              </span>
            </div>
          )}

          {/* 2. Summary */}
          <section aria-label="Import summary" className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-xl bg-card shadow-surface sm:grid-cols-5 sm:divide-y-0" data-testid="import-summary">
            {[
              ["Rows read", preview.plan.totals.rows],
              ["New workers", preview.plan.totals.create],
              ["Changes found", preview.plan.totals.update],
              ["Unchanged", preview.plan.totals.unchanged],
              ["Skipped", preview.plan.totals.skip],
            ].map(([l, v]) => (
              <div key={l} className="px-4 py-3">
                <div className="text-xs font-medium text-muted-foreground">{l}</div>
                <div className="tabular mt-1 text-xl font-semibold">{v}</div>
              </div>
            ))}
          </section>

          {/* 3. Sheets */}
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Contractors in this file</h2>
            {preview.sheets.map((s) => {
              const c = choices.find((x) => x.sheet === s.name)!;
              const planned = preview.plan.sheets.find((x) => x.sheet === s.name)!;
              const sheetRows = preview.plan.rows.filter((r) => r.sheet === s.name);
              return (
                <article key={s.name} className="rounded-xl bg-card shadow-surface" data-testid={`sheet-${s.name}`}>
                  <div className="flex flex-wrap items-start gap-3 border-b p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-md font-semibold">Sheet “{s.name}”</h3>
                        {s.identityMismatch && <StatusPill tone="pending">Identity needs review</StatusPill>}
                        {c.rateBasis === "unconfirmed" && <StatusPill tone="pending">Rate basis unconfirmed</StatusPill>}
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        Heading: {s.heading ?? "—"}
                        {s.period && ` · ${s.period}`} · {s.validRows} workers with IDs of {s.totalRows} rows
                      </p>
                    </div>
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <input type="checkbox" className="size-4.5 accent-primary" checked={c.include} onChange={(e) => setChoice(s.name, { include: e.target.checked })} />
                      Include
                    </label>
                  </div>

                  {c.include && (
                    <div className="grid gap-4 p-4 md:grid-cols-2">
                      <Field label="Contractor" htmlFor={`map-${s.name}`} hint={planned.contractor.create ? "A new contractor is created with this name." : "Workers are added to this existing contractor."}>
                        <select
                          id={`map-${s.name}`}
                          className={selectClass}
                          value={c.contractorId ?? NEW}
                          onChange={(e) => setChoice(s.name, { contractorId: e.target.value === NEW ? null : e.target.value })}
                        >
                          <option value={NEW}>Create new contractor…</option>
                          {preview.contractors.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                              {x.legalName && x.legalName !== x.name ? ` (${x.legalName})` : ""}
                            </option>
                          ))}
                        </select>
                      </Field>
                      {!c.contractorId && (
                        <Field label="New contractor name" htmlFor={`name-${s.name}`} hint={s.heading ? `Legal name recorded as “${s.heading}”.` : undefined}>
                          <Input id={`name-${s.name}`} value={c.newContractorName} onChange={(e) => setChoice(s.name, { newContractorName: e.target.value })} />
                        </Field>
                      )}

                      {s.identityMismatch && !c.contractorId && (
                        <div className="rounded-lg border border-pending/30 bg-pending-soft p-3 text-sm md:col-span-2">
                          <p>
                            The sheet is named <strong>{s.name}</strong> but headed <strong>{s.heading}</strong>. They are not merged or renamed automatically.
                          </p>
                          <label className="mt-2 flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-0.5 size-4.5 accent-primary"
                              checked={c.identityConfirmed}
                              onChange={(e) => setChoice(s.name, { identityConfirmed: e.target.checked })}
                            />
                            I have confirmed “{s.name}” and “{s.heading}” are the same contractor. (Leave unticked to import as “Needs review”.)
                          </label>
                        </div>
                      )}

                      <Field label="Rate basis" htmlFor={`basis-${s.name}`} hint="Amounts are stored exactly as in the sheet. The basis says how to read them.">
                        <select id={`basis-${s.name}`} className={selectClass} value={c.rateBasis} onChange={(e) => setChoice(s.name, { rateBasis: e.target.value as RateBasis })}>
                          {(["unconfirmed", "daily", "monthly", "hourly"] as RateBasis[]).map((b) => (
                            <option key={b} value={b}>
                              {RATE_BASIS_LABEL[b]}
                              {b === s.suggestedBasis ? " (suggested)" : ""}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Rates apply from" htmlFor={`from-${s.name}`} hint={s.period ? `The sheet is for ${s.period}.` : undefined}>
                        <Input id={`from-${s.name}`} type="date" value={c.effectiveFrom} onChange={(e) => setChoice(s.name, { effectiveFrom: e.target.value })} />
                      </Field>
                      {s.basisReasons.length > 0 && (
                        <ul className="space-y-1 text-xs text-muted-foreground md:col-span-2">
                          {s.basisReasons.map((r) => (
                            <li key={r}>• {r}</li>
                          ))}
                        </ul>
                      )}
                      {s.rules && (
                        <div className="rounded-lg bg-muted/60 p-3 text-sm md:col-span-2">
                          <p className="font-medium">From the Rules sheet: “{s.rules.label}”</p>
                          <ul className="mt-1 space-y-0.5 text-muted-foreground">
                            {s.rules.lines.map((l) => (
                              <li key={l}>{l}</li>
                            ))}
                          </ul>
                          <p className="mt-1.5 text-xs text-muted-foreground">Saved with the import and offered as suggestions when you set this contractor&apos;s payment rule. Nothing is applied automatically.</p>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-3 text-sm">
                    <span className="tabular">
                      <strong>{planned.counts.create}</strong> new
                    </span>
                    <span className="tabular">
                      <strong>{planned.counts.update}</strong> changed
                    </span>
                    <span className="tabular">
                      <strong>{planned.counts.unchanged}</strong> unchanged
                    </span>
                    <span className="tabular">
                      <strong>{planned.counts.skip}</strong> skipped
                    </span>
                    <button type="button" className="ml-auto font-medium text-primary hover:underline" onClick={() => setOpenSheet(openSheet === s.name ? null : s.name)}>
                      {openSheet === s.name ? "Hide rows" : "Show rows"}
                    </button>
                  </div>
                  {openSheet === s.name && (
                    <div className="max-h-[28rem] overflow-auto border-t">
                      <table className="w-full min-w-[40rem] text-sm">
                        <thead className="sticky top-0 bg-card text-left text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                          <tr>
                            <th className="px-3 py-2">Row</th>
                            <th className="px-3 py-2">Emp ID</th>
                            <th className="px-3 py-2">Name</th>
                            <th className="px-3 py-2">Department / designation</th>
                            <th className="px-3 py-2 text-right">{s.rateHeader ?? "Rate"}</th>
                            <th className="px-3 py-2">Result</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {sheetRows.map((r) => (
                            <tr key={r.key} className="align-top">
                              <td className="tabular px-3 py-2 text-muted-foreground">{r.row}</td>
                              <td className="px-3 py-2 font-mono text-xs whitespace-pre">{r.employeeCode ?? "—"}</td>
                              <td className="px-3 py-2">{r.fullName ?? "—"}</td>
                              <td className="px-3 py-2 text-muted-foreground">{[r.department, r.designation].filter(Boolean).join(" · ") || "—"}</td>
                              <td className="tabular px-3 py-2 text-right">{inr(r.rateAmount)}</td>
                              <td className="px-3 py-2">
                                {actionPill(r)}
                                {r.plan.kind === "skip" && <div className="mt-1 text-xs text-muted-foreground">{r.plan.reason}</div>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </article>
              );
            })}
          </section>

          {/* 4. Changes to existing workers */}
          {updates.length > 0 && (
            <section className="space-y-3" data-testid="import-changes">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold">Changes to existing workers</h2>
                  <p className="text-sm text-muted-foreground">Nothing is changed unless you tick it. A changed rate is saved as a new pay version; history is kept.</p>
                </div>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    className="size-4.5 accent-primary"
                    checked={updates.every((u) => approved.has(u.key))}
                    onChange={(e) => {
                      setApproved(e.target.checked ? new Set(updates.map((u) => u.key)) : new Set());
                      setDirty(true);
                    }}
                  />
                  Approve all
                </label>
              </div>
              <ul className="divide-y overflow-hidden rounded-xl bg-card shadow-surface">
                {updates.map((u) =>
                  u.plan.kind === "update" ? (
                    <li key={u.key} className="flex items-start gap-3 px-4 py-3 text-sm">
                      <input type="checkbox" className="mt-0.5 size-4.5 accent-primary" checked={approved.has(u.key)} onChange={(e) => toggleApproved(u.key, e.target.checked)} aria-label={`Approve change for ${u.employeeCode}`} />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">
                          {u.fullName} <span className="font-mono text-xs text-muted-foreground">{u.employeeCode}</span> <span className="text-xs text-muted-foreground">· {u.sheet} row {u.row}</span>
                        </div>
                        <ul className="mt-0.5 text-muted-foreground">
                          {u.plan.changes.map((ch) => (
                            <li key={ch.field}>
                              {ch.field === "rateAmount" ? "Rate" : ch.field === "rateBasis" ? "Rate basis" : ch.field === "fullName" ? "Name" : ch.field === "department" ? "Department" : "Designation"}:{" "}
                              <span className="line-through">{ch.field === "rateAmount" ? inr(ch.from as number | null) : ch.field === "rateBasis" && ch.from ? RATE_BASIS_LABEL[ch.from as RateBasis] : ch.from ?? "—"}</span> →{" "}
                              <strong>{ch.field === "rateAmount" ? inr(ch.to as number | null) : ch.field === "rateBasis" && ch.to ? RATE_BASIS_LABEL[ch.to as RateBasis] : ch.to ?? "—"}</strong>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </li>
                  ) : null,
                )}
              </ul>
            </section>
          )}

          {/* 5. Problems */}
          <section className="space-y-3" data-testid="import-issues">
            <h2 className="text-base font-semibold">What needs attention</h2>
            {preview.issues.length === 0 ? (
              <p className="rounded-xl bg-card p-4 text-sm text-muted-foreground shadow-surface">No problems found.</p>
            ) : (
              <ul className="divide-y overflow-hidden rounded-xl bg-card shadow-surface">
                {(["error", "warning", "info"] as const).flatMap((level) =>
                  issuesBy(level).map((i, n) => (
                    <li key={`${level}-${n}`} className="flex gap-2.5 px-4 py-2.5 text-sm">
                      <IssueIcon level={i.level} />
                      <span>
                        <span className="font-medium">{i.sheet}</span>
                        {i.row !== null && <span className="text-muted-foreground"> · row {i.row}</span>} — {i.message}
                      </span>
                    </li>
                  )),
                )}
              </ul>
            )}
            {preview.plan.notInFile.length > 0 && (
              <details className="rounded-xl bg-card p-4 text-sm shadow-surface">
                <summary className="cursor-pointer font-medium">{preview.plan.notInFile.length} active workers of these contractors are not in this file</summary>
                <p className="mt-1 text-muted-foreground">They are left exactly as they are. Deactivate them from the Workers page if they have left.</p>
                <ul className="mt-2 space-y-0.5">
                  {preview.plan.notInFile.map((w) => (
                    <li key={w.workerId}>
                      {w.fullName} <span className="font-mono text-xs text-muted-foreground">{w.employeeCode ?? w.workerCode}</span> · {w.contractorName}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          {/* 6. Apply */}
          <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-10 flex flex-wrap items-center gap-3 rounded-xl bg-card p-3 shadow-lg ring-1 ring-border">
            <p className={cn("min-w-0 flex-1 text-sm", dirty && "text-pending")}>
              {dirty
                ? "You changed the options. Update the preview to see the result before importing."
                : `${preview.plan.totals.create} new workers, ${preview.plan.totals.updateApproved} approved changes. Imported workers start Unassigned.`}
            </p>
            {dirty ? (
              <Button disabled={pending} onClick={() => runPreview({ choices, approvedChanges: [...approved] })} data-testid="refresh-preview">
                {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Update preview
              </Button>
            ) : (
              <Button disabled={pending || willWrite === 0} onClick={apply} data-testid="apply-import">
                {pending && <Loader2 className="animate-spin" />} Import {preview.plan.totals.create + preview.plan.totals.updateApproved} workers
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
