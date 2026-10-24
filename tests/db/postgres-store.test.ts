import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { addDays, todayIn } from "@/lib/domain/time";
import type { Actor } from "@/lib/domain/types";
import { buildAttendanceWorkbook } from "@/lib/export/xlsx";
import { hashPassword, temporaryPassword } from "@/lib/server/auth/password";
import { changeOwnPassword, resetPassword, resolveSession, signIn, signOut } from "@/lib/server/auth/service";
import type { Database, Queryable } from "@/lib/server/db/database";
import { runDispatch } from "@/lib/server/messaging/dispatcher";
import { mockTransport } from "@/lib/server/messaging/transport";
import * as admin from "@/lib/server/services/admin";
import { loadRegister, saveAttendance } from "@/lib/server/services/attendance";
import type { ServiceContext } from "@/lib/server/services/context";
import { applyMasterImport, assignUnassignedWorkers, previewMasterImport } from "@/lib/server/services/master-import";
import { saveMessagingSettings, saveWorkerContact } from "@/lib/server/services/messaging";
import { getAuditLog, getPayroll, getReport } from "@/lib/server/services/reports";
import type { ObjectStorage } from "@/lib/server/storage";
import { PostgresStore } from "@/lib/server/store/postgres-store";
import { buildMasterWorkbook } from "../unit/master-fixture";
import { createDb, type Db } from "./harness";

// The app's services running on the PostgreSQL store (the production data layer) over
// a real PostgreSQL engine (PGlite) with every migration, Row Level Security and
// trigger in place, and the app-managed sign-in. This is the local stand-in for the
// AWS read/write checks, which stay pending until an RDS database exists.

const pglite = (db: Db): Database => ({ transaction: (fn) => db.transaction((tx) => fn(tx as unknown as Queryable)) });

/** In-memory stand-in for S3. */
function memoryStorage(): ObjectStorage & { keys: () => string[] } {
  const files = new Map<string, Uint8Array>();
  return {
    put: async (k, b) => void files.set(k, b),
    remove: async (k) => void files.delete(k),
    url: async (k) => `https://signed.example/${k}?X-Amz-Expires=300`,
    keys: () => [...files.keys()],
  };
}

const IST = "Asia/Kolkata";

describe("PostgreSQL store with app sign-in (production data layer)", () => {
  let raw: Db;
  let db: Database;
  let files: ReturnType<typeof memoryStorage>;
  let adminActor: Actor;
  let operatorActor: Actor;
  let plantA: string;
  let plantB: string;
  let contractor: string;
  let workerA: string;
  let workerB: string;
  let operatorPassword: string;
  const ADMIN_PASSWORD = "Head-office-2026!";
  const ctx = (actor: Actor, now = new Date()): ServiceContext => ({ actor, store: new PostgresStore(db, { kind: "user", userId: actor.id }, files), now });

  beforeAll(async () => {
    raw = await createDb();
    db = pglite(raw);
    files = memoryStorage();
    // The first admin, as scripts/create-admin.mjs creates it (database owner).
    const hash = await hashPassword(ADMIN_PASSWORD);
    const id = (
      await raw.query<{ id: string }>(
        `insert into auth.users (email, raw_user_meta_data, raw_app_meta_data, password_hash) values ('admin@nf.test', '{"full_name":"Head Office"}', '{"role":"admin"}', $1) returning id`,
        [hash],
      )
    ).rows[0].id;
    adminActor = { id, role: "admin", fullName: "Head Office", email: "admin@nf.test" };
  });

  it("signs in with the right password only, and locks after five wrong ones", async () => {
    expect(await signIn(db, "admin@nf.test", "wrong-password")).toEqual({ ok: false, error: "Email or password is incorrect" });
    expect(await signIn(db, "nobody@nf.test", ADMIN_PASSWORD)).toEqual({ ok: false, error: "Email or password is incorrect" });
    const ok = await signIn(db, "ADMIN@nf.test", ADMIN_PASSWORD, { userAgent: "test", ip: "10.0.0.1" });
    expect(ok).toMatchObject({ ok: true, mustChangePassword: false });
    const session = await resolveSession(db, ok.ok ? ok.token : "");
    expect(session?.userId).toBe(adminActor.id);
    // The cookie value is never stored: only its hash.
    const stored = await raw.query<{ token_hash: Uint8Array }>("select token_hash from auth.sessions");
    expect(Buffer.from(stored.rows[0].token_hash).toString("base64url")).not.toBe(ok.ok ? ok.token : "");
    await signOut(db, ok.ok ? ok.token : "");
    expect(await resolveSession(db, ok.ok ? ok.token : "")).toBeNull();
    expect(await resolveSession(db, "not-a-token")).toBeNull();

    for (let i = 0; i < 5; i++) await signIn(db, "admin@nf.test", `wrong-${i}`);
    expect(await signIn(db, "admin@nf.test", ADMIN_PASSWORD)).toMatchObject({ ok: false, error: expect.stringMatching(/locked/) });
    await raw.query("update auth.users set locked_until = null where email = 'admin@nf.test'");
  });

  it("request roles cannot read password hashes or sessions; the system account cannot sign in", async () => {
    await raw.exec(`select set_config('request.jwt.claim.sub', '${adminActor.id}', false); set role authenticated;`);
    try {
      await expect(raw.query("select password_hash from auth.users")).rejects.toThrow(/permission denied/);
      await expect(raw.query("select * from auth.sessions")).rejects.toThrow(/permission denied/);
      await expect(raw.query("select * from auth.sign_in_lookup('admin@nf.test')")).rejects.toThrow(/permission denied/);
    } finally {
      await raw.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
    }
    expect(await signIn(db, "system@nf-attendance.invalid", "")).toMatchObject({ ok: false });
  });

  it("an admin sets up plants, a contractor and workers; photos go to private storage", async () => {
    const a = ctx(adminActor);
    plantA = (await admin.createProject(a, { name: "PVC Plant", location: "Unit 1", timezone: IST })).id;
    plantB = (await admin.createProject(a, { name: "Upcast Plant", location: "Unit 3", timezone: IST })).id;
    contractor = (await admin.createContractor(a, { name: "Test Labour Co", location: null })).id;
    const start = addDays(todayIn(IST), -30);
    for (const p of [plantA, plantB]) await admin.addContractorToProject(a, { contractorId: contractor, projectId: p, startDate: start });
    workerA = (await admin.createWorker(a, { fullName: "Ram Kumar", contractorId: contractor, projectId: plantA, startDate: start, employeeCode: "0F 8003" })).id;
    workerB = (await admin.createWorker(a, { fullName: "Shyam Lal", contractorId: contractor, projectId: plantB, startDate: start, employeeCode: "OF8032" })).id;
    await admin.setContractorPhoto(a, contractor, { bytes: new Uint8Array([0xff, 0xd8, 0xff]), contentType: "image/jpeg" });
    const c = (await a.store.listContractors()).find((x) => x.id === contractor)!;
    expect(c.photoUrl).toMatch(/^https:\/\/signed\.example\/contractor-photos\/.+X-Amz-Expires=300$/);
    expect(files.keys()).toHaveLength(1);
    expect((await a.store.listWorkers()).map((w) => w.employeeCode).sort()).toEqual(["0F 8003", "OF8032"]);
  });

  it("an admin creates an operator with a temporary password that must be changed first", async () => {
    const a = ctx(adminActor);
    operatorPassword = temporaryPassword();
    const profile = await admin.createOperator(a, { fullName: "Plant Operator", email: "op@nf.test", password: operatorPassword });
    operatorActor = { id: profile.id, role: "operator", fullName: profile.fullName, email: profile.email };
    await admin.setOperatorAccess(a, { operatorId: profile.id, projectId: plantA, granted: true });
    await expect(admin.createOperator(a, { fullName: "Duplicate", email: "OP@nf.test", password: temporaryPassword() })).rejects.toThrow(/already exists/);

    const first = await signIn(db, "op@nf.test", operatorPassword);
    expect(first).toMatchObject({ ok: true, mustChangePassword: true });
    const session = await resolveSession(db, first.ok ? first.token : "");
    await expect(changeOwnPassword(db, { userId: profile.id, email: "op@nf.test", sessionId: session!.sessionId }, "wrong", "Brand-new-pass-1")).rejects.toThrow(/not correct/);
    await expect(changeOwnPassword(db, { userId: profile.id, email: "op@nf.test", sessionId: session!.sessionId }, operatorPassword, "short")).rejects.toThrow(/10 characters/);
    await changeOwnPassword(db, { userId: profile.id, email: "op@nf.test", sessionId: session!.sessionId }, operatorPassword, "Brand-new-pass-1");
    operatorPassword = "Brand-new-pass-1";
    expect(await resolveSession(db, first.ok ? first.token : "")).toMatchObject({ mustChangePassword: false });
    // Operators cannot create accounts or reset passwords, even calling the functions directly.
    await expect(resetPassword(db, profile.id, adminActor.id, temporaryPassword())).rejects.toThrow(/only NF admins/i);
  });

  it("an operator sees only the assigned plant, even when calling the store directly", async () => {
    const op = ctx(operatorActor);
    const view = await loadRegister(op, { projectId: plantA });
    expect(view.projects.map((p) => p.id)).toEqual([plantA]);
    expect(view.rows.map((r) => r.employeeCode)).toEqual(["0F 8003"]);
    await expect(loadRegister(op, { projectId: plantB }).then((v) => v.project?.id)).resolves.toBe(plantA); // B is not offered
    // Below the services: Row Level Security still hides plant B.
    expect((await op.store.listProjects()).map((p) => p.id)).toEqual([plantA]);
    expect((await op.store.listWorkers()).map((w) => w.id)).toEqual([workerA]);
    expect(await op.store.listWorkerPayTerms()).toEqual([]);
    expect(await op.store.listAuditLogs({ limit: 50 })).toEqual([]);
    await expect(getAuditLog(op, {})).rejects.toThrow(/admin/i);
    await expect(op.store.createContractor({ name: "Sneaky", location: null }, operatorActor)).rejects.toThrow(/permission|security/i);
  });

  it("attendance persists, concurrent edits are refused, and changes are audited", async () => {
    const op = ctx(operatorActor);
    const today = todayIn(IST);
    const res = await saveAttendance(op, {
      projectId: plantA, contractorId: contractor, workDate: today,
      items: [{ workerId: workerA, status: "present", checkIn: "00:00", checkOut: null, checkInSource: "entered", method: "individual", expectedVersion: null }],
    });
    expect(res.saved).toBe(1);
    const again = await loadRegister(op, { projectId: plantA, contractorId: contractor });
    expect(again.rows[0].saved).toMatchObject({ status: "present", checkIn: "00:00", version: 1, shift: "day" });
    // A second editor still holding version null (stale) is refused.
    await expect(
      saveAttendance(op, {
        projectId: plantA, contractorId: contractor, workDate: today,
        items: [{ workerId: workerA, status: "absent", checkIn: null, checkOut: null, checkInSource: null, method: "individual", expectedVersion: null }],
      }),
    ).rejects.toThrow(/changed by someone else/);
    // The operator cannot write to plant B.
    await expect(
      saveAttendance(op, {
        projectId: plantB, contractorId: contractor, workDate: today,
        items: [{ workerId: workerB, status: "absent", checkIn: null, checkOut: null, checkInSource: null, method: "individual", expectedVersion: null }],
      }),
    ).rejects.toThrow(/not authorised|forbidden/i);
    const log = await getAuditLog(ctx(adminActor), { projectId: plantA });
    expect(log[0]).toMatchObject({ action: "create", changedByName: "Plant Operator", workerName: "Ram Kumar" });
  });

  it("a night shift ends the next morning with real timestamps", async () => {
    const a = ctx(adminActor);
    const date = addDays(todayIn(IST), -2);
    await saveAttendance(a, {
      projectId: plantB, contractorId: contractor, workDate: date, shift: "night",
      items: [{ workerId: workerB, status: "present", checkIn: "21:00", checkOut: "05:30", checkInSource: "entered", method: "individual", expectedVersion: null }],
    });
    const rec = (await a.store.listAttendance({ from: date, to: date })).find((r) => r.workerId === workerB)!;
    expect(rec.shift).toBe("night");
    expect((Date.parse(rec.checkOutAt!) - Date.parse(rec.checkInAt!)) / 3_600_000).toBe(8.5);
  });

  it("imports the worker master once (re-import adds nothing) and assigns plants", async () => {
    const a = ctx(adminActor);
    const file = { name: "master.xlsx", bytes: await buildMasterWorkbook() };
    const preview = await previewMasterImport(a, file, {});
    const res = await applyMasterImport(a, file, { choices: preview.choices, approvedChanges: [], fingerprint: preview.plan.fingerprint });
    // 7 valid rows, less "0F 8003" and "OF8032", which already belong to Test Labour Co.
    expect(res.created).toBe(5);
    const second = await previewMasterImport(a, file, {});
    expect(second.plan.totals.create).toBe(0);
    await expect(applyMasterImport(a, file, { choices: preview.choices, approvedChanges: [], fingerprint: preview.plan.fingerprint })).rejects.toThrow(/another import|changed since/i);
    const beta = (await a.store.listWorkers()).filter((w) => w.employeeCode?.match(/^(0F|OF)8/) && w.id !== workerA && w.id !== workerB);
    expect(await assignUnassignedWorkers(a, { workerIds: beta.map((w) => w.id), projectId: plantA, startDate: todayIn(IST), addContractorToPlant: true })).toBe(beta.length);
  });

  it("payment rules, payroll with commission, and the Excel export run on PostgreSQL", async () => {
    const a = ctx(adminActor);
    await admin.createPaymentRule(a, {
      contractorId: contractor, effectiveFrom: addDays(todayIn(IST), -30), allowBackdate: true, rateSource: "contractor", rateType: "per_day", dayRate: 480,
      fullDayHours: 8, shortDayPolicy: "pro_rata", overtimeEnabled: true, overtimeAfterHours: 8, overtimeAfterNightHours: 8, overtimeRateMode: "multiplier",
      overtimeMultiplier: 2, overtimeRounding: "exact", commissionEnabled: true, commissionPercent: 8, commissionScope: "all", commissionBase: "base_wages",
      commissionTreatment: "added_to_contractor_payable",
    });
    const month = addDays(todayIn(IST), -2).slice(0, 7);
    const payroll = await getPayroll(a, { month, contractorId: contractor });
    const c = payroll.contractors.find((x) => x.contractorId === contractor)!;
    const shyam = c.workerRows.find((w) => w.workerId === workerB)!;
    expect(shyam).toMatchObject({ baseWages: 480, overtimeWages: 60, commission: 38.4, totalPayable: 578.4 }); // 8.5h night: 0.5h OT × 60/h × 2
    const report = await getReport(a, { from: `${month}-01`, to: todayIn(IST) });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildAttendanceWorkbook(report, { generatedAt: "now", generatedBy: "test", projectLabel: "All", contractorLabel: "All" })) as unknown as ArrayBuffer);
    expect(wb.getWorksheet("Attendance")!.rowCount).toBeGreaterThan(1);
  });

  it("WhatsApp mock sending runs as the system account and stops when consent is withdrawn", async () => {
    const a = ctx(adminActor);
    const today = todayIn(IST);
    // Messages start today: the night shift two days ago is never messaged (no retroactive sending).
    await saveMessagingSettings(a, {
      enabled: true, paused: false, sendTime: "20:00", defaultLanguage: "hi", includeEnglish: false, attendanceTemplate: "attendance_summary_hi",
      correctionTemplate: "attendance_correction_hi", correctionNotices: true, startDate: today, testNumber: null,
    });
    const rec = (await loadRegister(a, { projectId: plantA, contractorId: contractor })).rows.find((r) => r.workerId === workerA)!.saved!;
    await saveAttendance(a, {
      projectId: plantA, contractorId: contractor, workDate: today,
      items: [{ workerId: workerA, status: "present", checkIn: rec.checkIn, checkOut: "00:01", checkInSource: rec.checkInSource, method: "individual", expectedVersion: rec.version }],
    });
    // Fictional test fixture numbers (valid format only).
    await saveWorkerContact(a, workerB, { countryCode: "+91", whatsappNumber: "9000000002", enabled: true, consentStatus: "granted", consentSource: "Test fixture" });
    await saveWorkerContact(a, workerA, { countryCode: "+91", whatsappNumber: "9000000001", enabled: true, consentStatus: "granted", consentSource: "Test fixture" });
    const system = new PostgresStore(db, { kind: "system" }, files);
    const run = await runDispatch(system, mockTransport, { now: new Date(), timezone: IST, force: true, allowFictional: false, actor: null });
    expect(run.queue?.queued).toBe(1);
    expect(run.send?.sent).toBe(1);
    const again = await runDispatch(system, mockTransport, { now: new Date(), timezone: IST, force: true, allowFictional: false, actor: null });
    expect(again.queue?.queued).toBe(0); // never twice
    await saveWorkerContact(a, workerA, { countryCode: "+91", whatsappNumber: "9000000001", enabled: true, consentStatus: "withdrawn", consentSource: "Asked to stop" });
    expect((await a.store.listConsentEvents(workerA)).map((e) => e.consentStatus)).toEqual(["withdrawn", "granted"]);
    // Operators never see contacts, settings or messages.
    const op = ctx(operatorActor);
    expect(await op.store.listWorkerContacts()).toEqual([]);
    expect(await op.store.listMessages({ limit: 10 })).toEqual([]);
    expect(await op.store.getMessagingSettings()).toBeNull();
  });

  it("deactivating an operator ends their sessions at once", async () => {
    const s = await signIn(db, "op@nf.test", operatorPassword);
    expect(s.ok).toBe(true);
    await admin.setOperatorActive(ctx(adminActor), { profileId: operatorActor.id, isActive: false });
    expect(await resolveSession(db, s.ok ? s.token : "")).toBeNull();
    expect(await signIn(db, "op@nf.test", operatorPassword)).toMatchObject({ ok: false, error: expect.stringMatching(/not active/) });
  });
});
