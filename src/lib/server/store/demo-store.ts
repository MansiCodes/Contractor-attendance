import { conflict, invalid, notFound } from "@/lib/errors";
import { addDays } from "@/lib/domain/time";
import { assignmentCovers } from "@/lib/domain/register";
import type { Actor, AttendanceRecord, AttendanceSnapshot, Contractor, PaymentRule, Profile, Project, Worker } from "@/lib/domain/types";
import { createDemoState, type DemoState } from "./demo-seed";
import type {
  AttendanceQuery,
  AttendanceWrite,
  AuditQuery,
  DataStore,
  PaymentRuleFields,
  ProjectFields,
} from "./types";

// In-memory store used only in demo mode. It mirrors the database constraints
// (unique attendance per worker/project/date, non-overlapping assignments,
// optimistic versions, immutable rule versions, append-only audit log) so the
// demo behaves like production. Data lives in server memory and resets on restart.

const clone = <T,>(v: T): T => structuredClone(v);

export class DemoStore implements DataStore {
  readonly kind = "demo" as const;

  constructor(private state: DemoState) {}

  private now() {
    return new Date().toISOString();
  }

  private nextId(prefix: string) {
    this.state.seq.id++;
    return `${prefix}${this.state.seq.id}`;
  }

  // ---------- reads ----------

  async getProfile(id: string): Promise<Profile | null> {
    return clone(this.state.profiles.find((p) => p.id === id) ?? null);
  }
  async listProfiles() {
    return clone(this.state.profiles);
  }
  async listContractors(): Promise<Contractor[]> {
    return this.state.contractors.map((c) => ({ ...clone(c), photoUrl: c.photoPath ? this.state.photos[c.photoPath] ?? null : null }));
  }
  async listProjects() {
    return clone(this.state.projects);
  }
  async listContractorProjects() {
    return clone(this.state.contractorProjects);
  }
  async listWorkers() {
    return clone(this.state.workers);
  }
  async listWorkerAssignments() {
    return clone(this.state.assignments);
  }
  async listOperatorAccess() {
    return clone(this.state.operatorAccess);
  }
  async listAttendance(q: AttendanceQuery) {
    return clone(
      this.state.attendance.filter(
        (r) =>
          r.workDate >= q.from &&
          r.workDate <= q.to &&
          (!q.projectIds || q.projectIds.includes(r.projectId)) &&
          (!q.contractorId || r.contractorId === q.contractorId),
      ),
    );
  }
  async listPaymentRules() {
    return clone(this.state.rules);
  }
  async listAuditLogs(q: AuditQuery) {
    return clone(
      this.state.audit
        .filter(
          (l) =>
            (!q.projectIds || q.projectIds.includes(l.projectId)) &&
            (!q.from || l.workDate >= q.from) &&
            (!q.to || l.workDate <= q.to) &&
            (!q.workerId || l.workerId === q.workerId),
        )
        .sort((a, b) => b.changedAt.localeCompare(a.changedAt) || Number(b.id) - Number(a.id))
        .slice(0, q.limit),
    );
  }

  // ---------- contractors & projects ----------

  async createContractor(input: { name: string; location: string }) {
    const at = this.now();
    const c: Contractor = { id: this.nextId("c"), name: input.name, location: input.location, photoPath: null, photoUrl: null, isActive: true, createdAt: at, updatedAt: at };
    this.state.contractors.push(c);
    return clone(c);
  }

  async updateContractor(id: string, input: { name: string; location: string; isActive: boolean }) {
    const c = this.state.contractors.find((x) => x.id === id);
    if (!c) throw notFound("Contractor");
    Object.assign(c, input, { updatedAt: this.now() });
  }

  async setContractorPhoto(id: string, file: { bytes: Uint8Array; contentType: string }) {
    const c = this.state.contractors.find((x) => x.id === id);
    if (!c) throw notFound("Contractor");
    const path = `${id}/${Date.now()}`;
    this.state.photos[path] = `data:${file.contentType};base64,${Buffer.from(file.bytes).toString("base64")}`;
    if (c.photoPath) delete this.state.photos[c.photoPath];
    c.photoPath = path;
    c.updatedAt = this.now();
  }

  async createProject(input: ProjectFields) {
    const at = this.now();
    const p: Project = { id: this.nextId("p"), ...input, createdAt: at, updatedAt: at };
    this.state.projects.push(p);
    return clone(p);
  }

  async updateProject(id: string, input: ProjectFields) {
    const p = this.state.projects.find((x) => x.id === id);
    if (!p) throw notFound("Project");
    Object.assign(p, input, { updatedAt: this.now() });
  }

  async addContractorToProject(contractorId: string, projectId: string, startDate: string) {
    const open = this.state.contractorProjects.find(
      (a) => a.contractorId === contractorId && a.projectId === projectId && a.endDate === null,
    );
    if (open) throw conflict("This contractor is already assigned to this project");
    this.state.contractorProjects.push({ id: this.nextId("cp"), contractorId, projectId, startDate, endDate: null });
  }

  async endContractorProject(assignmentId: string, endDate: string) {
    const a = this.state.contractorProjects.find((x) => x.id === assignmentId);
    if (!a) throw notFound("Assignment");
    const activeWorkers = this.state.assignments.filter(
      (w) => w.projectId === a.projectId && w.contractorId === a.contractorId && (w.endDate === null || w.endDate > endDate),
    );
    if (activeWorkers.length > 0)
      throw invalid(`Move or deactivate the ${activeWorkers.length} worker(s) still deployed here first`);
    a.endDate = endDate < a.startDate ? a.startDate : endDate;
  }

  // ---------- workers ----------

  private assertNoOverlap(workerId: string, startDate: string, endDate: string | null, ignoreId?: string) {
    for (const a of this.state.assignments) {
      if (a.workerId !== workerId || a.id === ignoreId) continue;
      const overlaps = a.startDate <= (endDate ?? "9999-12-31") && startDate <= (a.endDate ?? "9999-12-31");
      if (overlaps) throw conflict("Worker already has a project assignment for these dates");
    }
  }

  async createWorker(input: { fullName: string; contractorId: string; projectId: string; startDate: string; phone: string | null; notes: string | null }) {
    const at = this.now();
    const seq = ++this.state.seq.worker;
    const w: Worker = {
      id: this.nextId("w"), code: `W-${String(seq).padStart(5, "0")}`, fullName: input.fullName, contractorId: input.contractorId,
      isActive: true, phone: input.phone, notes: input.notes, createdAt: at, updatedAt: at,
    };
    this.state.workers.push(w);
    this.state.assignments.push({
      id: this.nextId("wa"), workerId: w.id, projectId: input.projectId, contractorId: input.contractorId,
      startDate: input.startDate, endDate: null, createdAt: at,
    });
    return clone(w);
  }

  async updateWorker(id: string, input: { fullName: string; phone: string | null; notes: string | null }) {
    const w = this.state.workers.find((x) => x.id === id);
    if (!w) throw notFound("Worker");
    Object.assign(w, input, { updatedAt: this.now() });
  }

  private openAssignment(workerId: string) {
    return this.state.assignments.find((a) => a.workerId === workerId && a.endDate === null) ?? null;
  }

  async deactivateWorker(id: string, lastWorkingDate: string) {
    const w = this.state.workers.find((x) => x.id === id);
    if (!w) throw notFound("Worker");
    const open = this.openAssignment(id);
    if (open) {
      if (lastWorkingDate < open.startDate) throw invalid(`Last working date cannot be before ${open.startDate}`);
      open.endDate = lastWorkingDate;
    }
    w.isActive = false;
    w.updatedAt = this.now();
  }

  async reactivateWorker(id: string, projectId: string, startDate: string) {
    const w = this.state.workers.find((x) => x.id === id);
    if (!w) throw notFound("Worker");
    if (this.openAssignment(id)) throw conflict("Worker is already active");
    this.assertNoOverlap(id, startDate, null);
    this.state.assignments.push({ id: this.nextId("wa"), workerId: id, projectId, contractorId: w.contractorId, startDate, endDate: null, createdAt: this.now() });
    w.isActive = true;
    w.updatedAt = this.now();
  }

  async transferWorker(id: string, projectId: string, contractorId: string, effectiveDate: string) {
    const w = this.state.workers.find((x) => x.id === id);
    if (!w) throw notFound("Worker");
    const open = this.openAssignment(id);
    if (!open) throw invalid("Worker is inactive. Reactivate instead.");
    if (open.projectId === projectId && open.contractorId === contractorId) throw invalid("Worker is already assigned there");
    if (effectiveDate <= open.startDate) {
      throw invalid(`Transfer date must be after the current assignment started (${open.startDate})`);
    }
    open.endDate = addDays(effectiveDate, -1);
    this.state.assignments.push({ id: this.nextId("wa"), workerId: id, projectId, contractorId, startDate: effectiveDate, endDate: null, createdAt: this.now() });
    w.contractorId = contractorId;
    w.updatedAt = this.now();
  }

  // ---------- operators ----------

  async grantOperatorAccess(operatorId: string, projectId: string) {
    if (this.state.operatorAccess.some((a) => a.operatorId === operatorId && a.projectId === projectId && !a.revokedAt)) return;
    this.state.operatorAccess.push({ id: this.nextId("oa"), operatorId, projectId, grantedAt: this.now(), revokedAt: null });
  }

  async revokeOperatorAccess(operatorId: string, projectId: string) {
    for (const a of this.state.operatorAccess) {
      if (a.operatorId === operatorId && a.projectId === projectId && !a.revokedAt) a.revokedAt = this.now();
    }
  }

  async createOperator(input: { fullName: string; email: string }) {
    if (this.state.profiles.some((p) => p.email === input.email)) throw conflict("A user with this email already exists");
    const p: Profile = { id: this.nextId("u"), fullName: input.fullName, email: input.email, role: "operator", isActive: true, createdAt: this.now() };
    this.state.profiles.push(p);
    return clone(p);
  }

  async setProfileActive(id: string, isActive: boolean) {
    const p = this.state.profiles.find((x) => x.id === id);
    if (!p) throw notFound("User");
    p.isActive = isActive;
  }

  // ---------- payment rules (append-only) ----------

  async createPaymentRule(input: PaymentRuleFields, actor: Actor) {
    const version = Math.max(0, ...this.state.rules.filter((r) => r.contractorId === input.contractorId).map((r) => r.version)) + 1;
    const rule: PaymentRule = { ...input, id: this.nextId("r"), version, createdAt: this.now(), createdBy: actor.id };
    this.state.rules.push(rule);
    return clone(rule);
  }

  // ---------- attendance (atomic batch) ----------

  async saveAttendance(projectId: string, workDate: string, items: AttendanceWrite[], actor: Actor) {
    // Validate everything first, then apply — all-or-nothing like a DB transaction.
    const existing = new Map<string, AttendanceRecord>();
    for (const r of this.state.attendance) {
      if (r.projectId === projectId && r.workDate === workDate) existing.set(r.workerId, r);
    }
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.workerId)) throw invalid("The same worker appears twice in one save");
      seen.add(item.workerId);
      const rec = existing.get(item.workerId);
      if ((rec?.version ?? null) !== item.expectedVersion) {
        throw conflict("Attendance was changed by someone else. Reload to see the latest entries.");
      }
      if (!rec) {
        const assigned = this.state.assignments.some(
          (a) => a.workerId === item.workerId && a.projectId === projectId && a.contractorId === item.contractorId && assignmentCovers(a, workDate),
        );
        if (!assigned) throw invalid("Worker is not assigned to this project on this date");
      }
      if (item.status === "absent" && (item.checkInAt || item.checkOutAt)) throw invalid("Absent workers cannot have times");
      if (item.status === "present" && !item.checkInAt) throw invalid("Present workers need an IN time");
      if (item.checkOutAt && (!item.checkInAt || item.checkOutAt <= item.checkInAt)) throw invalid("OUT must be after IN");
    }

    const at = this.now();
    const saved: AttendanceRecord[] = [];
    for (const item of items) {
      const rec = existing.get(item.workerId);
      const newValues = { status: item.status, checkInAt: item.checkInAt, checkOutAt: item.checkOutAt };
      if (rec) {
        const oldValues = { status: rec.status, checkInAt: rec.checkInAt, checkOutAt: rec.checkOutAt };
        Object.assign(rec, newValues, { method: item.method, version: rec.version + 1, updatedAt: at, updatedBy: actor.id });
        this.audit(rec, "update", item.method, actor, oldValues, at);
        saved.push(clone(rec));
      } else {
        const rec2: AttendanceRecord = {
          id: this.nextId("a"), workerId: item.workerId, projectId, contractorId: item.contractorId, workDate,
          ...newValues, method: item.method, version: 1, createdAt: at, updatedAt: at, createdBy: actor.id, updatedBy: actor.id,
        };
        this.state.attendance.push(rec2);
        this.audit(rec2, "create", item.method, actor, null, at);
        saved.push(clone(rec2));
      }
    }
    return saved;
  }

  private audit(rec: AttendanceRecord, action: "create" | "update", method: AttendanceWrite["method"], actor: Actor, oldValues: AttendanceSnapshot | null, at: string) {
    this.state.audit.push({
      id: String(++this.state.seq.audit), attendanceId: rec.id, workerId: rec.workerId, projectId: rec.projectId,
      contractorId: rec.contractorId, workDate: rec.workDate, action, method, changedBy: actor.id, changedByRole: actor.role,
      changedAt: at, oldValues, newValues: { status: rec.status, checkInAt: rec.checkInAt, checkOutAt: rec.checkOutAt },
    });
  }
}

// One shared instance per server process (survives dev hot reloads).
const g = globalThis as unknown as { __nfDemoStore?: DemoStore };

export function getDemoStore(): DemoStore {
  if (!g.__nfDemoStore) g.__nfDemoStore = new DemoStore(createDemoState());
  return g.__nfDemoStore;
}

export function resetDemoStore(now?: Date): DemoStore {
  g.__nfDemoStore = new DemoStore(createDemoState(now));
  return g.__nfDemoStore;
}
