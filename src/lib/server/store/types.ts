import type { MasterImportWrite } from "@/lib/domain/master-import";
import type { ConsentEvent, MessageStatus, MessagingSettings, OutboundMessage, WorkerContact } from "@/lib/domain/messaging";
import type { AttendancePolicyVersion, ResolvedPolicy } from "@/lib/domain/policy";
import type {
  Actor,
  AttendanceRecord,
  AttendanceStatus,
  AuditLog,
  CheckInSource,
  ChangeMethod,
  Contractor,
  ContractorIdentityStatus,
  ContractorProjectAssignment,
  ImportBatch,
  OperatorAccess,
  PaymentRule,
  Profile,
  Project,
  Shift,
  Worker,
  WorkerAssignment,
  WorkerPayTerms,
} from "@/lib/domain/types";

// Persistence boundary. Two implementations exist: the in-memory demo store
// and the Supabase store. Services perform authorization and validation and
// then call these methods; the Supabase store additionally relies on RLS and
// database functions so permissions are enforced even outside this app.

export interface AttendanceWrite {
  workerId: string;
  contractorId: string;
  status: AttendanceStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  checkInSource: CheckInSource | null;
  shift: Shift;
  method: ChangeMethod;
  expectedVersion: number | null;
}

export interface WorkerCreateFields {
  fullName: string;
  contractorId: string;
  projectId: string;
  startDate: string;
  employeeCode: string | null;
  department: string | null;
  designation: string | null;
  phone: string | null;
  notes: string | null;
}

export interface WorkerUpdateFields {
  fullName: string;
  employeeCode: string | null;
  department: string | null;
  designation: string | null;
  phone: string | null;
  notes: string | null;
}

export interface ProjectFields {
  name: string;
  location: string;
  isActive: boolean;
  timezone: string;
}

export type AttendancePolicyFields = Omit<AttendancePolicyVersion, "id" | "version" | "createdAt" | "createdBy">;

export type PaymentRuleFields = Omit<PaymentRule, "id" | "version" | "createdAt" | "createdBy">;

export type WorkerPayTermsFields = Omit<WorkerPayTerms, "id" | "version" | "createdAt" | "createdBy">;
/** A new pay terms version, optionally only if the latest version is still `basedOnVersion` (0 = none). */
export type WorkerPayTermsWrite = WorkerPayTermsFields & { basedOnVersion: number | null };

export type WorkerContactFields = Omit<WorkerContact, "updatedAt" | "updatedBy">;
export type MessagingSettingsFields = Omit<MessagingSettings, "updatedAt" | "updatedBy" | "lastScheduledRun">;
export type NewMessage = Omit<
  OutboundMessage,
  "id" | "status" | "attempts" | "nextAttemptAt" | "lastError" | "providerMessageId" | "transport" | "createdAt" | "sentAt" | "updatedAt" | "createdBy"
>;
/** The outcome of one send attempt. */
export type MessageResult =
  | { status: "sent"; providerMessageId: string; transport: "mock" | "cloud_api"; at: string }
  | { status: "queued" | "failed"; error: string; nextAttemptAt: string | null; transport: "mock" | "cloud_api"; at: string }
  /** no longer eligible when its turn came (consent withdrawn, attendance changed to absent...) */
  | { status: "cancelled"; error: string; nextAttemptAt: null; transport: "mock" | "cloud_api"; at: string };

export interface MasterImportResult {
  batchId: string;
  /** sheet ref → id of each contractor created by the import */
  contractorIds: Record<string, string>;
  created: number;
  updated: number;
}

export interface AttendanceQuery {
  projectIds?: string[];
  contractorId?: string | null;
  from: string;
  to: string;
}

export interface AuditQuery {
  projectIds?: string[];
  from?: string;
  to?: string;
  workerId?: string;
  limit: number;
}

export interface DataStore {
  readonly kind: "demo" | "supabase";

  getProfile(id: string): Promise<Profile | null>;
  listProfiles(): Promise<Profile[]>;
  listContractors(): Promise<Contractor[]>;
  listProjects(): Promise<Project[]>;
  listContractorProjects(): Promise<ContractorProjectAssignment[]>;
  listWorkers(): Promise<Worker[]>;
  listWorkerAssignments(): Promise<WorkerAssignment[]>;
  listOperatorAccess(): Promise<OperatorAccess[]>;
  listAttendance(q: AttendanceQuery): Promise<AttendanceRecord[]>;
  listPaymentRules(): Promise<PaymentRule[]>;
  /** Admin only. */
  listWorkerPayTerms(): Promise<WorkerPayTerms[]>;
  /** Admin only. */
  listImportBatches(): Promise<ImportBatch[]>;
  /** Raw versions (history, notes, authors). Admin only: the live store returns none to operators. */
  listAttendancePolicies(): Promise<AttendancePolicyVersion[]>;
  /** The values in force for a site on a date. Callers check site access first. */
  getEffectivePolicy(projectId: string, date: string): Promise<ResolvedPolicy>;
  /** Project ids that have at least one attendance record (their timezone is locked). */
  listProjectsWithAttendance(): Promise<string[]>;
  listAuditLogs(q: AuditQuery): Promise<AuditLog[]>;

  createContractor(input: { name: string; location: string | null }, actor: Actor): Promise<Contractor>;
  updateContractor(id: string, input: { name: string; location: string | null; isActive: boolean }, actor: Actor): Promise<void>;
  setContractorPhoto(id: string, file: { bytes: Uint8Array; contentType: string }, actor: Actor): Promise<void>;
  setContractorIdentity(
    id: string,
    input: { legalName: string | null; identityStatus: ContractorIdentityStatus; identityNote: string | null },
    actor: Actor,
  ): Promise<void>;

  createProject(input: ProjectFields, actor: Actor): Promise<Project>;
  updateProject(id: string, input: ProjectFields, actor: Actor): Promise<void>;
  addContractorToProject(contractorId: string, projectId: string, startDate: string, actor: Actor): Promise<void>;
  endContractorProject(assignmentId: string, endDate: string, actor: Actor): Promise<void>;

  createWorker(input: WorkerCreateFields, actor: Actor): Promise<Worker>;
  updateWorker(id: string, input: WorkerUpdateFields, actor: Actor): Promise<void>;
  deactivateWorker(id: string, lastWorkingDate: string, actor: Actor): Promise<void>;
  reactivateWorker(id: string, projectId: string, startDate: string, actor: Actor): Promise<void>;
  transferWorker(id: string, projectId: string, contractorId: string, effectiveDate: string, actor: Actor): Promise<void>;
  /** First plant for active workers that have none. All or nothing. */
  assignWorkers(workerIds: string[], projectId: string, startDate: string, actor: Actor): Promise<number>;
  /** Appends one pay terms version per item, all or nothing. */
  createWorkerPayTerms(inputs: WorkerPayTermsWrite[], actor: Actor): Promise<WorkerPayTerms[]>;
  /** Applies a previewed worker master import atomically. */
  applyMasterImport(write: MasterImportWrite, actor: Actor): Promise<MasterImportResult>;

  // ---------- WhatsApp messaging (admin, and the server-side dispatcher) ----------
  listWorkerContacts(): Promise<WorkerContact[]>;
  /** Upserts contacts; a consent change is also written to the consent history. */
  saveWorkerContacts(items: WorkerContactFields[], actor: Actor): Promise<void>;
  listConsentEvents(workerId?: string): Promise<ConsentEvent[]>;
  getMessagingSettings(): Promise<MessagingSettings | null>;
  saveMessagingSettings(input: MessagingSettingsFields, actor: Actor): Promise<MessagingSettings>;
  setLastScheduledRun(date: string): Promise<void>;
  listMessages(q: { limit: number; statuses?: MessageStatus[] }): Promise<OutboundMessage[]>;
  /** Inserts messages whose idempotency key is new; returns only those inserted. */
  enqueueMessages(items: NewMessage[], actor: Actor | null): Promise<OutboundMessage[]>;
  /**
   * Marks due queued messages as sending (one more attempt) and returns them, so two
   * dispatchers never send the same message. A message left "sending" for over 10
   * minutes is marked failed for an admin to check, never re-sent automatically.
   */
  claimDueMessages(now: string, limit: number): Promise<OutboundMessage[]>;
  /** Claims one queued message (as claimDueMessages does); null when it is not queued. */
  claimMessage(id: string, now: string): Promise<OutboundMessage | null>;
  /** Updates a message being sent with text rebuilt from the current attendance record. */
  refreshMessage(id: string, patch: Pick<OutboundMessage, "to" | "language" | "params" | "body" | "attendanceVersion">): Promise<void>;
  completeMessage(id: string, result: MessageResult): Promise<void>;
  /** Delivery status from the provider; only ever moves forward. False when no message matches. */
  applyMessageStatus(providerMessageId: string, status: "sent" | "delivered" | "read" | "failed", at: string, error: string | null, payload?: unknown): Promise<boolean>;
  /** Puts failed messages back in the queue; returns how many. */
  requeueFailed(): Promise<number>;

  grantOperatorAccess(operatorId: string, projectId: string, actor: Actor): Promise<void>;
  revokeOperatorAccess(operatorId: string, projectId: string, actor: Actor): Promise<void>;
  createOperator(input: { fullName: string; email: string; password?: string }, actor: Actor): Promise<Profile>;
  setProfileActive(id: string, isActive: boolean, actor: Actor): Promise<void>;

  createPaymentRule(input: PaymentRuleFields, actor: Actor): Promise<PaymentRule>;
  /** Appends a new version; existing versions are never changed. */
  createAttendancePolicy(input: AttendancePolicyFields, actor: Actor): Promise<AttendancePolicyVersion>;

  /** Atomic: either every item is written (with audit entries) or none are. */
  saveAttendance(projectId: string, workDate: string, items: AttendanceWrite[], actor: Actor): Promise<AttendanceRecord[]>;
}
