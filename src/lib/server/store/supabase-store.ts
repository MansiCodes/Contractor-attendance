import "server-only";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { AppError, conflict, forbidden, invalid } from "@/lib/errors";
import type { MasterImportWrite } from "@/lib/domain/master-import";
import type { ConsentEvent, MessageStatus, MessagingSettings, OutboundMessage, WorkerContact } from "@/lib/domain/messaging";
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
import type { AttendancePolicyVersion, ResolvedPolicy } from "@/lib/domain/policy";
import { createAdminSupabase } from "@/lib/supabase/server";
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

const PAGE = 1000;
type Query = ReturnType<ReturnType<SupabaseClient["from"]>["select"]>;
const PHOTO_BUCKET = "contractor-photos";

/** Converts database errors into user-safe AppErrors. Never falls back to demo data. */
export function mapDbError(error: PostgrestError | { message: string; code?: string }): AppError {
  const msg = error.message ?? "Database error";
  const m = /^(forbidden|invalid|conflict):\s*(.*)$/s.exec(msg);
  if (m) {
    const text = m[2].charAt(0).toUpperCase() + m[2].slice(1);
    return m[1] === "forbidden" ? forbidden(text) : m[1] === "conflict" ? conflict(text) : invalid(text);
  }
  switch (error.code) {
    case "42501":
      return forbidden("You do not have permission to do this");
    case "23505":
      return conflict("This record already exists");
    case "23P01":
      return conflict("These dates overlap an existing plant assignment");
    case "23514":
      return invalid("The values entered are not allowed (check times and numbers)");
    case "23503":
      return invalid("A linked record does not exist");
    default:
      return new AppError(`Database error: ${msg}`, "config");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST responses are untyped here
function check(res: { data: unknown; error: PostgrestError | null }): any {
  if (res.error) throw mapDbError(res.error);
  return res.data;
}

export class SupabaseStore implements DataStore {
  readonly kind = "supabase" as const;

  constructor(private readonly db: SupabaseClient) {}

  /** Reads every row (PostgREST caps responses at 1000 rows). */
  private async all<R>(table: string, filter?: (q: Query) => Query): Promise<R[]> {
    const out: R[] = [];
    for (let from = 0; ; from += PAGE) {
      let q: Query = this.db.from(table).select("*");
      if (filter) q = filter(q);
      const rows = check(await q.order("id", { ascending: true }).range(from, from + PAGE - 1)) as R[];
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }

  // ---------- reads ----------

  async getProfile(id: string): Promise<Profile | null> {
    const row = check(await this.db.from("profiles").select("*").eq("id", id).maybeSingle());
    return row ? map.profile(row) : null;
  }
  async listProfiles() {
    return (await this.all<map.Row>("profiles")).map(map.profile);
  }
  async listContractors(): Promise<Contractor[]> {
    const rows = (await this.all<map.Row>("contractors")).map(map.contractor);
    const paths = rows.map((c) => c.photoPath).filter((p): p is string => !!p);
    if (paths.length > 0) {
      const { data } = await this.db.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600);
      const urls = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
      for (const c of rows) c.photoUrl = c.photoPath ? urls.get(c.photoPath) ?? null : null;
    }
    return rows;
  }
  async listProjects(): Promise<Project[]> {
    return (await this.all<map.Row>("projects")).map(map.project);
  }
  async listContractorProjects(): Promise<ContractorProjectAssignment[]> {
    return (await this.all<map.Row>("contractor_project_assignments")).map(map.contractorProject);
  }
  async listWorkers(): Promise<Worker[]> {
    return (await this.all<map.Row>("workers")).map(map.worker);
  }
  async listWorkerAssignments(): Promise<WorkerAssignment[]> {
    return (await this.all<map.Row>("worker_project_assignments")).map(map.workerAssignment);
  }
  async listOperatorAccess(): Promise<OperatorAccess[]> {
    return (await this.all<map.Row>("site_operator_assignments")).map(map.operatorAccess);
  }
  async listAttendance(q: AttendanceQuery): Promise<AttendanceRecord[]> {
    if (q.projectIds && q.projectIds.length === 0) return [];
    const rows = await this.all<map.Row>("attendance_records", (b) => {
      let x = b.gte("work_date", q.from).lte("work_date", q.to);
      if (q.projectIds) x = x.in("project_id", q.projectIds);
      if (q.contractorId) x = x.eq("contractor_id", q.contractorId);
      return x;
    });
    return rows.map(map.attendance);
  }
  async listPaymentRules(): Promise<PaymentRule[]> {
    return (await this.all<map.Row>("contractor_payment_rules")).map(map.paymentRule);
  }
  async listWorkerPayTerms(): Promise<WorkerPayTerms[]> {
    return (await this.all<map.Row>("worker_pay_terms")).map(map.workerPayTerms);
  }
  async listImportBatches(): Promise<ImportBatch[]> {
    return (await this.all<map.Row>("import_batches")).map(map.importBatch);
  }
  async listAttendancePolicies(): Promise<AttendancePolicyVersion[]> {
    return (await this.all<map.Row>("attendance_policies")).map(map.policyRow);
  }
  async getEffectivePolicy(projectId: string, date: string): Promise<ResolvedPolicy> {
    const row = check(await this.db.rpc("attendance_policy_for", { p_project_id: projectId, p_date: date }).single());
    return map.effectivePolicy(row as map.Row);
  }
  async listProjectsWithAttendance(): Promise<string[]> {
    // A set-returning function of a scalar: accept bare values or single-key rows.
    const rows = (check(await this.db.rpc("projects_with_attendance")) ?? []) as unknown[];
    return rows.map((v) => String(v !== null && typeof v === "object" ? Object.values(v)[0] : v));
  }
  async listAuditLogs(q: AuditQuery): Promise<AuditLog[]> {
    let query = this.db.from("attendance_audit_logs").select("*");
    if (q.projectIds) query = query.in("project_id", q.projectIds);
    if (q.from) query = query.gte("work_date", q.from);
    if (q.to) query = query.lte("work_date", q.to);
    if (q.workerId) query = query.eq("worker_id", q.workerId);
    const rows = check(await query.order("changed_at", { ascending: false }).order("id", { ascending: false }).limit(q.limit)) as map.Row[];
    return rows.map(map.auditLog);
  }

  // ---------- contractors & projects ----------

  async createContractor(input: { name: string; location: string | null }, actor: Actor) {
    const row = check(await this.db.from("contractors").insert({ ...input, created_by: actor.id }).select("*").single());
    return map.contractor(row);
  }
  async updateContractor(id: string, input: { name: string; location: string | null; isActive: boolean }) {
    check(await this.db.from("contractors").update({ name: input.name, location: input.location, is_active: input.isActive }).eq("id", id));
  }
  async setContractorPhoto(id: string, file: { bytes: Uint8Array; contentType: string }) {
    const ext = file.contentType === "image/png" ? "png" : file.contentType === "image/webp" ? "webp" : "jpg";
    const path = `${id}/${Date.now()}.${ext}`;
    const up = await this.db.storage.from(PHOTO_BUCKET).upload(path, file.bytes, { contentType: file.contentType, upsert: false });
    if (up.error) throw new AppError(`Photo upload failed: ${up.error.message}`, "config");
    check(await this.db.from("contractors").update({ photo_path: path }).eq("id", id));
  }
  async setContractorIdentity(id: string, input: { legalName: string | null; identityStatus: ContractorIdentityStatus; identityNote: string | null }) {
    check(
      await this.db
        .from("contractors")
        .update({ legal_name: input.legalName, identity_status: input.identityStatus, identity_note: input.identityNote })
        .eq("id", id),
    );
  }
  async createProject(input: ProjectFields, actor: Actor) {
    const row = check(await this.db.from("projects").insert({ ...map.projectFields(input), created_by: actor.id }).select("*").single());
    return map.project(row);
  }
  async updateProject(id: string, input: ProjectFields) {
    check(await this.db.from("projects").update(map.projectFields(input)).eq("id", id));
  }
  async addContractorToProject(contractorId: string, projectId: string, startDate: string, actor: Actor) {
    check(
      await this.db
        .from("contractor_project_assignments")
        .insert({ contractor_id: contractorId, project_id: projectId, start_date: startDate, created_by: actor.id }),
    );
  }
  async endContractorProject(assignmentId: string, endDate: string) {
    check(await this.db.rpc("admin_end_contractor_project", { p_assignment_id: assignmentId, p_end_date: endDate }));
  }

  // ---------- workers ----------

  async createWorker(input: WorkerCreateFields) {
    const row = check(
      await this.db
        .rpc("admin_create_worker", {
          p_full_name: input.fullName,
          p_contractor_id: input.contractorId,
          p_project_id: input.projectId,
          p_start_date: input.startDate,
          p_phone: input.phone,
          p_notes: input.notes,
          p_employee_code: input.employeeCode,
          p_department: input.department,
          p_designation: input.designation,
        })
        .single(),
    );
    return map.worker(row as map.Row);
  }
  async updateWorker(id: string, input: WorkerUpdateFields) {
    check(
      await this.db
        .from("workers")
        .update({
          full_name: input.fullName,
          employee_code: input.employeeCode,
          department: input.department,
          designation: input.designation,
          phone: input.phone,
          notes: input.notes,
        })
        .eq("id", id),
    );
  }
  async deactivateWorker(id: string, lastWorkingDate: string) {
    check(await this.db.rpc("admin_deactivate_worker", { p_worker_id: id, p_last_working_date: lastWorkingDate }));
  }
  async reactivateWorker(id: string, projectId: string, startDate: string) {
    check(await this.db.rpc("admin_reactivate_worker", { p_worker_id: id, p_project_id: projectId, p_start_date: startDate }));
  }
  async transferWorker(id: string, projectId: string, contractorId: string, effectiveDate: string) {
    check(
      await this.db.rpc("admin_transfer_worker", {
        p_worker_id: id,
        p_project_id: projectId,
        p_contractor_id: contractorId,
        p_effective_date: effectiveDate,
      }),
    );
  }

  async assignWorkers(workerIds: string[], projectId: string, startDate: string) {
    return Number(check(await this.db.rpc("admin_assign_workers", { p_worker_ids: workerIds, p_project_id: projectId, p_start_date: startDate })));
  }
  async createWorkerPayTerms(inputs: WorkerPayTermsWrite[], actor: Actor) {
    // One INSERT statement: all rows or none. Versions are set by the database trigger.
    const rows = check(await this.db.from("worker_pay_terms").insert(inputs.map((i) => ({ ...map.workerPayTermsFields(i), created_by: actor.id }))).select("*")) as map.Row[];
    return rows.map(map.workerPayTerms);
  }
  async applyMasterImport(write: MasterImportWrite): Promise<MasterImportResult> {
    const r = check(await this.db.rpc("admin_import_worker_master", { p_payload: map.masterImportPayload(write) })) as map.Row;
    return { batchId: r.batch_id, contractorIds: r.contractors ?? {}, created: Number(r.created), updated: Number(r.updated) };
  }

  // ---------- WhatsApp messaging ----------

  async listWorkerContacts(): Promise<WorkerContact[]> {
    const out: map.Row[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = check(await this.db.from("worker_contacts").select("*").order("worker_id").range(from, from + PAGE - 1)) as map.Row[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out.map(map.workerContact);
  }
  async saveWorkerContacts(items: WorkerContactFields[]) {
    // One statement: all or none. The database stamps the change and logs consent changes.
    if (items.length > 0) check(await this.db.from("worker_contacts").upsert(items.map(map.workerContactFields), { onConflict: "worker_id" }));
  }
  async listConsentEvents(workerId?: string): Promise<ConsentEvent[]> {
    let q = this.db.from("worker_consent_events").select("*");
    if (workerId) q = q.eq("worker_id", workerId);
    return (check(await q.order("id", { ascending: false }).limit(1000)) as map.Row[]).map(map.consentEvent);
  }
  async getMessagingSettings(): Promise<MessagingSettings | null> {
    const row = check(await this.db.from("messaging_settings").select("*").eq("id", 1).maybeSingle());
    return row ? map.messagingSettings(row) : null;
  }
  async saveMessagingSettings(input: MessagingSettingsFields, actor: Actor) {
    const row = check(await this.db.from("messaging_settings").upsert({ ...map.messagingSettingsFields(input), updated_by: actor.id, updated_at: new Date().toISOString() }).select("*").single());
    return map.messagingSettings(row);
  }
  async setLastScheduledRun(date: string) {
    check(await this.db.from("messaging_settings").update({ last_scheduled_run: date }).eq("id", 1));
  }
  async listMessages(q: { limit: number; statuses?: MessageStatus[] }): Promise<OutboundMessage[]> {
    // Newest first, in pages (PostgREST returns at most 1000 rows per request).
    const out: map.Row[] = [];
    for (let from = 0; from < q.limit; from += PAGE) {
      let query = this.db.from("outbound_messages").select("*");
      if (q.statuses) query = query.in("status", q.statuses);
      const rows = check(await query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, Math.min(from + PAGE, q.limit) - 1)) as map.Row[];
      out.push(...rows);
      if (rows.length < Math.min(PAGE, q.limit - from)) break;
    }
    return out.map(map.outboundMessage);
  }
  async enqueueMessages(items: NewMessage[], actor: Actor | null): Promise<OutboundMessage[]> {
    if (items.length === 0) return [];
    // The unique idempotency key makes a repeated message a no-op.
    const rows = check(
      await this.db
        .from("outbound_messages")
        .upsert(items.map((m) => map.newMessageRow(m, actor?.id ?? null)), { onConflict: "idempotency_key", ignoreDuplicates: true })
        .select("*"),
    ) as map.Row[];
    return rows.map(map.outboundMessage);
  }
  async claimDueMessages(now: string, limit: number): Promise<OutboundMessage[]> {
    return ((check(await this.db.rpc("messaging_claim_due", { p_now: now, p_limit: limit })) ?? []) as map.Row[]).map(map.outboundMessage);
  }
  async claimMessage(id: string, now: string): Promise<OutboundMessage | null> {
    const row = check(
      await this.db.from("outbound_messages").update({ status: "sending", updated_at: now }).eq("id", id).eq("status", "queued").select("*").maybeSingle(),
    );
    return row ? map.outboundMessage(row as map.Row) : null;
  }
  async refreshMessage(id: string, patch: Pick<OutboundMessage, "to" | "language" | "params" | "body" | "attendanceVersion">) {
    check(
      await this.db
        .from("outbound_messages")
        .update({ to_number: patch.to, language: patch.language, params: patch.params, body: patch.body, attendance_version: patch.attendanceVersion })
        .eq("id", id)
        .eq("status", "sending"),
    );
  }
  async completeMessage(id: string, result: MessageResult) {
    const patch =
      result.status === "sent"
        ? { status: "sent", provider_message_id: result.providerMessageId, transport: result.transport, sent_at: result.at, last_error: null, next_attempt_at: null, updated_at: result.at }
        : { status: result.status, last_error: result.error, next_attempt_at: result.nextAttemptAt, transport: result.transport, updated_at: result.at };
    check(await this.db.from("outbound_messages").update(patch).eq("id", id));
    // Statuses that arrived before the provider id was saved are applied now.
    if (result.status === "sent") check(await this.db.rpc("messaging_replay_statuses", { p_provider_message_id: result.providerMessageId }));
  }
  async applyMessageStatus(providerMessageId: string, status: "sent" | "delivered" | "read" | "failed", at: string, error: string | null, payload?: unknown) {
    return Boolean(
      check(await this.db.rpc("messaging_apply_status", { p_provider_message_id: providerMessageId, p_status: status, p_at: at, p_error: error, p_payload: payload ?? {} })),
    );
  }
  async requeueFailed() {
    const rows = check(
      await this.db.from("outbound_messages").update({ status: "queued", next_attempt_at: null, attempts: 0, updated_at: new Date().toISOString() }).eq("status", "failed").select("id"),
    ) as map.Row[];
    return rows.length;
  }

  // ---------- operators ----------

  async grantOperatorAccess(operatorId: string, projectId: string, actor: Actor) {
    const existing = check(
      await this.db.from("site_operator_assignments").select("id").eq("operator_id", operatorId).eq("project_id", projectId).is("revoked_at", null),
    ) as map.Row[];
    if (existing.length > 0) return;
    check(await this.db.from("site_operator_assignments").insert({ operator_id: operatorId, project_id: projectId, granted_by: actor.id }));
  }
  async revokeOperatorAccess(operatorId: string, projectId: string) {
    check(
      await this.db
        .from("site_operator_assignments")
        .update({ revoked_at: new Date().toISOString() })
        .eq("operator_id", operatorId)
        .eq("project_id", projectId)
        .is("revoked_at", null),
    );
  }
  async createOperator(input: { fullName: string; email: string; password?: string }) {
    if (!input.password) throw invalid("Set a temporary password for the operator");
    // Service-role client: used only here, after the service verified the caller is an admin.
    const admin = createAdminSupabase();
    const { data, error } = await admin.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: { full_name: input.fullName },
      app_metadata: { role: "operator" },
    });
    if (error || !data.user) {
      if (error?.message?.toLowerCase().includes("already")) throw conflict("A user with this email already exists");
      throw new AppError(`Could not create the account: ${error?.message ?? "unknown error"}`, "config");
    }
    const profile = await this.getProfile(data.user.id);
    if (!profile) throw new AppError("Account created but its profile is missing. Check the database trigger.", "config");
    return profile;
  }
  async setProfileActive(id: string, isActive: boolean) {
    check(await this.db.from("profiles").update({ is_active: isActive }).eq("id", id));
  }

  // ---------- payment rules ----------

  async createPaymentRule(input: PaymentRuleFields, actor: Actor) {
    const row = check(await this.db.from("contractor_payment_rules").insert({ ...map.paymentRuleFields(input), created_by: actor.id }).select("*").single());
    return map.paymentRule(row);
  }

  // ---------- attendance policies ----------

  async createAttendancePolicy(input: AttendancePolicyFields) {
    // version and created_by are set by the database trigger
    const row = check(await this.db.from("attendance_policies").insert(map.policyFields(input)).select("*").single());
    return map.policyRow(row);
  }

  // ---------- attendance ----------

  async saveAttendance(projectId: string, workDate: string, items: AttendanceWrite[]) {
    const rows = check(
      await this.db.rpc("save_attendance", {
        p_project_id: projectId,
        p_work_date: workDate,
        p_items: items.map((i) => ({
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
      }),
    ) as map.Row[];
    return (rows ?? []).map(map.attendance);
  }
}
