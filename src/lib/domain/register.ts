import type { AttendanceRecord, AttendanceStatus, Worker, WorkerAssignment } from "./types";

// Builds the daily attendance register: which workers belong on a
// (project, contractor, date) sheet. Uses effective-dated assignments so
// transfers never move historical attendance.

export function assignmentCovers(a: Pick<WorkerAssignment, "startDate" | "endDate">, date: string): boolean {
  return a.startDate <= date && (a.endDate === null || a.endDate >= date);
}

export interface RegisterEntry {
  worker: Worker;
  contractorId: string;
  record: AttendanceRecord | null;
  /** true when an assignment places the worker on this site on this date */
  assigned: boolean;
}

const collator = new Intl.Collator("en-IN", { sensitivity: "base", numeric: true });

export function sortByName<T extends { fullName: string; code?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => collator.compare(a.fullName, b.fullName) || collator.compare(a.code ?? "", b.code ?? ""));
}

export function registerEntries(input: {
  projectId: string;
  contractorId: string | null;
  date: string;
  workers: Worker[];
  assignments: WorkerAssignment[];
  records: AttendanceRecord[];
}): RegisterEntry[] {
  const { projectId, contractorId, date } = input;
  const workerById = new Map(input.workers.map((w) => [w.id, w]));
  const entries = new Map<string, RegisterEntry>();

  for (const a of input.assignments) {
    if (a.projectId !== projectId || !assignmentCovers(a, date)) continue;
    if (contractorId && a.contractorId !== contractorId) continue;
    const worker = workerById.get(a.workerId);
    if (!worker) continue;
    entries.set(worker.id, { worker, contractorId: a.contractorId, record: null, assigned: true });
  }

  // Existing records are always shown, even if the assignment later changed.
  for (const r of input.records) {
    if (r.projectId !== projectId || r.workDate !== date) continue;
    if (contractorId && r.contractorId !== contractorId) continue;
    const worker = workerById.get(r.workerId);
    if (!worker) continue;
    const existing = entries.get(worker.id);
    entries.set(worker.id, {
      worker,
      contractorId: r.contractorId,
      record: r,
      assigned: existing?.assigned ?? false,
    });
  }

  const sorted = sortByName([...entries.values()].map((e) => ({ ...e, fullName: e.worker.fullName, code: e.worker.code })));
  return sorted.map(({ worker, contractorId: c, record, assigned }) => ({ worker, contractorId: c, record, assigned }));
}

export interface RegisterCounts {
  total: number;
  present: number;
  absent: number;
  pending: number;
  /** present workers whose OUT is not recorded yet */
  outMissing: number;
}

export function countStatuses(items: { status: AttendanceStatus; hasCheckOut: boolean }[]): RegisterCounts {
  const c: RegisterCounts = { total: items.length, present: 0, absent: 0, pending: 0, outMissing: 0 };
  for (const i of items) {
    if (i.status === "present") {
      c.present++;
      if (!i.hasCheckOut) c.outMissing++;
    } else if (i.status === "absent") c.absent++;
    else c.pending++;
  }
  return c;
}
