import { POLICY_FIELDS, type AttendancePolicyVersion, type PolicyField, type ResolvedPolicy } from "@/lib/domain/policy";
import { legacyRuleSettings } from "@/lib/domain/calc";
import type { MasterImportWrite } from "@/lib/domain/master-import";
import type { ConsentEvent, MessagingSettings, OutboundMessage, WorkerContact } from "@/lib/domain/messaging";
import type {
  AttendanceRecord,
  AttendanceSnapshot,
  AuditLog,
  Contractor,
  ContractorProjectAssignment,
  ImportBatch,
  OperatorAccess,
  PaymentRule,
  Profile,
  Project,
  Worker,
  WorkerAssignment,
  WorkerPayTerms,
} from "@/lib/domain/types";
import type {
  AttendancePolicyFields,
  MessagingSettingsFields,
  NewMessage,
  PaymentRuleFields,
  ProjectFields,
  WorkerContactFields,
  WorkerPayTermsFields,
} from "./types";

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
  location: r.location ?? null,
  legalName: r.legal_name ?? null,
  identityStatus: r.identity_status ?? "confirmed",
  identityNote: r.identity_note ?? null,
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
  employeeCode: r.employee_code ?? null,
  fullName: r.full_name,
  contractorId: r.contractor_id,
  department: r.department ?? null,
  designation: r.designation ?? null,
  isActive: r.is_active,
  phone: r.phone ?? null,
  notes: r.notes ?? null,
  source: r.source ?? null,
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
  shift: r.shift ?? "day",
  method: r.method,
  version: Number(r.version),
  createdAt: isoReq(r.created_at),
  updatedAt: isoReq(r.updated_at),
  createdBy: r.created_by ?? null,
  updatedBy: r.updated_by ?? null,
});

/** Rule rows written before the v2 settings existed (rule_format 1) keep their original meaning. */
export const paymentRule = (r: Row): PaymentRule => {
  const base = {
    id: r.id,
    contractorId: r.contractor_id,
    version: Number(r.version),
    effectiveFrom: day(r.effective_from),
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
  };
  if (Number(r.rule_format ?? 1) < 2) return { ...base, ...legacyRuleSettings(base) };
  return {
    ...base,
    rateSource: r.rate_source,
    shortDayPolicy: r.short_day_policy ?? null,
    monthlyDivisorDays: num(r.monthly_divisor_days),
    overtimeAfterNightHours: num(r.overtime_after_night_hours),
    overtimeRateMode: r.overtime_rate_mode ?? null,
    overtimeMultiplier: num(r.overtime_multiplier),
    overtimeRounding: r.overtime_rounding ?? null,
    overtimeMinMinutes: Number(r.overtime_min_minutes ?? 0),
    commissionEnabled: !!r.commission_enabled,
    commissionPercent: num(r.commission_percent),
    commissionScope: r.commission_scope ?? null,
    commissionBase: r.commission_base ?? null,
    commissionTreatment: r.commission_treatment ?? null,
  };
};

export const paymentRuleFields = (f: PaymentRuleFields): Row => ({
  contractor_id: f.contractorId,
  effective_from: f.effectiveFrom,
  rule_format: 2,
  rate_source: f.rateSource,
  rate_type: f.rateType,
  day_rate: f.dayRate,
  hour_rate: f.hourRate,
  full_day_hours: f.fullDayHours,
  half_day_hours: f.halfDayHours,
  short_day_policy: f.shortDayPolicy,
  monthly_divisor_days: f.monthlyDivisorDays,
  overtime_enabled: f.overtimeEnabled,
  overtime_after_hours: f.overtimeAfterHours,
  overtime_after_night_hours: f.overtimeAfterNightHours,
  overtime_rate_mode: f.overtimeRateMode,
  overtime_hour_rate: f.overtimeHourRate,
  overtime_multiplier: f.overtimeMultiplier,
  overtime_rounding: f.overtimeRounding,
  overtime_min_minutes: f.overtimeMinMinutes,
  unpaid_break_minutes: f.unpaidBreakMinutes,
  commission_enabled: f.commissionEnabled,
  commission_percent: f.commissionPercent,
  commission_scope: f.commissionScope,
  commission_base: f.commissionBase,
  commission_treatment: f.commissionTreatment,
  notes: f.notes,
});

export const workerPayTerms = (r: Row): WorkerPayTerms => ({
  id: r.id,
  workerId: r.worker_id,
  version: Number(r.version),
  effectiveFrom: day(r.effective_from),
  rateAmount: num(r.rate_amount),
  rateBasis: r.rate_basis,
  commissionEligible: r.commission_eligible ?? null,
  source: r.source ?? null,
  notes: r.notes ?? null,
  createdAt: isoReq(r.created_at),
  createdBy: r.created_by ?? null,
});

export const workerPayTermsFields = (f: WorkerPayTermsFields & { basedOnVersion?: number | null }): Row => ({
  worker_id: f.workerId,
  based_on_version: f.basedOnVersion ?? null,
  effective_from: f.effectiveFrom,
  rate_amount: f.rateAmount,
  rate_basis: f.rateBasis,
  commission_eligible: f.commissionEligible,
  source: f.source,
  notes: f.notes,
});

export const importBatch = (r: Row): ImportBatch => ({
  id: r.id,
  kind: r.kind,
  fileName: r.file_name,
  fileHash: r.file_hash,
  summary: r.summary ?? {},
  createdAt: isoReq(r.created_at),
  createdBy: r.created_by ?? null,
});

/** Payload of public.admin_import_worker_master(). */
export const masterImportPayload = (w: MasterImportWrite): Row => ({
  batch: { file_name: w.batch.fileName, file_hash: w.batch.fileHash, summary: w.batch.summary, expected_last_batch_id: w.batch.expectedLastBatchId },
  contractors: w.contractors.map((c) => ({ ref: c.ref, name: c.name, legal_name: c.legalName, identity_status: c.identityStatus, identity_note: c.identityNote })),
  creates: w.creates.map((c) => ({
    ...("id" in c.contractor ? { contractor_id: c.contractor.id } : { contractor_ref: c.contractor.ref }),
    employee_code: c.employeeCode,
    full_name: c.fullName,
    department: c.department,
    designation: c.designation,
    source: c.source,
    pay_terms: { effective_from: c.payTerms.effectiveFrom, rate_amount: c.payTerms.rateAmount, rate_basis: c.payTerms.rateBasis, source: c.payTerms.source },
  })),
  updates: w.updates.map((u) => ({
    worker_id: u.workerId,
    expected: { full_name: u.expected.fullName, department: u.expected.department, designation: u.expected.designation, terms_version: u.expected.termsVersion },
    fields: u.fields ? { full_name: u.fields.fullName, department: u.fields.department, designation: u.fields.designation } : null,
    pay_terms: u.payTerms
      ? {
          effective_from: u.payTerms.effectiveFrom,
          rate_amount: u.payTerms.rateAmount,
          rate_basis: u.payTerms.rateBasis,
          commission_eligible: u.payTerms.commissionEligible,
          source: u.payTerms.source,
        }
      : null,
  })),
});


// ---------- WhatsApp messaging ----------

export const workerContact = (r: Row): WorkerContact => ({
  workerId: r.worker_id,
  countryCode: r.country_code,
  whatsappNumber: r.whatsapp_number ?? null,
  enabled: !!r.enabled,
  consentStatus: r.consent_status,
  consentAt: iso(r.consent_at),
  consentSource: r.consent_source ?? null,
  preferredLanguage: r.preferred_language ?? null,
  updatedAt: isoReq(r.updated_at),
  updatedBy: r.updated_by ?? null,
});

export const workerContactFields = (c: WorkerContactFields): Row => ({
  worker_id: c.workerId,
  country_code: c.countryCode,
  whatsapp_number: c.whatsappNumber,
  enabled: c.enabled,
  consent_status: c.consentStatus,
  consent_at: c.consentAt,
  consent_source: c.consentSource,
  preferred_language: c.preferredLanguage,
});

export const consentEvent = (r: Row): ConsentEvent => ({
  id: String(r.id),
  workerId: r.worker_id,
  consentStatus: r.consent_status,
  source: r.source ?? null,
  at: isoReq(r.at),
  by: r.by ?? null,
});

export const messagingSettings = (r: Row): MessagingSettings => ({
  enabled: !!r.enabled,
  paused: !!r.paused,
  sendTime: hhmm(r.send_time)!,
  defaultLanguage: r.default_language,
  includeEnglish: !!r.include_english,
  attendanceTemplate: r.attendance_template,
  correctionTemplate: r.correction_template,
  correctionNotices: !!r.correction_notices,
  startDate: day(r.start_date),
  testNumber: r.test_number ?? null,
  lastScheduledRun: r.last_scheduled_run ? day(r.last_scheduled_run) : null,
  updatedAt: iso(r.updated_at),
  updatedBy: r.updated_by ?? null,
});

export const messagingSettingsFields = (s: MessagingSettingsFields): Row => ({
  id: 1,
  enabled: s.enabled,
  paused: s.paused,
  send_time: s.sendTime,
  default_language: s.defaultLanguage,
  include_english: s.includeEnglish,
  attendance_template: s.attendanceTemplate,
  correction_template: s.correctionTemplate,
  correction_notices: s.correctionNotices,
  start_date: s.startDate,
  test_number: s.testNumber,
});

export const outboundMessage = (r: Row): OutboundMessage => ({
  id: r.id,
  idempotencyKey: r.idempotency_key,
  kind: r.kind,
  workerId: r.worker_id ?? null,
  attendanceId: r.attendance_id ?? null,
  attendanceVersion: r.attendance_version === null || r.attendance_version === undefined ? null : Number(r.attendance_version),
  contractorId: r.contractor_id ?? null,
  projectId: r.project_id ?? null,
  workDate: r.work_date ? day(r.work_date) : null,
  shift: r.shift ?? null,
  to: r.to_number,
  language: r.language,
  templateName: r.template_name,
  params: (r.params ?? []) as string[],
  body: r.body,
  status: r.status,
  attempts: Number(r.attempts),
  nextAttemptAt: iso(r.next_attempt_at),
  lastError: r.last_error ?? null,
  providerMessageId: r.provider_message_id ?? null,
  transport: r.transport ?? null,
  createdAt: isoReq(r.created_at),
  sentAt: iso(r.sent_at),
  updatedAt: isoReq(r.updated_at),
  createdBy: r.created_by ?? null,
});

export const newMessageRow = (m: NewMessage, createdBy: string | null): Row => ({
  idempotency_key: m.idempotencyKey,
  kind: m.kind,
  worker_id: m.workerId,
  attendance_id: m.attendanceId,
  attendance_version: m.attendanceVersion,
  contractor_id: m.contractorId,
  project_id: m.projectId,
  work_date: m.workDate,
  shift: m.shift,
  to_number: m.to,
  language: m.language,
  template_name: m.templateName,
  params: m.params,
  body: m.body,
  created_by: createdBy,
});

// Entries written before check-in sources were tracked lack that key: it stays undefined.
const snapshot = (v: Row | null): AttendanceSnapshot | null =>
  v
    ? {
        status: v.status,
        checkInAt: iso(v.check_in_at),
        checkOutAt: iso(v.check_out_at),
        ...("check_in_source" in v ? { checkInSource: v.check_in_source ?? null } : {}),
        ...("shift" in v ? { shift: v.shift } : {}),
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
const TIME_FIELDS = new Set<PolicyField>(["suggestedCheckIn", "nightSuggestedCheckIn", "shiftStart", "shiftEnd", "editCutoffTime"]);
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
