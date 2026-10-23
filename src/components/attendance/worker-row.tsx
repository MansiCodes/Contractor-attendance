"use client";

import { memo } from "react";
import { Check, Plus, X } from "lucide-react";
import { StatusPill, type Tone } from "@/components/kit";
import type { DayLabels } from "@/lib/domain/policy";
import { formatMinutes, formatTime12 } from "@/lib/domain/time";
import type { AttendanceStatus, CheckInSource } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

export interface RowState {
  status: AttendanceStatus;
  checkIn: string | null;
  checkOut: string | null;
  checkOutNextDay: boolean;
  checkInSource: CheckInSource | null;
  dirty: boolean;
  bulk: boolean;
  workedMinutes: number | null;
  /** attendance-policy labels (display only) */
  labels: DayLabels;
}

export interface WorkerRowProps {
  workerId: string;
  name: string;
  code: string;
  state: RowState;
  /** the plant's suggested IN time, or null when the plant has none */
  suggestedIn: string | null;
  editable: boolean;
  /** register date is today (a missing OUT is expected, not yet overdue) */
  isToday: boolean;
  onPresent: (workerId: string) => void;
  onAbsent: (workerId: string) => void;
  onEditIn: (workerId: string) => void;
  onEditOut: (workerId: string) => void;
}

/** Grid shared by the desktop column header and every row, so columns line up. */
export const ROW_GRID =
  "grid grid-cols-[auto_auto_minmax(0,1fr)_auto] [grid-template-areas:'name_name_name_status'_'in_out_._mark'] gap-x-2 gap-y-2 md:grid-cols-[minmax(0,1fr)_8.5rem_6.5rem_6.5rem_5.75rem] md:[grid-template-areas:'name_status_in_out_mark'] md:gap-x-3 lg:grid-cols-[minmax(0,1fr)_9rem_7.5rem_7.5rem_13rem] lg:gap-x-4";

export function displayStatus(s: Pick<RowState, "status" | "checkOut" | "labels">, isToday: boolean): { label: string; tone: Tone } {
  if (s.status === "absent") return { label: "Absent", tone: "absent" };
  if (s.status === "pending") return s.labels.notMarkedAbsent ? { label: "Absent – not marked", tone: "absent" } : { label: "Pending", tone: "pending" };
  if (s.checkOut) return { label: "Completed", tone: "present" };
  return isToday ? { label: "Present", tone: "present" } : { label: "Checkout pending", tone: "pending" };
}

export const WorkerRow = memo(function WorkerRow(p: WorkerRowProps) {
  const s = p.state;
  const isPresent = s.status === "present";
  const isAbsent = s.status === "absent";
  const isPending = s.status === "pending";
  const status = displayStatus(s, p.isToday);
  const needsOut = isPresent && !s.checkOut;
  /** the plant's suggestion is only shown where it can still be confirmed */
  const suggested = isPending && p.editable && p.suggestedIn !== null;
  const needsIn = isPending && p.editable && p.suggestedIn === null;
  const notes = [
    s.labels.lateMinutes !== null ? `Late ${formatMinutes(s.labels.lateMinutes)}` : null,
    s.labels.halfDay ? "Half day" : null,
    s.labels.overtimeMinutes !== null ? `OT ${formatMinutes(s.labels.overtimeMinutes)}` : null,
  ].filter((n): n is string => !!n);

  return (
    <li
      data-testid="worker-row"
      data-worker={p.name}
      data-status={s.status}
      className={cn(
        ROW_GRID,
        "relative items-center px-4 py-2.5 transition-colors duration-200",
        s.dirty && "bg-pending-soft/45 before:absolute before:inset-y-0 before:left-0 before:w-0.75 before:bg-pending-dot",
      )}
    >
      {/* Name + one line of context */}
      <div className="flex min-w-0 items-baseline gap-2 [grid-area:name] md:block">
        <div className="truncate text-md leading-5 font-semibold">{p.name}</div>
        {/* Phones show the most useful item only; wider screens show all of it. */}
        <div className="min-w-0 truncate text-xs text-muted-foreground md:mt-0.5">
          <span className={cn((s.dirty || s.bulk) && "max-md:hidden")}>{p.code}</span>
          {s.bulk && !s.dirty && (
            <span>
              <span className="max-md:hidden"> · </span>Bulk confirmed
            </span>
          )}
          {notes.length > 0 && !s.dirty && (
            <span className="font-medium text-pending" data-testid="row-labels">
              <span className="max-md:hidden"> · </span>
              {notes.join(" · ")}
            </span>
          )}
          {s.dirty && (
            <span className="font-semibold text-pending">
              <span className="max-md:hidden"> · </span>Unsaved
            </span>
          )}
        </div>
      </div>

      <div className="justify-self-end [grid-area:status] md:justify-self-start">
        <StatusPill tone={status.tone} data-testid="row-status">
          {status.label}
        </StatusPill>
      </div>

      {/* IN */}
      <button
        type="button"
        data-testid="in-button"
        disabled={!p.editable || isAbsent}
        onClick={() => p.onEditIn(p.workerId)}
        aria-label={`Edit IN time for ${p.name}`}
        className={cn(
          "flex h-11 w-25 flex-col justify-center rounded-lg px-2.5 text-left transition-[background-color,border-color,transform] duration-150 [grid-area:in] active:scale-[0.97] disabled:active:scale-100 md:w-full",
          (suggested || needsIn) && "border border-dashed border-subtle-foreground/55 bg-card hover:border-foreground/50",
          isPending && !p.editable && "bg-muted/50 text-subtle-foreground",
          isPresent && "bg-muted enabled:hover:bg-border/70",
          isAbsent && "bg-muted/50 text-subtle-foreground",
        )}
      >
        <span className="truncate text-2xs leading-4 font-medium text-muted-foreground">
          IN
          {suggested && <span className="font-normal"> · suggested</span>}
          {isPresent && s.checkInSource === "suggested" && <span className="font-normal"> · as suggested</span>}
        </span>
        {needsIn ? (
          <span className="flex items-center gap-1 text-sm leading-5 font-semibold text-muted-foreground">
            <Plus className="size-3.5" strokeWidth={2.75} /> Set
          </span>
        ) : (
          <span className={cn("tabular text-md leading-5 font-semibold", isPending && "font-medium text-muted-foreground")}>
            {isAbsent || (isPending && !p.editable) || !(s.checkIn ?? p.suggestedIn) ? "—" : formatTime12((s.checkIn ?? p.suggestedIn)!)}
          </span>
        )}
      </button>

      {/* OUT */}
      <button
        type="button"
        data-testid="out-button"
        disabled={!p.editable || !isPresent}
        onClick={() => p.onEditOut(p.workerId)}
        aria-label={`Record OUT time for ${p.name}`}
        className={cn(
          "flex h-11 w-24 flex-col justify-center rounded-lg px-2.5 text-left transition-[background-color,border-color,transform] duration-150 [grid-area:out] active:scale-[0.97] disabled:active:scale-100 md:w-full",
          needsOut && p.editable && (p.isToday ? "border border-dashed border-primary/45 bg-primary-soft text-primary hover:border-primary" : "border border-dashed border-pending/50 bg-pending-soft text-pending"),
          needsOut && !p.editable && "bg-muted/50",
          isPresent && s.checkOut && "bg-muted enabled:hover:bg-border/70",
          !isPresent && "bg-muted/50 text-subtle-foreground",
        )}
      >
        <span className={cn("truncate text-2xs leading-4 font-medium", needsOut && p.editable ? "opacity-80" : "text-muted-foreground")}>
          OUT{s.workedMinutes !== null && <span className="font-normal"> · {formatMinutes(s.workedMinutes)}</span>}
        </span>
        {s.checkOut ? (
          <span className="tabular text-md leading-5 font-semibold whitespace-nowrap">
            {formatTime12(s.checkOut)}
            {s.checkOutNextDay && <sup className="ml-0.5 text-2xs font-semibold text-pending">+1</sup>}
          </span>
        ) : needsOut && p.editable ? (
          <span className="flex items-center gap-1 text-sm leading-5 font-semibold">
            <Plus className="size-3.5" strokeWidth={2.75} /> {p.isToday ? "Add" : "Missing"}
          </span>
        ) : (
          <span className="text-md leading-5 font-medium">—</span>
        )}
      </button>

      {/* Present / Absent — the paper register's P and A */}
      <div
        role="group"
        aria-label={`Attendance for ${p.name}`}
        className="flex justify-self-end overflow-hidden rounded-lg bg-card shadow-surface [grid-area:mark]"
      >
        <button
          type="button"
          data-testid="present-button"
          disabled={!p.editable}
          onClick={() => p.onPresent(p.workerId)}
          aria-pressed={isPresent}
          aria-label={`Mark ${p.name} present`}
          className={cn(
            "flex h-11 w-11 items-center justify-center gap-1.5 text-md font-bold transition-colors duration-150 disabled:opacity-50 lg:w-auto lg:px-3 lg:text-sm lg:font-semibold",
            isPresent ? "bg-present text-white" : "text-present enabled:hover:bg-present-soft enabled:active:bg-present-soft",
          )}
        >
          <span className="lg:hidden">P</span>
          <Check className="hidden size-4 lg:block" strokeWidth={2.75} />
          <span className="hidden lg:inline">Present</span>
        </button>
        <span aria-hidden className="w-px bg-border" />
        <button
          type="button"
          data-testid="absent-button"
          disabled={!p.editable}
          onClick={() => p.onAbsent(p.workerId)}
          aria-pressed={isAbsent}
          aria-label={`Mark ${p.name} absent`}
          className={cn(
            "flex h-11 w-11 items-center justify-center gap-1.5 text-md font-bold transition-colors duration-150 disabled:opacity-50 lg:w-auto lg:px-3 lg:text-sm lg:font-semibold",
            isAbsent ? "bg-absent text-white" : "text-absent enabled:hover:bg-absent-soft enabled:active:bg-absent-soft",
          )}
        >
          <span className="lg:hidden">A</span>
          <X className="hidden size-4 lg:block" strokeWidth={2.75} />
          <span className="hidden lg:inline">Absent</span>
        </button>
      </div>
    </li>
  );
});
