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
import type { PaymentRuleFields, ProjectFields } from "./types";

// Pure conversions between Postgres rows (snake_case) and domain objects.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows come untyped from PostgREST
export type Row = Record<string, any>;

const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);
const isoReq = (v: string) => new Date(v).toISOString();
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

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
  defaultCheckIn: String(r.default_check_in).slice(0, 5),
  allowOvernight: r.allow_overnight,
  operatorBackdateDays: Number(r.operator_backdate_days),
  createdAt: isoReq(r.created_at),
  updatedAt: isoReq(r.updated_at),
});

export const projectFields = (p: ProjectFields): Row => ({
  name: p.name,
  location: p.location,
  is_active: p.isActive,
  timezone: p.timezone,
  default_check_in: p.defaultCheckIn,
  allow_overnight: p.allowOvernight,
  operator_backdate_days: p.operatorBackdateDays,
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

const snapshot = (v: Row | null): AttendanceSnapshot | null =>
  v ? { status: v.status, checkInAt: iso(v.check_in_at), checkOutAt: iso(v.check_out_at) } : null;

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
