"use client";

import { useMemo, useState } from "react";
import { Factory, Search, SearchX, Users } from "lucide-react";
import { EmptyState, StatusPill } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { formatDateShort } from "@/lib/domain/time";
import { cn } from "@/lib/utils";
import { selectClass } from "./form-bits";
import { AssignPlantDialog, WorkerActions, type DeploymentOptions, type WorkerSummary } from "./worker-dialogs";

type Row = WorkerSummary & { contractorName: string; projectName: string | null };
export type DirectoryView = "all" | "unassigned";

const GRID = "md:grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] md:items-center md:gap-4";

const isUnassigned = (w: Row) => w.isActive && !w.currentProjectId;

/** Searchable list of every worker, with the same row actions used on contractor and plant pages. */
export function WorkerDirectory({
  workers,
  contractors,
  options,
  initialView = "all",
}: {
  workers: Row[];
  contractors: { id: string; name: string }[];
  options: DeploymentOptions;
  initialView?: DirectoryView;
}) {
  const [query, setQuery] = useState("");
  const [contractorId, setContractorId] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [view, setView] = useState<DirectoryView>(initialView);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);

  const inactiveCount = workers.filter((w) => !w.isActive).length;
  const unassignedCount = workers.filter(isUnassigned).length;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workers.filter(
      (w) =>
        (view === "unassigned" ? isUnassigned(w) : showInactive || w.isActive) &&
        (!contractorId || w.contractorId === contractorId) &&
        (!q ||
          w.fullName.toLowerCase().includes(q) ||
          w.code.toLowerCase().includes(q) ||
          (w.employeeCode ?? "").toLowerCase().includes(q) ||
          (w.phone ?? "").includes(q) ||
          (w.department ?? "").toLowerCase().includes(q) ||
          (w.designation ?? "").toLowerCase().includes(q) ||
          (w.projectName ?? "").toLowerCase().includes(q)),
    );
  }, [workers, query, contractorId, showInactive, view]);

  const selectable = view === "unassigned";
  const visibleSelected = visible.filter((w) => selected.has(w.id));
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="space-y-3">
      <div className="inline-flex gap-1 rounded-xl bg-muted p-1" role="tablist" aria-label="Worker views">
        {(
          [
            ["all", "All workers", workers.filter((w) => w.isActive).length],
            ["unassigned", "Unassigned", unassignedCount],
          ] as const
        ).map(([v, label, count]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => {
              setView(v);
              setSelected(new Set());
            }}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors",
              view === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
            data-testid={`view-${v}`}
          >
            {label}
            <span className={cn("tabular rounded-full px-1.5 text-xs", v === "unassigned" && count > 0 ? "bg-pending-soft text-pending" : "bg-muted-foreground/10")}>{count}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, employee ID, department or plant"
            aria-label="Search workers"
            className="h-11 w-full rounded-lg border border-input bg-card pr-3 pl-9 text-base outline-none placeholder:text-subtle-foreground focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/25 md:h-10 md:text-sm"
          />
        </div>
        <select value={contractorId} onChange={(e) => setContractorId(e.target.value)} aria-label="Filter by contractor" className={cn(selectClass, "sm:w-60 md:h-10 md:text-sm")}>
          <option value="">All contractors</option>
          {contractors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
        <span className="tabular">
          {visible.length} {visible.length === 1 ? "worker" : "workers"}
        </span>
        {selectable && visible.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 font-medium text-foreground">
              <input
                type="checkbox"
                className="size-4.5 accent-primary"
                checked={visibleSelected.length === visible.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((w) => w.id)) : new Set())}
                data-testid="select-all-unassigned"
              />
              Select all shown
            </label>
            <Button size="sm" disabled={visibleSelected.length === 0} onClick={() => setAssigning(true)} data-testid="assign-plant">
              <Factory /> Assign {visibleSelected.length || ""} to plant
            </Button>
          </div>
        )}
        {!selectable && inactiveCount > 0 && (
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => setShowInactive(!showInactive)}>
            {showInactive ? "Hide" : "Show"} {inactiveCount} inactive
          </button>
        )}
      </div>

      {workers.length === 0 ? (
        <EmptyState icon={Users} title="No workers yet" description="Add the first worker, or import the contractor master from Excel." />
      ) : visible.length === 0 ? (
        view === "unassigned" && !query && !contractorId ? (
          <EmptyState icon={Factory} title="Every active worker has a plant" description="Imported workers appear here until they are assigned to a plant." />
        ) : (
          <EmptyState
            icon={SearchX}
            title="No workers match"
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setContractorId("");
                }}
              >
                Clear filters
              </Button>
            }
          />
        )
      ) : (
        <div className="overflow-hidden rounded-xl bg-card shadow-surface">
          <div aria-hidden className={cn(GRID, "hidden border-b px-4 py-2.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase")}>
            <span>Worker</span>
            <span>Contractor</span>
            <span>Current plant</span>
            <span className="w-10" />
          </div>
          <ul className="divide-y">
            {visible.map((w) => (
              <li key={w.id} className={cn(GRID, "flex items-center gap-3 py-2.5 pr-2 pl-4")} data-testid="worker-row">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {selectable && (
                    <input
                      type="checkbox"
                      className="size-4.5 shrink-0 accent-primary"
                      checked={selected.has(w.id)}
                      onChange={(e) => toggle(w.id, e.target.checked)}
                      aria-label={`Select ${w.fullName}`}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className={cn("flex items-center gap-2 text-md font-medium", !w.isActive && "text-muted-foreground")}>
                      <span className="truncate">{w.fullName}</span>
                      {!w.isActive && <StatusPill tone="neutral">Inactive</StatusPill>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {w.employeeCode ? <span className="font-mono whitespace-pre text-foreground/80">{w.employeeCode}</span> : w.code}
                      {[w.department, w.designation].filter(Boolean).length > 0 && ` · ${[w.department, w.designation].filter(Boolean).join(" · ")}`}
                      <span className="md:hidden">
                        {" · "}
                        {w.contractorName}
                        {" · "}
                        {w.projectName ?? (w.isActive ? "Unassigned" : "—")}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="hidden min-w-0 truncate text-sm md:block">{w.contractorName}</div>
                <div className="hidden min-w-0 md:block">
                  <div className="truncate text-sm">
                    {w.projectName ?? (w.isActive ? <StatusPill tone="pending">Unassigned</StatusPill> : <span className="text-muted-foreground">—</span>)}
                  </div>
                  {w.currentSince && <div className="text-xs text-muted-foreground">since {formatDateShort(w.currentSince)}</div>}
                </div>
                <WorkerActions worker={w} options={options} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {assigning && (
        <AssignPlantDialog
          workers={visibleSelected}
          options={options}
          onClose={(done) => {
            setAssigning(false);
            if (done) setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}
