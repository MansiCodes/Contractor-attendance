import type { AttendancePolicyVersion, ResolvedPolicy } from "@/lib/domain/policy";
import type { MasterImportWrite } from "@/lib/domain/master-import";
import type { ConsentEvent, MessageStatus, MessagingSettings, OutboundMessage, WorkerContact } from "@/lib/domain/messaging";
import { conflict, invalid, notFound } from "@/lib/errors";
import type {
  Actor,
  AttendanceRecord,
  AuditLog,
  Contractor,
  ContractorIdentityStatus,
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
import { createAccount } from "../auth/service";
import { scoped, type Database, type DbIdentity, type Queryable, type Row } from "../db/database";
import { mapDbError } from "../db/errors";
import type { ObjectStorage } from "../storage";
import * as map from "./supabase-mappers";
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
  WorkerPayTermsWrite,
  WorkerUpdateFields,
} from "./types";

// The data store for development and production: plain SQL over a PostgreSQL
// connection (Amazon RDS in production). Every call runs in its own transaction as
// the signed-in user (or the system account for scheduled jobs), so the database's
// Row Level Security, triggers and functions enforce the same rules as before:
// an operator cannot read or change another plant's data even if the server asked.
// Row conversions are shared with the earlier Supabase store (supabase-mappers.ts).

const IDENT = /^[a-z_][a-z0-9_]*$/;

function insert(table: string, row: Row): { text: string; params: unknown[] } {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  for (const k of keys) if (!IDENT.test(k)) throw new Error(`Bad column name ${k}`);
  return {
    text: `insert into ${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    params: keys.map((k) => row[k]),
  };
}

function update(table: string, row: Row, where: string, whereParams: unknown[]): { text: string; params: unknown[] } {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  for (const k of keys) if (!IDENT.test(k)) throw new Error(`Bad column name ${k}`);
  const offset = whereParams.length;
  return {
    text: `update ${table} set ${keys.map((k, i) => `${k} = $${i + 1 + offset}`).join(", ")} where ${where}`,
    params: [...whereParams, ...keys.map((k) => row[k])],
  };
}

const json = (v: unknown) => JSON.stringify(v);

export class PostgresStore implements DataStore {
  readonly kind = "postgres" as const;

  constructor(
    private readonly db: Database,
    private readonly identity: DbIdentity,
    private readonly files: ObjectStorage | null,
  ) {}

  private async run<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    try {
      return await scoped(this.db, this.identity, fn);
    } catch (e) {
      throw mapDbError(e);
    }
  }

  private async rows<R extends Row = Row>(text: string, params: unknown[] = []): Promise<R[]> {
    return this.run(async (q) => (await q.query<R>(text, params)).rows);
  }

  private async one<R extends Row = Row>(text: string, params: unknown[] = []): Promise<R | null> {
    return (await this.rows<R>(text, params))[0] ?? null;
  }

  // ---------- reads ----------

  async getProfile(id: string): Promise<Profile | null> {
    const r = await this.one("select * from public.profiles where id = $1", [id]);
    return r ? map.profile(r) : null;
  }
  async listProfiles() {
    return (await this.rows("select * from public.profiles order by created_at, id")).map(map.profile);
  }
  async listContractors(): Promise<Contractor[]> {
    const list = (await this.rows("select * from public.contractors order by name, id")).map(map.contractor);
    if (this.files) {
      for (const c of list) {
        if (!c.photoPath) continue;
        try {
          c.photoUrl = await this.files.url(c.photoPath);
        } catch {
          c.photoUrl = null; // a photo that cannot be signed is simply not shown
        }
      }
    }
    return list;
  }
  async listProjects(): Promise<Project[]> {
    return (await this.rows("select * from public.projects order by name, id")).map(map.project);
  }
  async listContractorProjects(): Promise<ContractorProjectAssignment[]> {
    return (await this.rows("select * from public.contractor_project_assignments order by start_date, id")).map(map.contractorProject);
  }
  async listWorkers(): Promise<Worker[]> {
    return (await this.rows("select * from public.workers order by worker_code")).map(map.worker);
  }
  async listWorkerAssignments(): Promise<WorkerAssignment[]> {
    return (await this.rows("select * from public.worker_project_assignments order by start_date, id")).map(map.workerAssignment);
  }
  async listOperatorAccess(): Promise<OperatorAccess[]> {
    return (await this.rows("select * from public.site_operator_assignments order by granted_at, id")).map(map.operatorAccess);
  }
  async listAttendance(q: AttendanceQuery): Promise<AttendanceRecord[]> {
    if (q.projectIds && q.projectIds.length === 0) return [];
    const rows = await this.rows(
      `select * from public.attendance_records
        where work_date between $1::date and $2::date
          and ($3::uuid[] is null or project_id = any ($3::uuid[]))
          and ($4::uuid is null or contractor_id = $4::uuid)
        order by work_date, id`,
      [q.from, q.to, q.projectIds ?? null, q.contractorId ?? null],
    );
    return rows.map(map.attendance);
  }
  async listPaymentRules(): Promise<PaymentRule[]> {
    return (await this.rows("select * from public.contractor_payment_rules order by contractor_id, version")).map(map.paymentRule);
  }
  async listWorkerPayTerms(): Promise<WorkerPayTerms[]> {
    return (await this.rows("select * from public.worker_pay_terms order by worker_id, version")).map(map.workerPayTerms);
  }
  async listImportBatches(): Promise<ImportBatch[]> {
    return (await this.rows("select * from public.import_batches order by created_at, id")).map(map.importBatch);
  }
  async listAttendancePolicies(): Promise<AttendancePolicyVersion[]> {
    return (await this.rows("select * from public.attendance_policies order by effective_from, version, id")).map(map.policyRow);
  }
  async getEffectivePolicy(projectId: string, date: string): Promise<ResolvedPolicy> {
    const r = await this.one("select * from public.attendance_policy_for($1, $2::date)", [projectId, date]);
    return map.effectivePolicy(r ?? {});
  }
  async listProjectsWithAttendance(): Promise<string[]> {
    return (await this.rows<{ id: string }>("select p as id from public.projects_with_attendance() p")).map((r) => String(r.id));
  }
  async listAuditLogs(q: AuditQuery): Promise<AuditLog[]> {
    const rows = await this.rows(
      `select * from public.attendance_audit_logs
        where ($1::uuid[] is null or project_id = any ($1::uuid[]))
          and ($2::date is null or work_date >= $2::date)
          and ($3::date is null or work_date <= $3::date)
          and ($4::uuid is null or worker_id = $4::uuid)
        order by changed_at desc, id desc
        limit $5`,
      [q.projectIds ?? null, q.from ?? null, q.to ?? null, q.workerId ?? null, q.limit],
    );
    return rows.map(map.auditLog);
  }

  // ---------- contractors & projects ----------

  async createContractor(input: { name: string; location: string | null }, actor: Actor) {
    const s = insert("public.contractors", { name: input.name, location: input.location, created_by: actor.id });
    const r = await this.one(s.text, s.params);
    return map.contractor(r!);
  }
  async updateContractor(id: string, input: { name: string; location: string | null; isActive: boolean }) {
    const s = update("public.contractors", { name: input.name, location: input.location, is_active: input.isActive }, "id = $1", [id]);
    await this.rows(s.text, s.params);
  }
  async setContractorPhoto(id: string, file: { bytes: Uint8Array; contentType: string }) {
    if (!this.files) throw invalid("File storage is not configured");
    const ext = file.contentType === "image/png" ? "png" : file.contentType === "image/webp" ? "webp" : "jpg";
    const key = `contractor-photos/${id}/${Date.now()}.${ext}`;
    const before = await this.one<{ photo_path: string | null }>("select photo_path from public.contractors where id = $1", [id]);
    if (!before) throw notFound("Contractor");
    await this.files.put(key, file.bytes, file.contentType);
    try {
      await this.rows("update public.contractors set photo_path = $2 where id = $1", [id, key]);
    } catch (e) {
      await this.files.remove(key).catch(() => {});
      throw e;
    }
    if (before.photo_path) await this.files.remove(before.photo_path).catch(() => {});
  }
  async setContractorIdentity(id: string, input: { legalName: string | null; identityStatus: ContractorIdentityStatus; identityNote: string | null }) {
    await this.rows("update public.contractors set legal_name = $2, identity_status = $3, identity_note = $4 where id = $1", [
      id,
      input.legalName,
      input.identityStatus,
      input.identityNote,
    ]);
  }
  async createProject(input: ProjectFields, actor: Actor) {
    const s = insert("public.projects", { ...map.projectFields(input), created_by: actor.id });
    return map.project((await this.one(s.text, s.params))!);
  }
  async updateProject(id: string, input: ProjectFields) {
    const s = update("public.projects", map.projectFields(input), "id = $1", [id]);
    await this.rows(s.text, s.params);
  }
  async addContractorToProject(contractorId: string, projectId: string, startDate: string, actor: Actor) {
    await this.rows("insert into public.contractor_project_assignments (contractor_id, project_id, start_date, created_by) values ($1, $2, $3::date, $4)", [
      contractorId,
      projectId,
      startDate,
      actor.id,
    ]);
  }
  async endContractorProject(assignmentId: string, endDate: string) {
    await this.rows("select public.admin_end_contractor_project($1, $2::date)", [assignmentId, endDate]);
  }

  // ---------- workers ----------

  async createWorker(input: WorkerCreateFields) {
    const r = await this.one("select * from public.admin_create_worker($1, $2, $3, $4::date, $5, $6, $7, $8, $9)", [
      input.fullName,
      input.contractorId,
      input.projectId,
      input.startDate,
      input.phone,
      input.notes,
      input.employeeCode,
      input.department,
      input.designation,
    ]);
    return map.worker(r!);
  }
  async updateWorker(id: string, input: WorkerUpdateFields) {
    await this.rows(
      "update public.workers set full_name = $2, employee_code = $3, department = $4, designation = $5, phone = $6, notes = $7 where id = $1",
      [id, input.fullName, input.employeeCode, input.department, input.designation, input.phone, input.notes],
    );
  }
  async deactivateWorker(id: string, lastWorkingDate: string) {
    await this.rows("select public.admin_deactivate_worker($1, $2::date)", [id, lastWorkingDate]);
  }
  async reactivateWorker(id: string, projectId: string, startDate: string) {
    await this.rows("select public.admin_reactivate_worker($1, $2, $3::date)", [id, projectId, startDate]);
  }
  async transferWorker(id: string, projectId: string, contractorId: string, effectiveDate: string) {
    await this.rows("select public.admin_transfer_worker($1, $2, $3, $4::date)", [id, projectId, contractorId, effectiveDate]);
  }
  async assignWorkers(workerIds: string[], projectId: string, startDate: string) {
    const r = await this.one<{ n: number }>("select public.admin_assign_workers($1::uuid[], $2, $3::date) as n", [workerIds, projectId, startDate]);
    return Number(r?.n ?? 0);
  }
  async createWorkerPayTerms(inputs: WorkerPayTermsWrite[], actor: Actor) {
    if (inputs.length === 0) return [];
    // One statement: all rows or none. Versions and authors are set by the trigger.
    const rows = await this.rows(
      `insert into public.worker_pay_terms (worker_id, version, effective_from, rate_amount, rate_basis, commission_eligible, source, notes, based_on_version, created_by)
       select x.worker_id, 0, x.effective_from, x.rate_amount, x.rate_basis::public.rate_basis, x.commission_eligible, x.source, x.notes, x.based_on_version, $2::uuid
         from jsonb_to_recordset($1::jsonb) as x(worker_id uuid, effective_from date, rate_amount numeric, rate_basis text,
                                                 commission_eligible boolean, source text, notes text, based_on_version integer)
       returning *`,
      [json(inputs.map((i) => map.workerPayTermsFields(i))), actor.id],
    );
    return rows.map(map.workerPayTerms);
  }
  async applyMasterImport(write: MasterImportWrite): Promise<MasterImportResult> {
    const r = await this.one<{ r: Row }>("select public.admin_import_worker_master($1::jsonb) as r", [json(map.masterImportPayload(write))]);
    const out = r!.r;
    return { batchId: out.batch_id, contractorIds: out.contractors ?? {}, created: Number(out.created), updated: Number(out.updated) };
  }

  // ---------- WhatsApp messaging ----------

  async listWorkerContacts(): Promise<WorkerContact[]> {
    return (await this.rows("select * from public.worker_contacts order by worker_id")).map(map.workerContact);
  }
  async saveWorkerContacts(items: WorkerContactFields[]) {
    if (items.length === 0) return;
    // One statement: all or none. The table trigger stamps the change and logs consent changes.
    await this.rows(
      `insert into public.worker_contacts (worker_id, country_code, whatsapp_number, enabled, consent_status, consent_at, consent_source, preferred_language)
       select x.worker_id, x.country_code, x.whatsapp_number, x.enabled, x.consent_status::public.consent_status, x.consent_at, x.consent_source, x.preferred_language
         from jsonb_to_recordset($1::jsonb) as x(worker_id uuid, country_code text, whatsapp_number text, enabled boolean,
                                                 consent_status text, consent_at timestamptz, consent_source text, preferred_language text)
       on conflict (worker_id) do update set
         country_code = excluded.country_code, whatsapp_number = excluded.whatsapp_number, enabled = excluded.enabled,
         consent_status = excluded.consent_status, consent_at = excluded.consent_at, consent_source = excluded.consent_source,
         preferred_language = excluded.preferred_language`,
      [json(items.map(map.workerContactFields))],
    );
  }
  async listConsentEvents(workerId?: string): Promise<ConsentEvent[]> {
    const rows = await this.rows("select * from public.worker_consent_events where ($1::uuid is null or worker_id = $1::uuid) order by id desc limit 1000", [workerId ?? null]);
    return rows.map(map.consentEvent);
  }
  async getMessagingSettings(): Promise<MessagingSettings | null> {
    const r = await this.one("select * from public.messaging_settings where id = 1");
    return r ? map.messagingSettings(r) : null;
  }
  async saveMessagingSettings(input: MessagingSettingsFields, actor: Actor) {
    const f = map.messagingSettingsFields(input);
    const r = await this.one(
      `insert into public.messaging_settings (id, enabled, paused, send_time, default_language, include_english, attendance_template,
                                              correction_template, correction_notices, start_date, test_number, updated_by, updated_at)
       values (1, $1, $2, $3::time, $4, $5, $6, $7, $8, $9::date, $10, $11, now())
       on conflict (id) do update set
         enabled = excluded.enabled, paused = excluded.paused, send_time = excluded.send_time, default_language = excluded.default_language,
         include_english = excluded.include_english, attendance_template = excluded.attendance_template,
         correction_template = excluded.correction_template, correction_notices = excluded.correction_notices,
         start_date = excluded.start_date, test_number = excluded.test_number, updated_by = excluded.updated_by, updated_at = now()
       returning *`,
      [f.enabled, f.paused, f.send_time, f.default_language, f.include_english, f.attendance_template, f.correction_template, f.correction_notices, f.start_date, f.test_number, actor.id],
    );
    return map.messagingSettings(r!);
  }
  async setLastScheduledRun(date: string) {
    await this.rows("update public.messaging_settings set last_scheduled_run = $1::date where id = 1", [date]);
  }
  async listMessages(q: { limit: number; statuses?: MessageStatus[] }): Promise<OutboundMessage[]> {
    const rows = await this.rows(
      "select * from public.outbound_messages where ($1::text[] is null or status = any ($1::text[])) order by created_at desc, id desc limit $2",
      [q.statuses ?? null, q.limit],
    );
    return rows.map(map.outboundMessage);
  }
  async enqueueMessages(items: NewMessage[], actor: Actor | null): Promise<OutboundMessage[]> {
    if (items.length === 0) return [];
    // The unique idempotency key makes a repeated message a no-op.
    const rows = await this.rows(
      `insert into public.outbound_messages (idempotency_key, kind, worker_id, attendance_id, attendance_version, contractor_id, project_id,
                                            work_date, shift, to_number, language, template_name, params, body, created_by)
       select x.idempotency_key, x.kind, x.worker_id, x.attendance_id, x.attendance_version, x.contractor_id, x.project_id,
              x.work_date, x.shift::public.attendance_shift, x.to_number, x.language, x.template_name, x.params, x.body, x.created_by
         from jsonb_to_recordset($1::jsonb) as x(idempotency_key text, kind text, worker_id uuid, attendance_id uuid, attendance_version integer,
                                                 contractor_id uuid, project_id uuid, work_date date, shift text, to_number text, language text,
                                                 template_name text, params jsonb, body text, created_by uuid)
       on conflict (idempotency_key) do nothing
       returning *`,
      [json(items.map((m) => map.newMessageRow(m, actor?.id ?? null)))],
    );
    return rows.map(map.outboundMessage);
  }
  async claimDueMessages(now: string, limit: number) {
    return (await this.rows("select * from public.messaging_claim_due($1::timestamptz, $2)", [now, limit])).map(map.outboundMessage);
  }
  async claimMessage(id: string, now: string) {
    const r = await this.one(
      "update public.outbound_messages set status = 'sending', attempts = attempts + 1, updated_at = $2::timestamptz where id = $1 and status = 'queued' returning *",
      [id, now],
    );
    return r ? map.outboundMessage(r) : null;
  }
  async refreshMessage(id: string, patch: Pick<OutboundMessage, "to" | "language" | "params" | "body" | "attendanceVersion">) {
    await this.rows(
      "update public.outbound_messages set to_number = $2, language = $3, params = $4::jsonb, body = $5, attendance_version = $6 where id = $1 and status = 'sending'",
      [id, patch.to, patch.language, json(patch.params), patch.body, patch.attendanceVersion],
    );
  }
  async completeMessage(id: string, result: MessageResult) {
    await this.run(async (q) => {
      if (result.status === "sent") {
        await q.query(
          `update public.outbound_messages set status = 'sent', provider_message_id = $2, transport = $3, sent_at = $4::timestamptz,
                  last_error = null, next_attempt_at = null, updated_at = $4::timestamptz where id = $1`,
          [id, result.providerMessageId, result.transport, result.at],
        );
        // Statuses that arrived before the provider id was saved are applied now.
        await q.query("select public.messaging_replay_statuses($1)", [result.providerMessageId]);
      } else {
        await q.query(
          "update public.outbound_messages set status = $2, last_error = $3, next_attempt_at = $4::timestamptz, transport = $5, updated_at = $6::timestamptz where id = $1",
          [id, result.status, result.error, result.nextAttemptAt, result.transport, result.at],
        );
      }
    });
  }
  async applyMessageStatus(providerMessageId: string, status: "sent" | "delivered" | "read" | "failed", at: string, error: string | null, payload?: unknown) {
    const r = await this.one<{ ok: boolean }>("select public.messaging_apply_status($1, $2, $3::timestamptz, $4, $5::jsonb) as ok", [
      providerMessageId,
      status,
      at,
      error,
      json(payload ?? {}),
    ]);
    return Boolean(r?.ok);
  }
  async requeueFailed() {
    const rows = await this.rows("update public.outbound_messages set status = 'queued', next_attempt_at = null, attempts = 0, updated_at = now() where status = 'failed' returning id");
    return rows.length;
  }

  // ---------- operators ----------

  async grantOperatorAccess(operatorId: string, projectId: string, actor: Actor) {
    await this.run(async (q) => {
      const existing = await q.query(
        "select id from public.site_operator_assignments where operator_id = $1 and project_id = $2 and revoked_at is null",
        [operatorId, projectId],
      );
      if (existing.rows.length > 0) return;
      await q.query("insert into public.site_operator_assignments (operator_id, project_id, granted_by) values ($1, $2, $3)", [operatorId, projectId, actor.id]);
    });
  }
  async revokeOperatorAccess(operatorId: string, projectId: string) {
    await this.rows("update public.site_operator_assignments set revoked_at = now() where operator_id = $1 and project_id = $2 and revoked_at is null", [
      operatorId,
      projectId,
    ]);
  }
  async createOperator(input: { fullName: string; email: string; password?: string }, actor: Actor) {
    if (!input.password) throw invalid("Set a temporary password for the operator");
    if (this.identity.kind !== "user" || this.identity.userId !== actor.id) throw conflict("Please sign in again");
    const id = await createAccount(this.db, actor.id, { email: input.email, fullName: input.fullName, role: "operator", password: input.password });
    const profile = await this.getProfile(id);
    if (!profile) throw invalid("The account was created but its profile is missing");
    return profile;
  }
  async setProfileActive(id: string, isActive: boolean) {
    await this.rows("update public.profiles set is_active = $2 where id = $1", [id, isActive]);
  }

  // ---------- payment rules & attendance policies (append-only) ----------

  async createPaymentRule(input: PaymentRuleFields, actor: Actor) {
    const s = insert("public.contractor_payment_rules", { ...map.paymentRuleFields(input), created_by: actor.id });
    return map.paymentRule((await this.one(s.text, s.params))!);
  }
  async createAttendancePolicy(input: AttendancePolicyFields) {
    // version and created_by are set by the database trigger
    const s = insert("public.attendance_policies", map.policyFields(input));
    return map.policyRow((await this.one(s.text, s.params))!);
  }

  // ---------- attendance ----------

  async saveAttendance(projectId: string, workDate: string, items: AttendanceWrite[]) {
    const rows = await this.rows("select * from public.save_attendance($1, $2::date, $3::jsonb)", [
      projectId,
      workDate,
      json(
        items.map((i) => ({
          worker_id: i.workerId,
          contractor_id: i.contractorId,
          status: i.status,
          check_in_at: i.checkInAt,
          check_out_at: i.checkOutAt,
          check_in_source: i.checkInSource,
          shift: i.shift,
          method: i.method,
          expected_version: i.expectedVersion,
        })),
      ),
    ]);
    return rows.map(map.attendance);
  }
}
