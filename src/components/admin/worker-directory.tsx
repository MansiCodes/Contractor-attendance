"use client";

import { useMemo, useState } from "react";
import { Search, SearchX, Users } from "lucide-react";
import { EmptyState, StatusPill } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { formatDateShort } from "@/lib/domain/time";
import { cn } from "@/lib/utils";
import { selectClass } from "./form-bits";
import { WorkerActions, type DeploymentOptions, type WorkerSummary } from "./worker-dialogs";

type Row = WorkerSummary & { contractorName: string; projectName: string | null };

const GRID = "md:grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] md:items-center md:gap-4";

/** Searchable list of every worker, with the same row actions used on contractor and project pages. */
export function WorkerDirectory({ workers, contractors, options }: { workers: Row[]; contractors: { id: string; name: string }[]; options: DeploymentOptions }) {
  const [query, setQuery] = useState("");
  const [contractorId, setContractorId] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const inactiveCount = workers.filter((w) => !w.isActive).length;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workers.filter(
      (w) =>
        (showInactive || w.isActive) &&
        (!contractorId || w.contractorId === contractorId) &&
        (!q || w.fullName.toLowerCase().includes(q) || w.code.toLowerCase().includes(q) || (w.phone ?? "").includes(q) || (w.projectName ?? "").toLowerCase().includes(q)),
    );
  }, [workers, query, contractorId, showInactive]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, ID, phone or site"
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

      <div className="flex items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
        <span className="tabular">
          {visible.length} {visible.length === 1 ? "worker" : "workers"}
        </span>
        {inactiveCount > 0 && (
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => setShowInactive(!showInactive)}>
            {showInactive ? "Hide" : "Show"} {inactiveCount} inactive
          </button>
        )}
      </div>

      {workers.length === 0 ? (
        <EmptyState icon={Users} title="No workers yet" description="Add the first worker and assign them to a contractor's site." />
      ) : visible.length === 0 ? (
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
      ) : (
        <div className="overflow-hidden rounded-xl bg-card shadow-surface">
          <div aria-hidden className={cn(GRID, "hidden border-b px-4 py-2.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase")}>
            <span>Worker</span>
            <span>Contractor</span>
            <span>Current site</span>
            <span className="w-10" />
          </div>
          <ul className="divide-y">
            {visible.map((w) => (
              <li key={w.id} className={cn(GRID, "flex items-center gap-3 py-2.5 pr-2 pl-4")}>
                <div className="min-w-0 flex-1">
                  <div className={cn("flex items-center gap-2 text-md font-medium", !w.isActive && "text-muted-foreground")}>
                    <span className="truncate">{w.fullName}</span>
                    {!w.isActive && <StatusPill tone="neutral">Inactive</StatusPill>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {w.code}
                    <span className="md:hidden">
                      {" · "}
                      {w.contractorName}
                      {w.projectName && ` · ${w.projectName}`}
                    </span>
                  </div>
                </div>
                <div className="hidden min-w-0 truncate text-sm md:block">{w.contractorName}</div>
                <div className="hidden min-w-0 md:block">
                  <div className="truncate text-sm">{w.projectName ?? <span className="text-muted-foreground">No current site</span>}</div>
                  {w.currentSince && <div className="text-xs text-muted-foreground">since {formatDateShort(w.currentSince)}</div>}
                </div>
                <WorkerActions worker={w} options={options} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
