import type { AttendancePolicyVersion, ResolvedPolicy } from "@/lib/domain/policy";
import type {
  Actor,
  AttendanceRecord,
  AttendanceStatus,
  AuditLog,
  CheckInSource,
  ChangeMethod,
  Contractor,
  ContractorProjectAssignment,
  OperatorAccess,
  PaymentRule,
  Profile,
  Project,
  Worker,
  WorkerAssignment,
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
  method: ChangeMethod;
  expectedVersion: number | null;
}

export interface ProjectFields {
  name: string;
  location: string;
  isActive: boolean;
  timezone: string;
}

export type AttendancePolicyFields = Omit<AttendancePolicyVersion, "id" | "version" | "createdAt" | "createdBy">;

export type PaymentRuleFields = Omit<PaymentRule, "id" | "version" | "createdAt" | "createdBy">;

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
  /** Raw versions (history, notes, authors). Admin only: the live store returns none to operators. */
  listAttendancePolicies(): Promise<AttendancePolicyVersion[]>;
  /** The values in force for a site on a date. Callers check site access first. */
  getEffectivePolicy(projectId: string, date: string): Promise<ResolvedPolicy>;
  /** Project ids that have at least one attendance record (their timezone is locked). */
  listProjectsWithAttendance(): Promise<string[]>;
  listAuditLogs(q: AuditQuery): Promise<AuditLog[]>;

  createContractor(input: { name: string; location: string }, actor: Actor): Promise<Contractor>;
  updateContractor(id: string, input: { name: string; location: string; isActive: boolean }, actor: Actor): Promise<void>;
  setContractorPhoto(id: string, file: { bytes: Uint8Array; contentType: string }, actor: Actor): Promise<void>;

  createProject(input: ProjectFields, actor: Actor): Promise<Project>;
  updateProject(id: string, input: ProjectFields, actor: Actor): Promise<void>;
  addContractorToProject(contractorId: string, projectId: string, startDate: string, actor: Actor): Promise<void>;
  endContractorProject(assignmentId: string, endDate: string, actor: Actor): Promise<void>;

  createWorker(
    input: { fullName: string; contractorId: string; projectId: string; startDate: string; phone: string | null; notes: string | null },
    actor: Actor,
  ): Promise<Worker>;
  updateWorker(id: string, input: { fullName: string; phone: string | null; notes: string | null }, actor: Actor): Promise<void>;
  deactivateWorker(id: string, lastWorkingDate: string, actor: Actor): Promise<void>;
  reactivateWorker(id: string, projectId: string, startDate: string, actor: Actor): Promise<void>;
  transferWorker(id: string, projectId: string, contractorId: string, effectiveDate: string, actor: Actor): Promise<void>;

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
