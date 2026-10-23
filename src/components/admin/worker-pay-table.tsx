"use client";

import { useMemo, useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import { StatusPill } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RATE_BASIS_LABEL } from "@/lib/domain/master-import";
import type { RateBasis } from "@/lib/domain/types";
import { changeWorkerPayTermsAction } from "@/lib/server/actions/admin";
import { cn } from "@/lib/utils";
import { Field, selectClass, useServerAction } from "./form-bits";

export interface PayRow {
  id: string;
  fullName: string;
  employeeCode: string | null;
  code: string;
  terms: { rateAmount: number | null; rateBasis: RateBasis; commissionEligible: boolean | null; effectiveFrom: string; version: number } | null;
}

const inr = (n: number | null) => (n === null ? "—" : `₹${n.toLocaleString("en-IN")}`);
const BASES: RateBasis[] = ["unconfirmed", "daily", "monthly", "hourly"];

type Bulk = { kind: "basis" } | { kind: "commission"; eligible: boolean } | { kind: "edit"; row: PayRow } | null;

/**
 * Each worker's own rate, its basis and commission eligibility. Every change is
 * a new dated version, so earlier months keep the terms they were paid under.
 */
export function WorkerPayTable({
  rows,
  showRates,
  selectedCommission,
  today,
}: {
  rows: PayRow[];
  /** the rule pays each worker's own rate */
  showRates: boolean;
  /** the rule's commission applies to selected workers only */
  selectedCommission: boolean;
  today: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Bulk>(null);
  const unconfirmed = rows.filter((r) => (r.terms?.rateBasis ?? "unconfirmed") === "unconfirmed").length;
  const eligible = rows.filter((r) => r.terms?.commissionEligible === true).length;
  const chosen = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);

  if (rows.length === 0) return null;
  return (
    <section className="space-y-3" data-testid="worker-pay">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Worker rates{selectedCommission ? " and commission" : ""}</h2>
          <p className="text-sm text-muted-foreground">
            {rows.length} active workers
            {showRates && unconfirmed > 0 && <span className="text-pending"> · {unconfirmed} with rate basis requiring verification</span>}
            {selectedCommission && ` · ${eligible} selected for commission`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {showRates && (
            <Button size="sm" variant="outline" disabled={chosen.length === 0} onClick={() => setDialog({ kind: "basis" })} data-testid="bulk-basis">
              Set rate basis
            </Button>
          )}
          {selectedCommission && (
            <>
              <Button size="sm" variant="outline" disabled={chosen.length === 0} onClick={() => setDialog({ kind: "commission", eligible: true })} data-testid="bulk-commission-on">
                Include in commission
              </Button>
              <Button size="sm" variant="outline" disabled={chosen.length === 0} onClick={() => setDialog({ kind: "commission", eligible: false })}>
                Exclude
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl bg-card shadow-surface">
        <table className="w-full min-w-[34rem] text-sm">
          <thead className="border-b text-left text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  aria-label="Select all workers"
                  checked={chosen.length === rows.length}
                  onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                />
              </th>
              <th className="px-3 py-2.5">Worker</th>
              {showRates && <th className="px-3 py-2.5 text-right">Rate</th>}
              {showRates && <th className="px-3 py-2.5">Basis</th>}
              {selectedCommission && <th className="px-3 py-2.5">Commission</th>}
              <th className="px-3 py-2.5">Since</th>
              <th className="w-10 px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => {
              const basis = r.terms?.rateBasis ?? "unconfirmed";
              return (
                <tr key={r.id} className={cn(selected.has(r.id) && "bg-primary-soft/40")}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      aria-label={`Select ${r.fullName}`}
                      checked={selected.has(r.id)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(r.id);
                          else n.delete(r.id);
                          return n;
                        })
                      }
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.fullName}</div>
                    <div className="font-mono text-xs whitespace-pre text-muted-foreground">{r.employeeCode ?? r.code}</div>
                  </td>
                  {showRates && <td className="tabular px-3 py-2 text-right">{inr(r.terms?.rateAmount ?? null)}</td>}
                  {showRates && (
                    <td className="px-3 py-2">{basis === "unconfirmed" ? <StatusPill tone="pending">{RATE_BASIS_LABEL[basis]}</StatusPill> : RATE_BASIS_LABEL[basis]}</td>
                  )}
                  {selectedCommission && (
                    <td className="px-3 py-2">{r.terms?.commissionEligible ? <StatusPill tone="present">Selected</StatusPill> : <span className="text-muted-foreground">Not selected</span>}</td>
                  )}
                  <td className="px-3 py-2 text-muted-foreground">{r.terms ? `${r.terms.effectiveFrom} · v${r.terms.version}` : "—"}</td>
                  <td className="px-2 py-2">
                    <Button size="icon-sm" variant="ghost" aria-label={`Change pay terms for ${r.fullName}`} onClick={() => setDialog({ kind: "edit", row: r })}>
                      <Pencil />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {dialog && (
        <PayTermsDialog
          dialog={dialog}
          workers={dialog.kind === "edit" ? [dialog.row] : chosen}
          showRates={showRates}
          selectedCommission={selectedCommission}
          today={today}
          onClose={(done) => {
            setDialog(null);
            if (done) setSelected(new Set());
          }}
        />
      )}
    </section>
  );
}

function PayTermsDialog({
  dialog,
  workers,
  showRates,
  selectedCommission,
  today,
  onClose,
}: {
  dialog: NonNullable<Bulk>;
  workers: PayRow[];
  showRates: boolean;
  selectedCommission: boolean;
  today: string;
  onClose: (done: boolean) => void;
}) {
  const { pending, run } = useServerAction();
  const one = dialog.kind === "edit" ? dialog.row : null;
  const latestFrom = workers.map((w) => w.terms?.effectiveFrom ?? "").sort().at(-1) ?? "";
  const [from, setFrom] = useState(latestFrom > today ? latestFrom : today);
  const [basis, setBasis] = useState<RateBasis>(one?.terms?.rateBasis ?? "unconfirmed");
  const [amount, setAmount] = useState(one?.terms?.rateAmount === null || one?.terms?.rateAmount === undefined ? "" : String(one.terms.rateAmount));
  const [eligible, setEligible] = useState(one?.terms?.commissionEligible === true);
  const [note, setNote] = useState("");

  const payload = () => {
    const base = { workerIds: workers.map((w) => w.id), effectiveFrom: from, notes: note };
    if (dialog.kind === "basis") return { ...base, rateBasis: basis };
    if (dialog.kind === "commission") return { ...base, commissionEligible: dialog.eligible };
    return {
      ...base,
      ...(showRates ? { rateAmount: amount, rateBasis: basis } : {}),
      ...(selectedCommission ? { commissionEligible: eligible } : {}),
    };
  };
  const title =
    dialog.kind === "basis"
      ? `Rate basis for ${workers.length} ${workers.length === 1 ? "worker" : "workers"}`
      : dialog.kind === "commission"
        ? `${dialog.eligible ? "Include" : "Exclude"} ${workers.length} ${workers.length === 1 ? "worker" : "workers"} ${dialog.eligible ? "in" : "from"} commission`
        : `Pay terms · ${one!.fullName}`;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Saved as a new version from the date below. Earlier dates keep the terms in force then.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {(dialog.kind === "basis" || (dialog.kind === "edit" && showRates)) && (
            <Field label="Rate basis" htmlFor="pt-basis" hint="Choose only what has been confirmed with the contractor. Amounts are not changed.">
              <select id="pt-basis" className={selectClass} value={basis} onChange={(e) => setBasis(e.target.value as RateBasis)}>
                {BASES.map((b) => (
                  <option key={b} value={b}>
                    {RATE_BASIS_LABEL[b]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {dialog.kind === "edit" && showRates && (
            <Field label="Rate amount (₹)" htmlFor="pt-amount">
              <Input id="pt-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          )}
          {dialog.kind === "edit" && selectedCommission && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4.5 accent-primary" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
              Selected for contractor commission
            </label>
          )}
          <Field label="From" htmlFor="pt-from">
            <Input id="pt-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Note (optional)" htmlFor="pt-note">
            <Input id="pt-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. confirmed with the contractor on…" />
          </Field>
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() => run(() => changeWorkerPayTermsAction(payload()), { success: (n) => `Saved for ${n} ${n === 1 ? "worker" : "workers"}`, onSuccess: () => onClose(true) })}
            data-testid="save-pay-terms"
          >
            {pending && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
