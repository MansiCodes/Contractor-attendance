import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateDay, legacyRuleSettings } from "@/lib/domain/calc";
import { buildPayroll } from "@/lib/domain/payroll";
import { buildReport } from "@/lib/domain/report";
import { localToInstant } from "@/lib/domain/time";
import type { PaymentRule } from "@/lib/domain/types";
import { readWorkbookGrids } from "@/lib/import/xlsx-grid";
import { processQueue } from "@/lib/server/messaging/dispatcher";
import { cloudApiTransport, mockTransport } from "@/lib/server/messaging/transport";
import { loadRegister, saveAttendance } from "@/lib/server/services/attendance";
import { applyMasterImport, previewMasterImport } from "@/lib/server/services/master-import";
import { saveMessagingSettings, saveWorkerContact } from "@/lib/server/services/messaging";
import { changeWorkerPayTerms } from "@/lib/server/services/pay";
import { actors, ctxFor, freshStore, NOW, TODAY } from "./helpers";
import { buildMasterWorkbook } from "./master-fixture";

// Regression tests for the issues found in the independent review of V2.

const at = (d: string, t: string) => localToInstant(d, t, "Asia/Kolkata").toISOString();

describe("Imports and pay terms under concurrency", () => {
  it("the same preview applied twice at once creates the workers only once", async () => {
    const store = freshStore();
    const ctx = ctxFor(store, actors.admin);
    const file = { name: "master.xlsx", bytes: await buildMasterWorkbook() };
    const preview = await previewMasterImport(ctx, file, {});
    const options = { choices: preview.choices, approvedChanges: [], fingerprint: preview.plan.fingerprint };
    const results = await Promise.allSettled([applyMasterImport(ctx, file, options), applyMasterImport(ctx, file, options)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.listContractors()).filter((c) => c.name === "Beta")).toHaveLength(1);
    expect((await store.listWorkers()).filter((w) => w.employeeCode === "0F 8003")).toHaveLength(1);
  });

  it("two pay-term changes at the same moment never silently undo each other", async () => {
    const store = freshStore();
    const ctx = ctxFor(store, actors.admin);
    const w = (await store.listWorkers()).find((x) => x.contractorId === "c2")!;
    const results = await Promise.allSettled([
      changeWorkerPayTerms(ctx, { workerIds: [w.id], effectiveFrom: TODAY, rateAmount: 500 }),
      changeWorkerPayTerms(ctx, { workerIds: [w.id], effectiveFrom: TODAY, commissionEligible: true }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/changed meanwhile/);
  });
});

describe("Shifts", () => {
  it("a night-shift save cannot take over a day-shift record", async () => {
    const store = freshStore();
    const op = ctxFor(store, actors.pvc);
    const row = (await loadRegister(op, { projectId: "p1", contractorId: "c1" })).rows.find((r) => r.saved)!;
    await expect(
      saveAttendance(op, {
        projectId: "p1", contractorId: "c1", workDate: TODAY, shift: "night",
        items: [{ workerId: row.workerId, status: "absent", checkIn: null, checkOut: null, checkInSource: null, method: "individual", expectedVersion: row.saved!.version }],
      }),
    ).rejects.toThrow(/day shift/);
    // The store refuses it too, whatever the caller.
    await expect(
      store.saveAttendance("p1", TODAY, [{ workerId: row.workerId, contractorId: "c1", status: "absent", checkInAt: null, checkOutAt: null, checkInSource: null, shift: "night", method: "individual", expectedVersion: row.saved!.version }], actors.pvc),
    ).rejects.toThrow(/day shift/);
  });
});

describe("Payment settings that are not decided", () => {
  const rule = (r: Partial<PaymentRule>): PaymentRule => {
    const base = {
      id: "r", contractorId: "c", version: 1, effectiveFrom: "2026-01-01", rateType: "per_day" as const, dayRate: 480, hourRate: null, fullDayHours: 8,
      halfDayHours: null, overtimeEnabled: false, overtimeAfterHours: null, overtimeHourRate: null, unpaidBreakMinutes: 0, notes: null, createdAt: "", createdBy: null,
    };
    return { ...base, ...legacyRuleSettings(base), shortDayPolicy: "pro_rata", ...r };
  };

  it("commission switched on without saying who it applies to blocks the total instead of counting as zero", () => {
    const r = rule({ id: "rc", contractorId: "c", commissionEnabled: true, commissionPercent: 10, commissionScope: null });
    const report = buildReport({
      from: TODAY, to: TODAY, projects: [{ id: "p", name: "P", location: "L", isActive: true, timezone: "Asia/Kolkata", createdAt: "", updatedAt: "" }],
      contractors: [{ id: "c", name: "C", location: null, legalName: null, identityStatus: "confirmed", identityNote: null, photoPath: null, photoUrl: null, isActive: true, createdAt: "", updatedAt: "" }],
      workers: [{ id: "w", code: "W-1", employeeCode: null, fullName: "W", contractorId: "c", department: null, designation: null, isActive: true, phone: null, notes: null, source: null, createdAt: "", updatedAt: "" }],
      assignments: [{ id: "a", workerId: "w", projectId: "p", contractorId: "c", startDate: "2026-01-01", endDate: null, createdAt: "" }],
      records: [{ id: "x", workerId: "w", projectId: "p", contractorId: "c", workDate: TODAY, status: "present", checkInAt: at(TODAY, "08:00"), checkOutAt: at(TODAY, "16:00"), checkInSource: "entered", shift: "day", method: "individual", version: 1, createdAt: "", updatedAt: "", createdBy: null, updatedBy: null }],
      rules: [r], todayByProject: { p: TODAY },
    });
    const c = buildPayroll(report, [r], []).contractors[0];
    expect(c.baseWages).toBe(480);
    expect(c.commission).toBeNull();
    expect(c.totalPayable).toBeNull();
    expect(c.missing).toContain("Who commission applies to");
  });

  it("rules saved before v2 total exactly as before (one rounding)", () => {
    const r = rule({ rateType: "per_hour", dayRate: null, hourRate: 75.01, fullDayHours: null, overtimeEnabled: true, overtimeAfterHours: 8.25, overtimeHourRate: 100 });
    const legacy = { ...r, ...legacyRuleSettings(r) };
    const c = calculateDay({ status: "present", checkInAt: at(TODAY, "08:00"), checkOutAt: at(TODAY, "16:17") }, legacy);
    expect(c.amount).toBe(622.17);
    expect((c.baseAmount ?? 0) + (c.overtimeAmount ?? 0)).toBeCloseTo(622.17, 2);
  });
});

describe("Excel reading", () => {
  it("a formula employee ID shown as 000123 keeps its zeros", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.getCell("A1").value = { formula: "100+23", result: 123 };
    ws.getCell("A1").numFmt = "000000";
    const [grid] = await readWorkbookGrids(new Uint8Array(await wb.xlsx.writeBuffer()));
    expect(grid.cells[0]).toMatchObject({ value: "000123", formula: true });
  });
});

describe("WhatsApp sending", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function queuedFor(store: ReturnType<typeof freshStore>) {
    const admin = ctxFor(store, actors.admin);
    await saveMessagingSettings(admin, {
      enabled: true, paused: false, sendTime: "20:00", defaultLanguage: "hi", includeEnglish: false, attendanceTemplate: "attendance_summary_hi",
      correctionTemplate: "attendance_correction_hi", correctionNotices: true, startDate: TODAY, testNumber: null,
    });
    const op = ctxFor(store, actors.pvc);
    const rows = (await loadRegister(op, { projectId: "p1", contractorId: "c1" })).rows;
    const contact = (await store.listWorkerContacts()).find(
      (c) => c.consentStatus === "granted" && c.enabled && !c.whatsappNumber!.endsWith("0000") && rows.some((r) => r.workerId === c.workerId && r.saved?.status === "present"),
    );
    if (!contact) return null;
    const row = rows.find((r) => r.workerId === contact.workerId)!;
    const [saved] = (
      await saveAttendance(op, {
        projectId: "p1", contractorId: "c1", workDate: TODAY,
        items: [{ workerId: row.workerId, status: "present", checkIn: row.saved!.checkIn, checkOut: "12:00", checkInSource: row.saved!.checkInSource, method: "individual", expectedVersion: row.saved!.version }],
      })
    ).rows;
    const record = (await store.listAttendance({ from: TODAY, to: TODAY })).find((r) => r.workerId === saved.workerId)!;
    await store.enqueueMessages(
      [{ idempotencyKey: `att:${record.id}`, kind: "attendance", workerId: record.workerId, attendanceId: record.id, attendanceVersion: record.version, contractorId: "c1", projectId: "p1", workDate: TODAY, shift: "day", to: `+999${contact.whatsappNumber}`, language: "hi", templateName: "t", params: [], body: "old text" }],
      null,
    );
    return { contact, record, admin };
  }

  it("a queued message is checked again before sending: withdrawn consent cancels it", async () => {
    const store = freshStore();
    const q = await queuedFor(store);
    expect(q).not.toBeNull();
    await saveWorkerContact(q!.admin, q!.contact.workerId, { countryCode: "+999", whatsappNumber: q!.contact.whatsappNumber, enabled: true, consentStatus: "withdrawn", consentSource: "Asked to stop" });
    const res = await processQueue(store, mockTransport, NOW, true);
    expect(res).toMatchObject({ sent: 0, cancelled: 1 });
    expect((await store.listMessages({ limit: 5 }))[0]).toMatchObject({ status: "cancelled", lastError: expect.stringMatching(/consent/i) });
  });

  it("a queued message is sent with text rebuilt from the record as it is now", async () => {
    const store = freshStore();
    await queuedFor(store);
    const res = await processQueue(store, mockTransport, NOW, true);
    expect(res.sent).toBe(1);
    const [m] = await store.listMessages({ limit: 1 });
    expect(m.body).not.toBe("old text");
    expect(m.body).toContain("12:00 PM"); // the OUT time saved after it was queued, in the worker's language
  });

  it("a network error is not retried automatically (Meta may already have the message)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));
    const t = cloudApiTransport({ WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "1" });
    expect(await t.send({ to: "+919876543210", templateName: "x", language: "hi", params: [] })).toMatchObject({ ok: false, retryable: false });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "rate" } }), { status: 429 })));
    expect(await t.send({ to: "+919876543210", templateName: "x", language: "hi", params: [] })).toMatchObject({ ok: false, retryable: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
    expect(await t.send({ to: "+919876543210", templateName: "x", language: "hi", params: [] })).toMatchObject({ ok: false, retryable: false });
  });

  it("delivery statuses: a failure after sent is final, and an early status is applied once the send is saved", async () => {
    const store = freshStore();
    await store.enqueueMessages([{ idempotencyKey: "test:1", kind: "test", workerId: null, attendanceId: null, attendanceVersion: null, contractorId: null, projectId: null, workDate: null, shift: null, to: "+9995550199", language: "hi", templateName: "t", params: [], body: "b" }], null);
    const [m] = await store.claimDueMessages(NOW.toISOString(), 5);
    // "delivered" arrives before the send result is saved.
    expect(await store.applyMessageStatus("wamid.1", "delivered", NOW.toISOString(), null)).toBe(false);
    await store.completeMessage(m.id, { status: "sent", providerMessageId: "wamid.1", transport: "mock", at: NOW.toISOString() });
    expect((await store.listMessages({ limit: 1 }))[0].status).toBe("delivered");
    await store.applyMessageStatus("wamid.1", "failed", NOW.toISOString(), "Undeliverable");
    await store.applyMessageStatus("wamid.1", "sent", NOW.toISOString(), null);
    await store.applyMessageStatus("wamid.1", "read", NOW.toISOString(), null);
    expect((await store.listMessages({ limit: 1 }))[0]).toMatchObject({ status: "failed", lastError: "Undeliverable" });
  });
});
