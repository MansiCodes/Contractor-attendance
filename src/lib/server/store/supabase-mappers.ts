import { POLICY_FIELDS, type AttendancePolicyVersion, type PolicyField, type ResolvedPolicy } from "@/lib/domain/policy";
import type {
  AttendanceRecord,
  AttendanceSnapshot,
  AuditLog,
  Contractor,
  ContractorProjectAssignment,
  OperatorAccess,
  PaymentRule,
  Profile,
  Project,
  Worker,
  WorkerAssignment,
} from "@/lib/domain/types";
import type { AttendancePolicyFields, PaymentRuleFields, ProjectFields } from "./types";

// Pure conversions between Postgres rows (snake_case) and domain objects.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows come untyped from PostgREST
export type Row = Record<string, any>;

const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);
const isoReq = (v: string) => new Date(v).toISOString();
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/** "HH:mm:ss" (Postgres time) → "HH:mm" */
const hhmm = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, 5));
/** Postgres date as "yyyy-MM-dd" (PostgREST sends a string; PGlite a Date at UTC midnight) */
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

export const profile = (r: Row): Profile => ({
  id: r.id,
  fullName: r.full_name,
  email: r.email,
  role: r.role,
  isActive: r.is_active,
  createdAt: isoReq(r.created_at),
});

export const contractor = (r: Row): Contractor => ({
  id: r.id,
  name: r.name,
  location: r.location,
  photoPath: r.photo_path ?? null,
  photoUrl: null,
  isActive: r.is_active,
  createdAt: isoReq(r.created_at),
  updatedAt: isoReq(r.updated_at),
});

export const project = (r: Row): Project => ({
  id: r.id,
  name: r.name,
  location: r.location,
  isActive: r.is_active,
  timezone: r.timezone,
  createdAt: isoReq(r.created_at),
  updatedAt: isoReq(r.updated_at),
});

export const projectFields = (p: ProjectFields): Row => ({
  name: p.name,
  location: p.location,
  is_active: p.isActive,
  timezone: p.timezone,
});

export const contractorProject = (r: Row): ContractorProjectAssignment => ({
  id: r.id,
  contractorId: r.contractor_id,
  projectId: r.project_id,
  startDate: r.start_date,
  endDate: r.end_date ?? null,
});

export const worker = (r: Row): Worker => ({
  id: r.id,
  code: r.worker_code,
  fullName: r.full_name,
  contractorId: r.contractor_id,
  isActive: r.is_active,
  phone: r.phone ?? null,
  notes: r.notes ?? null,
  createdAt: isoReq(r.created_at),
  updatedAt: isoReq(r.updated_at),
});

export const workerAssignment = (r: Row): WorkerAssignment => ({
  id: r.id,
  workerId: r.worker_id,
  projectId: r.project_id,
  contractorId: r.contractor_id,
  startDate: r.start_date,
  endDate: r.end_date ?? null,
  createdAt: isoReq(r.created_at),
});

export const operatorAccess = (r: Row): OperatorAccess => ({
  id: r.id,
  operatorId: r.operator_id,
  projectId: r.project_id,
  grantedAt: isoReq(r.granted_at),
  revokedAt: iso(r.revoked_at),
});

export const attendance = (r: Row): AttendanceRecord => ({
  id: r.id,
  workerId: r.worker_id,
  projectId: r.project_id,
  contractorId: r.contractor_id,
  workDate: r.work_date,
  status: r.status,
  checkInAt: iso(r.check_in_at),
  checkOutAt: iso(r.check_out_at),
  checkInSource: r.check_in_source ?? null,
  method: r.method,
  version: Number(r.version),
  createdAt: isoReq(r.created_at),
  updatedAt: isoReq(r.updated_at),
  createdBy: r.created_by ?? null,
  updatedBy: r.updated_by ?? null,
});

export const paymentRule = (r: Row): PaymentRule => ({
  id: r.id,
  contractorId: r.contractor_id,
  version: Number(r.version),
  effectiveFrom: r.effective_from,
  rateType: r.rate_type,
  dayRate: num(r.day_rate),
  hourRate: num(r.hour_rate),
  fullDayHours: num(r.full_day_hours),
  halfDayHours: num(r.half_day_hours),
  overtimeEnabled: r.overtime_enabled,
  overtimeAfterHours: num(r.overtime_after_hours),
  overtimeHourRate: num(r.overtime_hour_rate),
  unpaidBreakMinutes: Number(r.unpaid_break_minutes),
  notes: r.notes ?? null,
  createdAt: isoReq(r.created_at),
  createdBy: r.created_by ?? null,
});

export const paymentRuleFields = (f: PaymentRuleFields): Row => ({
  contractor_id: f.contractorId,
  effective_from: f.effectiveFrom,
  rate_type: f.rateType,
  day_rate: f.dayRate,
  hour_rate: f.hourRate,
  full_day_hours: f.fullDayHours,
  half_day_hours: f.halfDayHours,
  overtime_enabled: f.overtimeEnabled,
  overtime_after_hours: f.overtimeAfterHours,
  overtime_hour_rate: f.overtimeHourRate,
  unpaid_break_minutes: f.unpaidBreakMinutes,
  notes: f.notes,
});

// Entries written before check-in sources were tracked lack that key: it stays undefined.
const snapshot = (v: Row | null): AttendanceSnapshot | null =>
  v
    ? {
        status: v.status,
        checkInAt: iso(v.check_in_at),
        checkOutAt: iso(v.check_out_at),
        ...("check_in_source" in v ? { checkInSource: v.check_in_source ?? null } : {}),
      }
    : null;

export const auditLog = (r: Row): AuditLog => ({
  id: String(r.id),
  attendanceId: r.attendance_id,
  workerId: r.worker_id,
  projectId: r.project_id,
  contractorId: r.contractor_id,
  workDate: r.work_date,
  action: r.action,
  method: r.method,
  changedBy: r.changed_by ?? null,
  changedByRole: r.changed_by_role ?? null,
  changedAt: isoReq(r.changed_at),
  oldValues: snapshot(r.old_values),
  newValues: snapshot(r.new_values)!,
});

// ---------- attendance policies ----------

const snake = (f: PolicyField) => f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const TIME_FIELDS = new Set<PolicyField>(["suggestedCheckIn", "shiftStart", "shiftEnd", "editCutoffTime"]);
const BOOL_FIELDS = new Set<PolicyField>(["allowOvernight", "autoAbsentEnabled"]);

export const policyRow = (r: Row): AttendancePolicyVersion => {
  const values = {} as Record<PolicyField, unknown>;
  for (const f of POLICY_FIELDS) {
    const v = r[snake(f)];
    values[f] = TIME_FIELDS.has(f) ? hhmm(v) : BOOL_FIELDS.has(f) ? (v ?? null) : num(v);
  }
  const isCompany = r.project_id === null || r.project_id === undefined;
  const overridden = ((r.overridden ?? []) as string[]).map((k) => POLICY_FIELDS.find((f) => snake(f) === k)).filter((f): f is PolicyField => !!f);
  return {
    ...(values as Omit<AttendancePolicyVersion, "id">),
    id: r.id,
    projectId: isCompany ? null : r.project_id,
    version: Number(r.version),
    effectiveFrom: day(r.effective_from),
    overridden: isCompany ? [...POLICY_FIELDS] : overridden,
    defaultTimezone: r.default_timezone ?? null,
    notes: r.notes ?? null,
    createdAt: isoReq(r.created_at),
    createdBy: r.created_by ?? null,
  };
};

/** Row of public.attendance_policy_for() (the resolved values, no history). */
export const effectivePolicy = (r: Row): ResolvedPolicy => {
  const values = {} as Record<PolicyField, unknown>;
  for (const f of POLICY_FIELDS) {
    const v = r[snake(f)];
    values[f] = TIME_FIELDS.has(f) ? hhmm(v) : BOOL_FIELDS.has(f) ? Boolean(v) : num(v);
  }
  return { ...(values as unknown as ResolvedPolicy), companyPolicyId: r.company_policy_id ?? null, sitePolicyId: r.site_policy_id ?? null };
};

export const policyFields = (f: AttendancePolicyFields): Row => {
  const row: Row = {
    project_id: f.projectId,
    effective_from: f.effectiveFrom,
    // Company rows set every field; only site rows list their overrides.
    overridden: f.projectId === null ? [] : f.overridden.map(snake),
    default_timezone: f.defaultTimezone,
    notes: f.notes,
  };
  for (const k of POLICY_FIELDS) row[snake(k)] = f[k];
  return row;
};
