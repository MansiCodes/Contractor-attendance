"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Check, CheckCheck, ChevronLeft, ChevronRight, ChevronsUpDown, Clock, Info, Loader2, Lock, Search, SearchX, Users, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ContractorAvatar } from "@/components/contractor-avatar";
import { AttendanceBar, EmptyState } from "@/components/kit";
import { saveAttendanceAction } from "@/lib/server/actions/attendance";
import type { RegisterView, SavedEntryDTO } from "@/lib/server/services/attendance";
import { dayLabels, evaluateEntry, FALLBACK_POLICY, FALLBACK_TIMEZONE, NO_LABELS, type EntryInput, type PreviousEntry } from "@/lib/domain/policy";
import { addDays, formatDateHeading, formatTime12, minutesBetween, nowTimeIn, roundTimeTo, shiftTime } from "@/lib/domain/time";
import type { AttendanceStatus, ChangeMethod, CheckInSource } from "@/lib/domain/types";
import { cn } from "@/lib/utils";
import { TimeSheet } from "./time-sheet";
import { ROW_GRID, WorkerRow, type RowState } from "./worker-row";

interface Draft {
  status: AttendanceStatus;
  checkIn: string | null;
  checkOut: string | null;
  /** "suggested" only when the site's suggested IN was accepted unchanged */
  checkInSource: CheckInSource | null;
  method: ChangeMethod;
  /** version of the saved record when editing started (null = no record yet) */
  baseVersion: number | null;
}
type Drafts = Record<string, Draft>;

type Filter = "all" | "present" | "absent" | "pending";
type SheetState = { kind: "in" | "out"; workerId: string; nowMs: number } | { kind: "bulk-out" | "bulk-in"; nowMs: number } | null;

/** Far future: evaluates an entry for display without the future-time limits. */
const DISPLAY_NOW = new Date(8.64e15);
/** Lists longer than this get a search field. */
const SEARCH_THRESHOLD = 8;

// ---- unsaved draft persistence (per project + contractor + date, on this device) ----
const subscribeStorage = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, drafts: Drafts) {
  try {
    if (Object.keys(drafts).length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(drafts));
  } catch {
    // Storage unavailable (private mode): drafts still live in memory until saved.
  }
}

export interface AttendanceRegisterProps {
  view: RegisterView;
  basePath: string;
  allowDateChange: boolean;
  extraQuery?: Record<string, string>;
  /** accessible name for the register region */
  heading?: string;
}

export function AttendanceRegister({ view, basePath, allowDateChange, extraQuery, heading = "Attendance" }: AttendanceRegisterProps) {
  const router = useRouter();
  const project = view.project;
  const storageKey = project && view.contractorId ? `nf-att:v2:${project.id}:${view.contractorId}:${view.date}` : null;

  const stored = useSyncExternalStore(
    subscribeStorage,
    () => (storageKey ? readStorage(storageKey) : null),
    () => null,
  );
  const [localDrafts, setLocalDrafts] = useState<Drafts | null>(null);
  const [overrides, setOverrides] = useState<Record<string, SavedEntryDTO>>({});
  const [filter, setFilterState] = useState<Filter>("all");
  /** rows changed while a filter is active stay visible, so the list never jumps under the operator's thumb */
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  // Counts shown in these dialogs are taken when they open, so the closing animation doesn't flash "0".
  const [dialogCount, setDialogCount] = useState(0);
  const [pendingNav, setPendingNav] = useState<Record<string, string> | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [navigating, startNavigating] = useTransition();

  const setFilter = (f: Filter) => {
    setFilterState(f);
    setTouched(new Set());
  };
  const touch = useCallback((ids: string[]) => {
    setTouched((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const savedFor = useCallback(
    (workerId: string, propSaved: SavedEntryDTO | null) => {
      const o = overrides[workerId];
      return o && (!propSaved || o.version > propSaved.version) ? o : propSaved;
    },
    [overrides],
  );

  // Drafts restored from this device, discarding any whose record changed since.
  const storedDrafts = useMemo<Drafts>(() => {
    if (!stored || !view.editable) return {};
    try {
      const parsed = JSON.parse(stored) as Drafts;
      const out: Drafts = {};
      for (const row of view.rows) {
        const d = parsed[row.workerId];
        if (d && (savedFor(row.workerId, row.saved)?.version ?? null) === d.baseVersion) out[row.workerId] = d;
      }
      return out;
    } catch {
      return {};
    }
  }, [stored, view.rows, view.editable, savedFor]);

  const drafts: Drafts = localDrafts ?? storedDrafts;
  const dirtyCount = Object.keys(drafts).length;

  // Refs so memoised row callbacks stay stable.
  const draftsRef = useRef(drafts);
  const rowsRef = useRef(view.rows);
  const savedForRef = useRef(savedFor);
  useEffect(() => {
    draftsRef.current = drafts;
    rowsRef.current = view.rows;
    savedForRef.current = savedFor;
  });

  const commit = useCallback(
    (next: Drafts) => {
      draftsRef.current = next;
      setLocalDrafts(next);
      if (storageKey) writeStorage(storageKey, next);
    },
    [storageKey],
  );

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    if (dirtyCount === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtyCount]);

  // Everything below comes from the site's attendance policy (resolved on the server).
  const day = view.policy?.day ?? FALLBACK_POLICY;
  const capture = view.policy?.capture ?? FALLBACK_POLICY;
  const suggestedIn = day.suggestedCheckIn;
  const tz = project?.timezone ?? FALLBACK_TIMEZONE;
  const overnight = day.allowOvernight;
  const windowClosed = view.policy?.operatorWindowClosed ?? false;

  const baseState = useCallback(
    (workerId: string) => {
      const row = rowsRef.current.find((r) => r.workerId === workerId);
      const saved = row ? savedForRef.current(workerId, row.saved) : null;
      return {
        status: saved?.status ?? ("pending" as AttendanceStatus),
        checkIn: saved?.checkIn ?? null,
        checkOut: saved?.checkOut ?? null,
        checkInSource: saved?.checkInSource ?? null,
        version: saved?.version ?? null,
      };
    },
    [],
  );

  /** What is stored for each worker, exactly (so untouched times keep their stored instants). */
  const previousById = useMemo(() => {
    const m = new Map<string, PreviousEntry | null>();
    for (const r of view.rows) {
      const s = savedFor(r.workerId, r.saved);
      m.set(r.workerId, s ? { status: s.status, checkInAt: s.checkInAt, checkOutAt: s.checkOutAt, checkInSource: s.checkInSource } : null);
    }
    return m;
  }, [view.rows, savedFor]);

  /** The same check the server runs on save, for individual and bulk changes alike. */
  const check = useCallback(
    (workerId: string, entry: EntryInput, now: Date) =>
      evaluateEntry(
        { workDate: view.date, timezone: tz, dayPolicy: { suggestedCheckIn: suggestedIn, allowOvernight: overnight }, capturePolicy: capture, now },
        entry,
        previousById.get(workerId) ?? null,
      ),
    [view.date, tz, suggestedIn, overnight, capture, previousById],
  );

  /** Apply a change to one worker; drops the draft if it matches what is saved. */
  const applyChange = useCallback(
    (all: Drafts, workerId: string, change: Omit<Draft, "baseVersion">): Drafts => {
      const base = baseState(workerId);
      const next = { ...all };
      if (base.status === change.status && base.checkIn === change.checkIn && base.checkOut === change.checkOut) {
        delete next[workerId];
      } else {
        next[workerId] = { ...change, baseVersion: all[workerId]?.baseVersion ?? base.version };
      }
      return next;
    },
    [baseState],
  );

  const current = useCallback(
    (workerId: string) => {
      const d = draftsRef.current[workerId];
      if (d) return d;
      const b = baseState(workerId);
      return { status: b.status, checkIn: b.checkIn, checkOut: b.checkOut, checkInSource: b.checkInSource, method: "individual" as ChangeMethod };
    },
    [baseState],
  );

  // P accepts the site's suggested IN (flagged as such) only when it passes the same
  // checks as any other entry; otherwise, or with no suggestion, it asks for the time.
  const onPresent = useCallback(
    (workerId: string) => {
      const c = current(workerId);
      if (c.status === "present") return;
      const nowMs = Date.now();
      if (suggestedIn && check(workerId, { status: "present", checkIn: suggestedIn, checkOut: null, checkInSource: "suggested" }, new Date(nowMs)).ok) {
        touch([workerId]);
        commit(applyChange(draftsRef.current, workerId, { status: "present", checkIn: suggestedIn, checkOut: null, checkInSource: "suggested", method: "individual" }));
        return;
      }
      setSheet({ kind: "in", workerId, nowMs });
    },
    [applyChange, check, commit, current, suggestedIn, touch],
  );

  const onAbsent = useCallback(
    (workerId: string) => {
      const c = current(workerId);
      if (c.status === "absent") return;
      touch([workerId]);
      commit(applyChange(draftsRef.current, workerId, { status: "absent", checkIn: null, checkOut: null, checkInSource: null, method: "individual" }));
    },
    [applyChange, commit, current, touch],
  );

  const onEditIn = useCallback((workerId: string) => setSheet({ kind: "in", workerId, nowMs: Date.now() }), []);
  const onEditOut = useCallback((workerId: string) => setSheet({ kind: "out", workerId, nowMs: Date.now() }), []);

  // ---- derived rows ----
  const rows = useMemo(() => {
    return view.rows.map((row) => {
      const saved = savedFor(row.workerId, row.saved);
      const d = drafts[row.workerId];
      const status = d?.status ?? saved?.status ?? "pending";
      const checkIn = d ? d.checkIn : saved?.checkIn ?? null;
      const checkOut = d ? d.checkOut : saved?.checkOut ?? null;
      const checkInSource = d ? d.checkInSource : saved?.checkInSource ?? null;
      let workedMinutes: number | null = null;
      let checkOutNextDay = false;
      let labels = NO_LABELS;
      const v = status === "present" && checkIn ? check(row.workerId, { status, checkIn, checkOut, checkInSource: checkInSource ?? "entered" }, DISPLAY_NOW) : null;
      if (v?.ok && v.checkInAt) {
        if (v.checkOutAt) workedMinutes = minutesBetween(v.checkInAt, v.checkOutAt);
        checkOutNextDay = v.checkOutNextDay;
        labels = dayLabels(day, { status, checkInAt: v.checkInAt, checkOutAt: v.checkOutAt }, view.date, tz, windowClosed);
      } else if (status === "pending") {
        labels = dayLabels(day, null, view.date, tz, windowClosed);
      }
      const state: RowState = {
        status,
        checkIn: status === "present" ? checkIn : null,
        checkOut: status === "present" ? checkOut : null,
        checkOutNextDay,
        checkInSource: status === "present" ? checkInSource : null,
        dirty: !!d,
        bulk: (d?.method ?? saved?.method) === "bulk" && status !== "pending",
        workedMinutes,
        labels,
      };
      return { row, state };
    });
  }, [view.rows, view.date, drafts, savedFor, tz, check, day, windowClosed]);

  const stateById = useMemo(() => new Map(rows.map((r) => [r.row.workerId, r.state])), [rows]);
  const stateOf = (workerId: string) =>
    stateById.get(workerId) ?? { status: "pending" as AttendanceStatus, checkIn: null, checkOut: null, checkInSource: null as CheckInSource | null };

  const counts = useMemo(() => {
    const c = { total: rows.length, present: 0, absent: 0, pending: 0, outMissing: 0 };
    for (const { state } of rows) {
      if (state.status === "present") {
        c.present++;
        if (!state.checkOut) c.outMissing++;
      } else if (state.status === "absent") c.absent++;
      else c.pending++;
    }
    return c;
  }, [rows]);

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      ({ row, state }) =>
        (filter === "all" || state.status === filter || touched.has(row.workerId)) &&
        (!q || row.workerName.toLowerCase().includes(q) || row.workerCode.toLowerCase().includes(q)),
    );
  }, [rows, filter, query, touched]);

  // ---- time validation ----
  const isToday = view.date === view.today;
  const validateIn = (workerId: string, nowMs: number) => (time: string) => {
    const c = stateOf(workerId);
    const v = check(workerId, { status: "present", checkIn: time, checkOut: c.checkOut, checkInSource: "entered" }, new Date(nowMs));
    if (v.ok) return null;
    return v.field === "out" && c.checkOut ? `IN must be before the OUT time (${formatTime12(c.checkOut)})` : v.error;
  };
  const validateOut = (workerId: string, nowMs: number) => (time: string) => {
    const c = stateOf(workerId);
    if (!c.checkIn) return "Record the IN time first";
    const v = check(workerId, { status: "present", checkIn: c.checkIn, checkOut: time, checkInSource: c.checkInSource ?? "entered" }, new Date(nowMs));
    if (v.ok) return null;
    return v.error === "OUT time must be after IN time" ? `OUT must be after IN (${formatTime12(c.checkIn)})` : v.error;
  };
  const outNote = (workerId: string) => (time: string) => {
    const c = stateOf(workerId);
    if (!c.checkIn || !overnight) return null;
    const v = check(workerId, { status: "present", checkIn: c.checkIn, checkOut: time, checkInSource: c.checkInSource ?? "entered" }, DISPLAY_NOW);
    return v.ok && v.checkOutNextDay ? "Next day (overnight shift)" : null;
  };
  const nowFor = (nowMs: number) => roundTimeTo(nowTimeIn(tz, new Date(nowMs)), 5);

  // ---- bulk actions ----
  const pendingIds = rows.filter((r) => r.state.status === "pending").map((r) => r.row.workerId);
  const outMissingIds = rows.filter((r) => r.state.status === "present" && !r.state.checkOut).map((r) => r.row.workerId);

  // Bulk present marks every pending worker with one IN time, through the same check as a
  // single entry. With a suggested time it is offered first (flagged as accepted); otherwise,
  // or if it is not valid yet, the operator chooses the time.
  const bulkPresent = (time: string, source: CheckInSource, nowMs: number) => {
    let next = draftsRef.current;
    for (const id of pendingIds) {
      const v = check(id, { status: "present", checkIn: time, checkOut: null, checkInSource: source }, new Date(nowMs));
      if (!v.ok) {
        toast.error(v.error);
        return false;
      }
      next = applyChange(next, id, { status: "present", checkIn: time, checkOut: null, checkInSource: source, method: "bulk" });
    }
    touch(pendingIds);
    commit(next);
    toast.success(`${pendingIds.length} workers marked present at ${formatTime12(time)}. Tap Save to keep.`);
    return true;
  };
  const bulkConfirm = (nowMs: number) => {
    setBulkConfirmOpen(false);
    if (!suggestedIn || !bulkPresent(suggestedIn, "suggested", nowMs)) setSheet({ kind: "bulk-in", nowMs });
  };
  const validateBulkIn = (nowMs: number) => (time: string) => {
    const first = pendingIds[0];
    if (!first) return null;
    const v = check(first, { status: "present", checkIn: time, checkOut: null, checkInSource: "entered" }, new Date(nowMs));
    return v.ok ? null : v.error;
  };

  const bulkOut = (time: string, nowMs: number) => {
    let next = draftsRef.current;
    let done = 0;
    let skipped = 0;
    for (const id of outMissingIds) {
      const c = stateOf(id);
      if (validateOut(id, nowMs)(time)) {
        skipped++;
        continue;
      }
      next = applyChange(next, id, { status: "present", checkIn: c.checkIn, checkOut: time, checkInSource: c.checkInSource, method: "bulk" });
      done++;
    }
    touch(outMissingIds);
    commit(next);
    setSheet(null);
    toast.success(
      `OUT ${formatTime12(time)} set for ${done} worker(s).${skipped ? ` ${skipped} skipped (IN is after this time).` : ""} Tap Save to keep.`,
    );
  };

  // ---- save ----
  const save = (after?: () => void) => {
    if (!project || !view.contractorId || dirtyCount === 0) return;
    const items = Object.entries(drafts).map(([workerId, d]) => ({
      workerId,
      status: d.status,
      checkIn: d.status === "present" ? d.checkIn : null,
      checkOut: d.status === "present" ? d.checkOut : null,
      checkInSource: d.status === "present" ? d.checkInSource ?? "entered" : null,
      method: d.method,
      expectedVersion: d.baseVersion,
    }));
    startSaving(async () => {
      const res = await saveAttendanceAction({
        projectId: project.id, contractorId: view.contractorId, workDate: view.date, items, policyToken: view.policy?.token,
      });
      if (!res.ok) {
        if (res.code === "stale_settings") {
          // Drafts stay on this device; the reload brings the new settings.
          toast.error(res.error, { duration: 15000, action: { label: "Reload", onClick: () => router.refresh() } });
        } else if (res.code === "conflict") {
          toast.error(res.error, {
            duration: 15000,
            action: { label: "Reload", onClick: () => { commit({}); router.refresh(); } },
          });
        } else {
          toast.error(`Not saved: ${res.error}`, { duration: 10000 });
        }
        return;
      }
      setOverrides((prev) => {
        const next = { ...prev };
        for (const r of res.data.rows) if (r.saved) next[r.workerId] = r.saved;
        return next;
      });
      commit({});
      setLastSavedAt(nowTimeIn(tz));
      toast.success(res.data.saved === 1 ? "1 change saved" : `${res.data.saved} changes saved`);
      after?.();
    });
  };

  const discard = () => {
    commit({});
    setDiscardOpen(false);
    toast("Unsaved changes discarded");
  };

  // ---- navigation between project / contractor / date ----
  const navigate = (patch: Record<string, string>) => {
    const params = new URLSearchParams({ ...extraQuery });
    const next = { project: project?.id ?? "", contractor: view.contractorId ?? "", date: view.date, ...patch };
    if (patch.project && patch.project !== project?.id) next.contractor = "";
    for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
    startNavigating(() => router.push(`${basePath}?${params.toString()}`));
  };
  const requestNavigate = (patch: Record<string, string>) => {
    if (dirtyCount > 0) setPendingNav(patch);
    else navigate(patch);
  };

  // ---- sheet wiring ----
  const sheetWorker = sheet && (sheet.kind === "in" || sheet.kind === "out") ? view.rows.find((r) => r.workerId === sheet.workerId) : null;
  const sheetCurrent = sheet && (sheet.kind === "in" || sheet.kind === "out") ? stateOf(sheet.workerId) : null;
  // Quick picks centre on the site's suggested IN or shift start, else on the current time.
  const inAnchor = (nowMs: number) => suggestedIn ?? day.shiftStart ?? nowFor(nowMs);
  const inQuickPicks = (nowMs: number) => [-60, -30, 0, 30, 60, 90].map((d) => shiftTime(inAnchor(nowMs), d));
  const outQuickPicks = (checkIn: string | null, nowMs: number) => {
    const fromIn = [240, 480, 510, 540, 570, 600].map((d) => shiftTime(checkIn ?? inAnchor(nowMs), d));
    return day.shiftEnd ? [day.shiftEnd, ...fromIn.filter((t) => t !== day.shiftEnd)].slice(0, 6) : fromIn;
  };
  const earliestMissingIn = outMissingIds.map((id) => stateOf(id).checkIn).filter((t): t is string => !!t).sort()[0] ?? null;

  if (!project) {
    return <EmptyState icon={Lock} title="No project sites yet" description={view.readOnlyReason ?? "No project sites available."} />;
  }

  const contractor = view.contractors.find((c) => c.id === view.contractorId) ?? null;
  const marked = counts.present + counts.absent;
  const showSearch = view.rows.length > SEARCH_THRESHOLD;
  const canGoForward = view.date < view.today;

  return (
    <section aria-label={heading} className={cn("space-y-4", dirtyCount > 0 && "pb-24")} data-testid="register" data-suggested-in={suggestedIn ?? ""}>
      {/* ---------- Header: date, project, contractor ---------- */}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-end md:gap-8">
        <div className="min-w-0">
          <div className="flex min-h-9 items-center justify-between gap-2">
            <p data-testid="register-date" className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground">
              <span className="truncate">{formatDateHeading(view.date, view.today)}</span>
              {isToday && <span className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary">Today</span>}
            </p>
            {allowDateChange && (
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="icon-sm" aria-label="Previous day" onClick={() => requestNavigate({ date: addDays(view.date, -1) })}>
                  <ChevronLeft />
                </Button>
                <label className="relative grid size-9 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring">
                  <CalendarDays className="size-4" />
                  <input
                    type="date"
                    value={view.date}
                    max={view.today}
                    onClick={(e) => {
                      try {
                        e.currentTarget.showPicker?.();
                      } catch {
                        // Older browsers open their own picker.
                      }
                    }}
                    onChange={(e) => e.target.value && requestNavigate({ date: e.target.value })}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    aria-label="Attendance date"
                  />
                </label>
                <Button variant="ghost" size="icon-sm" aria-label="Next day" disabled={!canGoForward} onClick={() => requestNavigate({ date: addDays(view.date, 1) })}>
                  <ChevronRight />
                </Button>
              </div>
            )}
          </div>

          {/* Project: a heading that is also a native picker (fast and familiar on phones) */}
          <div className="relative mt-1 rounded-lg has-[select:focus-visible]:ring-2 has-[select:focus-visible]:ring-ring">
            <h1 className="flex items-start gap-1.5 text-title font-semibold text-balance">
              <span className="min-w-0">{project.name}</span>
              {view.projects.length > 1 && <ChevronsUpDown className="mt-1.5 size-4 shrink-0 text-muted-foreground" />}
            </h1>
            <select
              data-testid="project-select"
              value={project.id}
              onChange={(e) => requestNavigate({ project: e.target.value })}
              aria-label="Project site"
              className={cn("absolute inset-0 w-full appearance-none opacity-0", view.projects.length > 1 ? "cursor-pointer" : "cursor-default")}
            >
              {view.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.location}
                </option>
              ))}
            </select>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{project.location}</p>
        </div>

        {/* Contractor picker */}
        <div
          className={cn(
            "relative flex min-h-15 items-center gap-3 rounded-xl bg-card px-3 py-2.5 shadow-surface transition-colors has-[select:focus-visible]:ring-2 has-[select:focus-visible]:ring-ring",
            view.contractors.length > 1 && "hover:bg-muted/50",
          )}
        >
          {contractor ? (
            <ContractorAvatar name={contractor.name} photoUrl={contractor.photoUrl} size="sm" />
          ) : (
            <span className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Users className="size-4" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="tabular text-2xs leading-4 font-medium text-muted-foreground">
              Contractor
              {contractor && ` · ${contractor.workerCount} ${contractor.workerCount === 1 ? "worker" : "workers"}`}
              {view.contractors.length > 1 && ` · ${view.contractors.length} at this site`}
            </div>
            <div className="truncate text-md leading-5 font-semibold">{contractor?.name ?? "No contractors at this site"}</div>
          </div>
          {view.contractors.length > 1 && <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />}
          <select
            data-testid="contractor-select"
            value={view.contractorId ?? ""}
            onChange={(e) => requestNavigate({ contractor: e.target.value })}
            disabled={view.contractors.length === 0}
            aria-label="Contractor"
            className={cn("absolute inset-0 w-full appearance-none opacity-0", view.contractors.length > 1 ? "cursor-pointer" : "cursor-default")}
          >
            {view.contractors.length === 0 && <option value="">No contractors at this site</option>}
            {view.contractors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.workerCount})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ---------- Notices ---------- */}
      {view.readOnlyReason && (
        <div className="flex items-center gap-2.5 rounded-xl bg-muted px-3.5 py-3 text-sm">
          <Lock className="size-4 shrink-0 text-muted-foreground" /> {view.readOnlyReason}
        </div>
      )}
      {view.editable && !isToday && (
        <div className="flex items-start gap-2.5 rounded-xl bg-pending-soft px-3.5 py-3 text-sm text-pending">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>You are correcting a past date. Every change is recorded in the change log.</span>
        </div>
      )}

      {/* ---------- The next bulk step. One slot of fixed height that swaps from "mark everyone"
           to "record OUT", so marking workers never pushes the list under the operator's thumb. ---------- */}
      {view.editable && (counts.pending > 0 || counts.outMissing > 0) && (
        <div>
          {counts.pending > 0 ? (
            <TaskButton
              icon={<CheckCheck className="size-4.5" />}
              tone="present"
              title={`Mark all ${counts.pending} pending present`}
              detail={
                suggestedIn
                  ? `Suggested IN ${formatTime12(suggestedIn)} · pending workers are not counted until confirmed`
                  : "Choose one IN time · pending workers are not counted until confirmed"
              }
              onClick={() => {
                setDialogCount(pendingIds.length);
                if (suggestedIn) setBulkConfirmOpen(true);
                else setSheet({ kind: "bulk-in", nowMs: Date.now() });
              }}
              data-testid="bulk-present"
            />
          ) : (
            <TaskButton
              icon={<Clock className="size-4.5" />}
              tone="primary"
              title={`Record OUT for ${counts.outMissing} worker${counts.outMissing === 1 ? "" : "s"}`}
              detail={isToday ? "One checkout time for everyone still on site" : "Checkout was not recorded on this date"}
              onClick={() => setSheet({ kind: "bulk-out", nowMs: Date.now() })}
              data-testid="bulk-out"
            />
          )}
        </div>
      )}

      {/* ---------- Sticky filter + search bar ---------- */}
      {view.rows.length > 0 && (
        <div className="sticky top-(--header-h) z-20 -mx-4 bg-background/90 px-4 pt-2 pb-2.5 backdrop-blur-md md:-mx-6 md:px-6">
          <div className="flex items-center gap-2">
            <div className="grid flex-1 grid-cols-4 gap-0.5 rounded-xl bg-muted p-1 md:max-w-xl" role="tablist" aria-label="Filter workers">
              {(
                [
                  ["all", "All", counts.total, ""],
                  ["pending", "Pending", counts.pending, counts.pending > 0 ? "text-pending" : ""],
                  ["present", "Present", counts.present, counts.present > 0 ? "text-present" : ""],
                  ["absent", "Absent", counts.absent, counts.absent > 0 ? "text-absent" : ""],
                ] as const
              ).map(([key, label, n, tone]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={filter === key}
                  data-testid={`count-${key}`}
                  onClick={() => setFilter(key)}
                  className={cn(
                    "flex h-11 min-w-0 flex-col items-center justify-center rounded-lg transition-[background-color,box-shadow] duration-150 md:h-10 md:flex-row md:gap-1.5",
                    filter === key ? "bg-card shadow-surface" : "hover:bg-card/60",
                  )}
                >
                  <div className={cn("tabular text-md leading-5 font-semibold", tone)}>{n}</div>
                  <span className={cn("truncate text-2xs leading-3.5 font-medium md:text-sm", filter === key ? "text-foreground" : "text-muted-foreground")}>{label}</span>
                </button>
              ))}
            </div>
            {showSearch && (
              <>
                <Button
                  variant={searchOpen ? "secondary" : "outline"}
                  size="icon-lg"
                  className="md:hidden"
                  aria-label={searchOpen ? "Close search" : "Search workers"}
                  aria-expanded={searchOpen}
                  onClick={() => {
                    if (searchOpen) setQuery("");
                    setSearchOpen(!searchOpen);
                  }}
                >
                  {searchOpen ? <X className="size-5" /> : <Search className="size-5" />}
                </Button>
                <SearchField className="hidden w-72 md:ml-auto md:block" query={query} setQuery={setQuery} />
              </>
            )}
          </div>
          {showSearch && searchOpen && <SearchField className="mt-2 md:hidden" query={query} setQuery={setQuery} autoFocus />}
          <div className="mt-2.5 flex items-center gap-3">
            <AttendanceBar present={counts.present} absent={counts.absent} total={counts.total} className="flex-1" />
            <span className="tabular shrink-0 text-xs text-muted-foreground" role="status">
              {dirtyCount > 0 ? (
                <span className="font-medium text-pending">Not saved yet</span>
              ) : lastSavedAt ? (
                <span className="inline-flex items-center gap-1">
                  <Check className="size-3.5 text-present" strokeWidth={2.5} /> Saved {formatTime12(lastSavedAt)}
                </span>
              ) : (
                `${marked} of ${counts.total} marked`
              )}
            </span>
          </div>
          {navigating && <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary/60" />}
        </div>
      )}

      {/* ---------- Worker list ---------- */}
      {view.rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No workers on this register"
          description="No workers are assigned to this contractor at this site on this date."
        />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={query ? `No one matches “${query}”` : "No workers match this filter"}
          action={
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              Show everyone
            </Button>
          }
        />
      ) : (
        <div className={cn("-mx-4 bg-card shadow-surface transition-opacity duration-200 sm:mx-0 sm:overflow-hidden sm:rounded-xl", navigating && "opacity-60")}>
          <div
            aria-hidden
            className={cn(ROW_GRID, "hidden border-b px-4 py-2 text-2xs font-semibold tracking-wide text-muted-foreground uppercase md:grid")}
          >
            <span className="[grid-area:name]">Worker</span>
            <span className="[grid-area:status]">Status</span>
            <span className="[grid-area:in]">Check-in</span>
            <span className="[grid-area:out]">Check-out</span>
            <span className="text-right [grid-area:mark]">Mark</span>
          </div>
          <ul className="divide-y divide-border" data-testid="worker-list">
            {visibleRows.map(({ row, state }) => (
              <WorkerRow
                key={row.workerId}
                workerId={row.workerId}
                name={row.workerName}
                code={row.workerCode}
                state={state}
                suggestedIn={suggestedIn}
                editable={view.editable}
                isToday={isToday}
                onPresent={onPresent}
                onAbsent={onAbsent}
                onEditIn={onEditIn}
                onEditOut={onEditOut}
              />
            ))}
          </ul>
        </div>
      )}

      {/* ---------- Save bar (only while there is something to save) ---------- */}
      {dirtyCount > 0 && (
        <div className="animate-rise-in fixed inset-x-0 bottom-(--bottom-nav-h) z-30 px-3 pb-3 md:pb-6">
          <div className="mx-auto flex max-w-lg items-center gap-2 rounded-2xl bg-foreground py-2 pr-2 pl-4 text-background shadow-raised">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-pending-dot" />
            <div className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="unsaved-count" role="status">
              {dirtyCount} unsaved change{dirtyCount === 1 ? "" : "s"}
            </div>
            <Button
              variant="ghost"
              className="h-11 px-2.5 text-background/75 hover:bg-white/10 hover:text-background"
              onClick={() => {
                setDialogCount(dirtyCount);
                setDiscardOpen(true);
              }}
              disabled={saving}
            >
              Discard
            </Button>
            <Button
              className="h-11 bg-card px-5 text-base font-semibold text-foreground shadow-none hover:bg-card/90"
              onClick={() => save()}
              disabled={saving}
              data-testid="save-button"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* ---------- IN / OUT editors ---------- */}
      {sheet?.kind === "in" && sheetWorker && sheetCurrent && (
        <TimeSheet
          open
          onOpenChange={(o) => !o && setSheet(null)}
          title="Check-in time"
          subject={sheetWorker.workerName}
          description={sheetCurrent.status === "pending" ? "Setting an IN time marks this worker present." : undefined}
          initialTime={sheetCurrent.checkIn ?? (isToday ? nowFor(sheet.nowMs) : inAnchor(sheet.nowMs))}
          quickPicks={inQuickPicks(sheet.nowMs)}
          nowTime={isToday ? nowFor(sheet.nowMs) : null}
          confirmLabel="Set IN"
          validate={validateIn(sheet.workerId, sheet.nowMs)}
          onConfirm={(t) => {
            touch([sheet.workerId]);
            // Picked in the sheet, so it was entered (even if it equals the suggestion).
            const source: CheckInSource = t === sheetCurrent.checkIn && sheetCurrent.checkInSource ? sheetCurrent.checkInSource : "entered";
            commit(applyChange(draftsRef.current, sheet.workerId, { status: "present", checkIn: t, checkOut: sheetCurrent.checkOut, checkInSource: source, method: "individual" }));
            setSheet(null);
          }}
        />
      )}
      {sheet?.kind === "out" && sheetWorker && sheetCurrent && (
        <TimeSheet
          open
          onOpenChange={(o) => !o && setSheet(null)}
          title="Check-out time"
          subject={sheetWorker.workerName}
          description={sheetCurrent.checkIn ? `IN was ${formatTime12(sheetCurrent.checkIn)}` : undefined}
          initialTime={sheetCurrent.checkOut ?? (isToday ? nowFor(sheet.nowMs) : day.shiftEnd ?? shiftTime(sheetCurrent.checkIn ?? inAnchor(sheet.nowMs), 540))}
          quickPicks={outQuickPicks(sheetCurrent.checkIn, sheet.nowMs)}
          nowTime={isToday ? nowFor(sheet.nowMs) : null}
          confirmLabel="Set OUT"
          validate={validateOut(sheet.workerId, sheet.nowMs)}
          note={outNote(sheet.workerId)}
          onConfirm={(t) => {
            touch([sheet.workerId]);
            commit(
              applyChange(draftsRef.current, sheet.workerId, {
                status: "present", checkIn: sheetCurrent.checkIn, checkOut: t, checkInSource: sheetCurrent.checkInSource, method: "individual",
              }),
            );
            setSheet(null);
          }}
          onClear={
            sheetCurrent.checkOut
              ? () => {
                  commit(
                    applyChange(draftsRef.current, sheet.workerId, {
                      status: "present", checkIn: sheetCurrent.checkIn, checkOut: null, checkInSource: sheetCurrent.checkInSource, method: "individual",
                    }),
                  );
                  setSheet(null);
                }
              : undefined
          }
          clearLabel="Remove OUT"
        />
      )}
      {sheet?.kind === "bulk-out" && (
        <TimeSheet
          open
          onOpenChange={(o) => !o && setSheet(null)}
          title={`Record OUT for ${outMissingIds.length} worker${outMissingIds.length === 1 ? "" : "s"}`}
          description="Applies to present workers with no OUT time yet. Logged as a bulk entry."
          initialTime={isToday ? nowFor(sheet.nowMs) : day.shiftEnd ?? shiftTime(earliestMissingIn ?? inAnchor(sheet.nowMs), 540)}
          quickPicks={outQuickPicks(earliestMissingIn, sheet.nowMs)}
          nowTime={isToday ? nowFor(sheet.nowMs) : null}
          confirmLabel="Set OUT"
          validate={(t) => (outMissingIds.every((id) => validateOut(id, sheet.nowMs)(t)) ? "This time is not valid for any of these workers" : null)}
          onConfirm={(t) => bulkOut(t, sheet.nowMs)}
        />
      )}
      {sheet?.kind === "bulk-in" && (
        <TimeSheet
          open
          onOpenChange={(o) => !o && setSheet(null)}
          title={`IN time for ${pendingIds.length} pending worker${pendingIds.length === 1 ? "" : "s"}`}
          description="Only if they are all on site. Logged as a bulk entry; you can still change anyone before saving."
          initialTime={isToday ? nowFor(sheet.nowMs) : inAnchor(sheet.nowMs)}
          quickPicks={inQuickPicks(sheet.nowMs)}
          nowTime={isToday ? nowFor(sheet.nowMs) : null}
          confirmLabel="Mark present"
          validate={validateBulkIn(sheet.nowMs)}
          onConfirm={(t) => {
            if (bulkPresent(t, "entered", sheet.nowMs)) setSheet(null);
          }}
        />
      )}

      <AlertDialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark {dialogCount} workers present?</AlertDialogTitle>
            <AlertDialogDescription>
              Everyone still pending gets the site&rsquo;s suggested IN time, {suggestedIn ? formatTime12(suggestedIn) : "—"}. Only do this if
              they are all on site. These entries are recorded as <strong className="font-semibold text-foreground">bulk confirmed</strong>{" "}
              with the suggested time accepted, and you can still change anyone before saving.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                setBulkConfirmOpen(false);
                setSheet({ kind: "bulk-in", nowMs: Date.now() });
              }}
            >
              Choose another time
            </Button>
            <AlertDialogAction onClick={() => bulkConfirm(Date.now())} data-testid="bulk-present-confirm">
              Mark {dialogCount} present
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard {dialogCount} unsaved change{dialogCount === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>The register goes back to the last saved entries. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={discard}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingNav !== null} onOpenChange={(o) => !o && setPendingNav(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save your changes first?</AlertDialogTitle>
            <AlertDialogDescription>
              You have {dirtyCount} unsaved change{dirtyCount === 1 ? "" : "s"} on this register.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay here</AlertDialogCancel>
            <Button
              variant="outline"
              className="text-absent"
              onClick={() => {
                const p = pendingNav;
                commit({});
                setPendingNav(null);
                if (p) navigate(p);
              }}
            >
              Discard & switch
            </Button>
            <Button
              onClick={() => {
                const p = pendingNav;
                setPendingNav(null);
                save(() => p && navigate(p));
              }}
            >
              Save & switch
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function TaskButton({
  icon,
  tone,
  title,
  detail,
  onClick,
  ...rest
}: { icon: React.ReactNode; tone: "present" | "primary"; title: string; detail: string; onClick: () => void } & Record<`data-${string}`, string>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-18 w-full items-center gap-3 rounded-xl bg-card px-3 text-left shadow-surface transition-[background-color,transform] duration-150 hover:bg-muted/50 active:scale-[0.99]"
      {...rest}
    >
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-full", tone === "present" ? "bg-present-soft text-present" : "bg-primary-soft text-primary")}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm leading-5 font-semibold", tone === "present" ? "text-present" : "text-primary")}>{title}</span>
        <span className="line-clamp-2 text-xs leading-4 text-muted-foreground">{detail}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-subtle-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function SearchField({ query, setQuery, className, autoFocus }: { query: string; setQuery: (q: string) => void; className?: string; autoFocus?: boolean }) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search name or ID"
        className="h-11 w-full rounded-xl border border-input bg-card pr-3 pl-9 text-base outline-none placeholder:text-subtle-foreground focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/25 md:h-10 md:text-sm"
        aria-label="Search workers"
      />
    </div>
  );
}
