import { conflict, invalid, notFound } from "@/lib/errors";
import { resolvePolicy, type AttendancePolicyVersion } from "@/lib/domain/policy";
import { addDays } from "@/lib/domain/time";
import { assignmentCovers } from "@/lib/domain/register";
import type { MasterImportWrite } from "@/lib/domain/master-import";
import { STATUS_ORDER, type MessageStatus, type OutboundMessage } from "@/lib/domain/messaging";
import type {
  Actor,
  AttendanceRecord,
  AttendanceSnapshot,
  Contractor,
  ContractorIdentityStatus,
  PaymentRule,
  Profile,
  Project,
  Worker,
  WorkerPayTerms,
} from "@/lib/domain/types";
import { createDemoState, type DemoState } from "./demo-seed";
import type {
  AttendancePolicyFields,
  AttendanceQuery,
  AttendanceWrite,
  AuditQuery,
  DataStore,
  MasterImportResult,
  MessageResult,
  MessagingSettingsFields,
  NewMessage,
  PaymentRuleFields,
  ProjectFields,
  WorkerContactFields,
  WorkerCreateFields,
  WorkerPayTermsFields,
  WorkerPayTermsWrite,
  WorkerUpdateFields,
} from "./types";

// In-memory store used only in demo mode. It mirrors the database constraints
// (unique attendance per worker/project/date, non-overlapping assignments,
// optimistic versions, immutable rule versions, append-only audit log) so the
// demo behaves like production (including append-only attendance policy versions
// and the timezone lock). Data lives in server memory and resets on restart.

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
  async listWorkerPayTerms() {
    return clone(this.state.payTerms);
  }
  async listImportBatches() {
    return clone(this.state.importBatches);
  }
  async listAttendancePolicies() {
    return clone(this.state.policies);
  }
  async getEffectivePolicy(projectId: string, date: string) {
    return resolvePolicy(this.state.policies, projectId, date);
  }
  async listProjectsWithAttendance() {
    return [...new Set(this.state.attendance.map((r) => r.projectId))];
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

  async createContractor(input: { name: string; location: string | null }) {
    const at = this.now();
    const c: Contractor = {
      id: this.nextId("c"), name: input.name, location: input.location, legalName: null, identityStatus: "confirmed", identityNote: null,
      photoPath: null, photoUrl: null, isActive: true, createdAt: at, updatedAt: at,
    };
    this.state.contractors.push(c);
    return clone(c);
  }

  async updateContractor(id: string, input: { name: string; location: string | null; isActive: boolean }) {
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

  async setContractorIdentity(id: string, input: { legalName: string | null; identityStatus: ContractorIdentityStatus; identityNote: string | null }) {
    const c = this.state.contractors.find((x) => x.id === id);
    if (!c) throw notFound("Contractor");
    Object.assign(c, input, { updatedAt: this.now() });
  }

  async createProject(input: ProjectFields) {
    const at = this.now();
    const p: Project = { id: this.nextId("p"), ...input, createdAt: at, updatedAt: at };
    this.state.projects.push(p);
    return clone(p);
  }

  async updateProject(id: string, input: ProjectFields) {
    const p = this.state.projects.find((x) => x.id === id);
    if (!p) throw notFound("Plant");
    if (input.timezone !== p.timezone && this.state.attendance.some((r) => r.projectId === id)) {
      throw invalid("The timezone cannot be changed after attendance has been recorded at this plant");
    }
    Object.assign(p, input, { updatedAt: this.now() });
  }

  async addContractorToProject(contractorId: string, projectId: string, startDate: string) {
    const open = this.state.contractorProjects.find(
      (a) => a.contractorId === contractorId && a.projectId === projectId && a.endDate === null,
    );
    if (open) throw conflict("This contractor is already assigned to this plant");
    this.state.contractorProjects.push({ id: this.nextId("cp"), contractorId, projectId, startDate, endDate: null });
  }

  async endContractorProject(assignmentId: string, endDate: string) {
    const a = this.state.contractorProjects.find((x) => x.id === assignmentId);
    if (!a) throw notFound("Assignment");
    const activeWorkers = this.state.assignments.filter(
      (w) => w.projectId === a.projectId && w.contractorId === a.contractorId && (w.endDate === null || w.endDate > endDate),
    );
    if (activeWorkers.length > 0)
      throw invalid(`Move or deactivate the ${activeWorkers.length} worker(s) still assigned here first`);
    a.endDate = endDate < a.startDate ? a.startDate : endDate;
  }

  // ---------- workers ----------

  private assertNoOverlap(workerId: string, startDate: string, endDate: string | null, ignoreId?: string) {
    for (const a of this.state.assignments) {
      if (a.workerId !== workerId || a.id === ignoreId) continue;
      const overlaps = a.startDate <= (endDate ?? "9999-12-31") && startDate <= (a.endDate ?? "9999-12-31");
      if (overlaps) throw conflict("Worker already has a plant assignment for these dates");
    }
  }

  async createWorker(input: WorkerCreateFields) {
    const at = this.now();
    const seq = ++this.state.seq.worker;
    const w: Worker = {
      id: this.nextId("w"), code: `W-${String(seq).padStart(5, "0")}`, employeeCode: input.employeeCode, fullName: input.fullName,
      contractorId: input.contractorId, department: input.department, designation: input.designation,
      isActive: true, phone: input.phone, notes: input.notes, source: null, createdAt: at, updatedAt: at,
    };
    this.assertEmployeeCodeFree(input.contractorId, input.employeeCode, w.id);
    this.state.workers.push(w);
    this.state.assignments.push({
      id: this.nextId("wa"), workerId: w.id, projectId: input.projectId, contractorId: input.contractorId,
      startDate: input.startDate, endDate: null, createdAt: at,
    });
    return clone(w);
  }

  async updateWorker(id: string, input: WorkerUpdateFields) {
    const w = this.state.workers.find((x) => x.id === id);
    if (!w) throw notFound("Worker");
    this.assertEmployeeCodeFree(w.contractorId, input.employeeCode, id);
    Object.assign(w, input, { updatedAt: this.now() });
  }

  /** Mirrors the unique (contractor, employee code) index. */
  private assertEmployeeCodeFree(contractorId: string, employeeCode: string | null, workerId: string) {
    if (employeeCode === null) return;
    const clash = this.state.workers.find((x) => x.contractorId === contractorId && x.employeeCode === employeeCode && x.id !== workerId);
    if (clash) throw conflict(`Employee ID ${employeeCode} already belongs to ${clash.fullName} (${clash.code})`);
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

  async assignWorkers(workerIds: string[], projectId: string, startDate: string) {
    // Validate all, then write: all or nothing.
    const workers = workerIds.map((id) => this.state.workers.find((x) => x.id === id));
    if (workers.some((w) => !w) || new Set(workerIds).size !== workerIds.length) throw invalid("Some workers were not found");
    for (const w of workers as Worker[]) {
      if (!w.isActive) throw invalid(`${w.fullName} is inactive. Reactivate instead.`);
      if (this.state.assignments.some((a) => a.workerId === w.id && (a.endDate === null || a.endDate >= startDate)))
        throw invalid(`${w.fullName} already has a plant from ${startDate}. Use Transfer instead.`);
      const onPlant = this.state.contractorProjects.some((a) => a.contractorId === w.contractorId && a.projectId === projectId && assignmentCovers(a, startDate));
      if (!onPlant) throw invalid("This contractor is not assigned to that plant. Assign the contractor to the plant first.");
    }
    const at = this.now();
    for (const w of workers as Worker[]) {
      this.state.assignments.push({ id: this.nextId("wa"), workerId: w.id, projectId, contractorId: w.contractorId, startDate, endDate: null, createdAt: at });
    }
    return workers.length;
  }

  private assertPayTermsDate(workerId: string, effectiveFrom: string) {
    const latest = this.state.payTerms.filter((t) => t.workerId === workerId).reduce<string | null>((m, t) => (m === null || t.effectiveFrom > m ? t.effectiveFrom : m), null);
    if (latest !== null && effectiveFrom < latest) throw invalid(`Pay terms from ${latest} already exist; a new version must start on or after that date`);
  }

  private pushPayTerms(input: WorkerPayTermsFields, actor: Actor, at: string): WorkerPayTerms {
    const version = Math.max(0, ...this.state.payTerms.filter((t) => t.workerId === input.workerId).map((t) => t.version)) + 1;
    const row: WorkerPayTerms = { ...input, id: this.nextId("pt"), version, createdAt: at, createdBy: actor.id };
    this.state.payTerms.push(row);
    return row;
  }

  async createWorkerPayTerms(inputs: WorkerPayTermsWrite[], actor: Actor) {
    for (const input of inputs) {
      if (!this.state.workers.some((w) => w.id === input.workerId)) throw notFound("Worker");
      this.assertPayTermsDate(input.workerId, input.effectiveFrom);
      const current = Math.max(0, ...this.state.payTerms.filter((t) => t.workerId === input.workerId).map((t) => t.version));
      if (input.basedOnVersion !== null && input.basedOnVersion !== current) {
        throw conflict(`This worker's pay terms were changed meanwhile (now version ${current}). Reload and try again.`);
      }
    }
    if (new Set(inputs.map((i) => i.workerId)).size !== inputs.length) throw invalid("The same worker appears twice");
    const at = this.now();
    return clone(inputs.map(({ basedOnVersion: _b, ...input }) => (void _b, this.pushPayTerms(input, actor, at))));
  }

  async applyMasterImport(write: MasterImportWrite, actor: Actor): Promise<MasterImportResult> {
    // Validate everything first (like the database transaction), then apply.
    const lastBatch = this.state.importBatches.filter((b) => b.kind === "worker_master").at(-1)?.id ?? null;
    if (lastBatch !== write.batch.expectedLastBatchId) throw conflict("Another import was applied after this preview. Preview again before importing.");
    const refs = new Set(write.contractors.map((c) => c.ref));
    const codeTaken = new Set(this.state.workers.filter((w) => w.employeeCode).map((w) => `${w.contractorId}|${w.employeeCode}`));
    const newCodes = new Set<string>();
    for (const c of write.creates) {
      if ("ref" in c.contractor ? !refs.has(c.contractor.ref) : !this.state.contractors.some((x) => x.id === (c.contractor as { id: string }).id))
        throw invalid("An imported worker has no contractor");
      const key = `${"ref" in c.contractor ? `ref:${c.contractor.ref}` : c.contractor.id}|${c.employeeCode}`;
      if (codeTaken.has(key) || newCodes.has(key)) throw conflict(`Employee ID ${c.employeeCode} already exists for this contractor`);
      newCodes.add(key);
      if (c.employeeCode !== c.employeeCode.trim() || c.employeeCode.length === 0 || c.employeeCode.length > 40) throw invalid(`Employee ID "${c.employeeCode}" is not valid`);
    }
    for (const u of write.updates) {
      const w = this.state.workers.find((x) => x.id === u.workerId);
      if (!w) throw invalid("A worker in this import no longer exists");
      const termsVersion = Math.max(0, ...this.state.payTerms.filter((t) => t.workerId === u.workerId).map((t) => t.version));
      if (w.fullName !== u.expected.fullName || w.department !== u.expected.department || w.designation !== u.expected.designation || termsVersion !== u.expected.termsVersion) {
        throw conflict(`${w.fullName} was changed after this preview. Preview again before importing.`);
      }
      if (u.payTerms) this.assertPayTermsDate(u.workerId, u.payTerms.effectiveFrom);
    }

    const at = this.now();
    const batchId = this.nextId("ib");
    this.state.importBatches.push({ id: batchId, kind: "worker_master", fileName: write.batch.fileName, fileHash: write.batch.fileHash, summary: clone(write.batch.summary), createdAt: at, createdBy: actor.id });
    const contractorIds: Record<string, string> = {};
    for (const c of write.contractors) {
      const id = this.nextId("c");
      contractorIds[c.ref] = id;
      this.state.contractors.push({
        id, name: c.name, location: null, legalName: c.legalName, identityStatus: c.identityStatus, identityNote: c.identityNote,
        photoPath: null, photoUrl: null, isActive: true, createdAt: at, updatedAt: at,
      });
    }
    for (const c of write.creates) {
      const contractorId = "ref" in c.contractor ? contractorIds[c.contractor.ref] : c.contractor.id;
      const seq = ++this.state.seq.worker;
      const w: Worker = {
        id: this.nextId("w"), code: `W-${String(seq).padStart(5, "0")}`, employeeCode: c.employeeCode, fullName: c.fullName.trim(), contractorId,
        department: c.department, designation: c.designation, isActive: true, phone: null, notes: null, source: c.source, createdAt: at, updatedAt: at,
      };
      this.state.workers.push(w);
      this.pushPayTerms({ workerId: w.id, effectiveFrom: c.payTerms.effectiveFrom, rateAmount: c.payTerms.rateAmount, rateBasis: c.payTerms.rateBasis, commissionEligible: null, source: c.payTerms.source, notes: null }, actor, at);
    }
    for (const u of write.updates) {
      const w = this.state.workers.find((x) => x.id === u.workerId)!;
      if (u.fields) Object.assign(w, { fullName: u.fields.fullName.trim(), department: u.fields.department, designation: u.fields.designation, updatedAt: at });
      if (u.payTerms) this.pushPayTerms({ workerId: w.id, ...u.payTerms, notes: null }, actor, at);
    }
    return { batchId, contractorIds, created: write.creates.length, updated: write.updates.length };
  }

  // ---------- WhatsApp messaging ----------

  async listWorkerContacts() {
    return clone(this.state.contacts);
  }

  async saveWorkerContacts(items: WorkerContactFields[], actor: Actor) {
    for (const item of items) if (!this.state.workers.some((w) => w.id === item.workerId)) throw notFound("Worker");
    const at = this.now();
    for (const item of items) {
      const existing = this.state.contacts.find((c) => c.workerId === item.workerId);
      const before = existing?.consentStatus ?? "unknown";
      if (existing) Object.assign(existing, item, { updatedAt: at, updatedBy: actor.id });
      else this.state.contacts.push({ ...item, updatedAt: at, updatedBy: actor.id });
      if (item.consentStatus !== before) {
        this.state.consentEvents.push({ id: this.nextId("ce"), workerId: item.workerId, consentStatus: item.consentStatus, source: item.consentSource, at, by: actor.id });
      }
    }
  }

  async listConsentEvents(workerId?: string) {
    return clone(this.state.consentEvents.filter((e) => !workerId || e.workerId === workerId));
  }

  async getMessagingSettings() {
    return clone(this.state.messaging);
  }

  async saveMessagingSettings(input: MessagingSettingsFields, actor: Actor) {
    this.state.messaging = { ...input, lastScheduledRun: this.state.messaging?.lastScheduledRun ?? null, updatedAt: this.now(), updatedBy: actor.id };
    return clone(this.state.messaging);
  }

  async setLastScheduledRun(date: string) {
    if (this.state.messaging) this.state.messaging.lastScheduledRun = date;
  }

  async listMessages(q: { limit: number; statuses?: MessageStatus[] }) {
    return clone(
      this.state.messages
        .filter((m) => !q.statuses || q.statuses.includes(m.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, q.limit),
    );
  }

  async enqueueMessages(items: NewMessage[], actor: Actor | null) {
    const at = this.now();
    const keys = new Set(this.state.messages.map((m) => m.idempotencyKey));
    const added: OutboundMessage[] = [];
    for (const item of items) {
      if (keys.has(item.idempotencyKey)) continue; // never twice
      keys.add(item.idempotencyKey);
      const m: OutboundMessage = {
        ...item, id: this.nextId("msg"), status: "queued", attempts: 0, nextAttemptAt: null, lastError: null, providerMessageId: null,
        transport: null, createdAt: at, sentAt: null, updatedAt: at, createdBy: actor?.id ?? null,
      };
      this.state.messages.push(m);
      added.push(m);
    }
    return clone(added);
  }

  async claimDueMessages(now: string, limit: number) {
    const staleBefore = new Date(Date.parse(now) - 10 * 60_000).toISOString();
    for (const m of this.state.messages) {
      if (m.status === "sending" && m.updatedAt < staleBefore) {
        Object.assign(m, { status: "failed", lastError: "Sending was interrupted. Check whether it arrived before retrying.", nextAttemptAt: null, updatedAt: now });
      }
    }
    const due = this.state.messages
      .filter((m) => m.status === "queued" && (m.nextAttemptAt === null || m.nextAttemptAt <= now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
    for (const m of due) Object.assign(m, { status: "sending", attempts: m.attempts + 1, updatedAt: now });
    return clone(due);
  }

  async claimMessage(id: string, now: string) {
    const m = this.state.messages.find((x) => x.id === id && x.status === "queued");
    if (!m) return null;
    Object.assign(m, { status: "sending", attempts: m.attempts + 1, updatedAt: now });
    return clone(m);
  }

  async refreshMessage(id: string, patch: Pick<OutboundMessage, "to" | "language" | "params" | "body" | "attendanceVersion">) {
    const m = this.state.messages.find((x) => x.id === id && x.status === "sending");
    if (m) Object.assign(m, clone(patch));
  }

  async completeMessage(id: string, result: MessageResult) {
    const m = this.state.messages.find((x) => x.id === id);
    if (!m) throw notFound("Message");
    if (result.status === "sent") {
      Object.assign(m, { status: "sent", providerMessageId: result.providerMessageId, transport: result.transport, sentAt: result.at, lastError: null, nextAttemptAt: null, updatedAt: result.at });
      for (const e of this.state.earlyStatuses.filter((x) => x.providerMessageId === result.providerMessageId)) applyStatus(m, e.status, e.at, e.error);
      this.state.earlyStatuses = this.state.earlyStatuses.filter((x) => x.providerMessageId !== result.providerMessageId);
    } else Object.assign(m, { status: result.status, lastError: result.error, nextAttemptAt: result.nextAttemptAt, transport: result.transport, updatedAt: result.at });
  }

  async applyMessageStatus(providerMessageId: string, status: "sent" | "delivered" | "read" | "failed", at: string, error: string | null) {
    const m = this.state.messages.find((x) => x.providerMessageId === providerMessageId);
    if (!m) {
      // A status can arrive before the send result is saved: kept and applied then.
      this.state.earlyStatuses.push({ providerMessageId, status, at, error });
      return false;
    }
    applyStatus(m, status, at, error);
    return true;
  }

  async requeueFailed() {
    let n = 0;
    for (const m of this.state.messages) {
      if (m.status !== "failed") continue;
      Object.assign(m, { status: "queued", nextAttemptAt: null, attempts: 0, updatedAt: this.now() });
      n++;
    }
    return n;
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

  // ---------- attendance policies (append-only versions) ----------

  async createAttendancePolicy(input: AttendancePolicyFields, actor: Actor) {
    const version = Math.max(0, ...this.state.policies.filter((v) => v.projectId === input.projectId).map((v) => v.version)) + 1;
    const row: AttendancePolicyVersion = { ...clone(input), id: this.nextId("pol"), version, createdAt: this.now(), createdBy: actor.id };
    this.state.policies.push(row);
    return clone(row);
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
      if (rec && rec.shift !== item.shift) throw invalid(`This worker is recorded on the ${rec.shift} shift for this date. Open that shift to change it.`);
      if (!rec) {
        const assigned = this.state.assignments.some(
          (a) => a.workerId === item.workerId && a.projectId === projectId && a.contractorId === item.contractorId && assignmentCovers(a, workDate),
        );
        if (!assigned) throw invalid("Worker is not assigned to this plant on this date");
      }
      if (item.status === "absent" && (item.checkInAt || item.checkOutAt)) throw invalid("Absent workers cannot have times");
      if (item.status === "present" && !item.checkInAt) throw invalid("Present workers need an IN time");
      if (item.status !== "present" && item.checkInSource) throw invalid("Only present workers have an IN source");
      if (item.checkOutAt && (!item.checkInAt || item.checkOutAt <= item.checkInAt)) throw invalid("OUT must be after IN");
    }

    const at = this.now();
    const saved: AttendanceRecord[] = [];
    for (const item of items) {
      const rec = existing.get(item.workerId);
      const newValues = { status: item.status, checkInAt: item.checkInAt, checkOutAt: item.checkOutAt, checkInSource: item.checkInSource, shift: item.shift };
      if (rec) {
        const oldValues = { status: rec.status, checkInAt: rec.checkInAt, checkOutAt: rec.checkOutAt, checkInSource: rec.checkInSource, shift: rec.shift };
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
      changedAt: at, oldValues, newValues: { status: rec.status, checkInAt: rec.checkInAt, checkOutAt: rec.checkOutAt, checkInSource: rec.checkInSource, shift: rec.shift },
    });
  }
}

/**
 * Provider statuses only move forward (sent → delivered → read). A failure reported
 * after "sent" is recorded and final: a late or replayed "sent" never hides it.
 */
function applyStatus(m: OutboundMessage, status: "sent" | "delivered" | "read" | "failed", at: string, error: string | null) {
  if (m.status === "failed" || m.status === "cancelled") return;
  if (status === "failed" ? STATUS_ORDER[m.status] >= STATUS_ORDER.sent : STATUS_ORDER[status] > STATUS_ORDER[m.status]) {
    Object.assign(m, { status, lastError: status === "failed" ? error : m.lastError, updatedAt: at });
  }
}

// One shared instance per server process (survives dev hot reloads).
const g = globalThis as unknown as { __nfDemoStore?: DemoStore };

export function getDemoStore(): DemoStore {
  // After a dev reload the old instance may come from an older version of this class
  // (missing newer methods); it is then replaced with fresh demo data. (Not an
  // instanceof check: pages and route handlers are separate bundles with their own
  // copy of the class, and must share one store.)
  const current = g.__nfDemoStore as unknown as Record<string, unknown> | undefined;
  const stale = !current || Object.getOwnPropertyNames(DemoStore.prototype).some((m) => typeof current[m] !== "function");
  if (stale) g.__nfDemoStore = new DemoStore(createDemoState());
  return g.__nfDemoStore!;
}

export function resetDemoStore(now?: Date): DemoStore {
  g.__nfDemoStore = new DemoStore(createDemoState(now));
  return g.__nfDemoStore;
}
