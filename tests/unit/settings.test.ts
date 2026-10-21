import { beforeEach, describe, expect, it } from "vitest";
import type { AppError } from "@/lib/errors";
import { toActionError } from "@/lib/server/actions/run";
import { FALLBACK_POLICY } from "@/lib/domain/policy";
import { addDays } from "@/lib/domain/time";
import * as admin from "@/lib/server/services/admin";
import { loadRegister, saveAttendance } from "@/lib/server/services/attendance";
import { getAuditLog, getReport } from "@/lib/server/services/reports";
import { createPolicyVersion, loadSettings, lockedTimezones, newSiteTimezone } from "@/lib/server/services/settings";
import type { DemoStore } from "@/lib/server/store/demo-store";
import { actors, ctxFor, freshStore, NOW, TODAY } from "./helpers";

// Attendance settings through the services (demo store): who may change them, and
// how the register and saves follow the company defaults and site overrides.

let store: DemoStore;
beforeEach(() => {
  store = freshStore();
});

/** Asserts the error code a user would get from the server action (validation errors map to "invalid"). */
const expectCode = async (p: Promise<unknown>, code: AppError["code"]) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the call to be refused").not.toBeNull();
  expect(toActionError(error).code).toBe(code);
};

const adminCtx = (now = NOW) => ctxFor(store, actors.admin, now);
const companyVersion = (o: Record<string, unknown> = {}) => ({
  projectId: null,
  effectiveFrom: TODAY,
  ...FALLBACK_POLICY,
  defaultTimezone: "Asia/Kolkata",
  ...o,
});
const present = (workerId: string, checkIn: string, o: Record<string, unknown> = {}) => ({
  workerId, status: "present", checkIn, checkOut: null, checkInSource: "entered", method: "individual", expectedVersion: null, ...o,
});

describe("only admins can see or change attendance settings (server-side)", () => {
  it("refuses every settings call from an operator", async () => {
    const op = ctxFor(store, actors.puneLucknow);
    await expectCode(loadSettings(op), "forbidden");
    await expectCode(lockedTimezones(op), "forbidden");
    await expectCode(newSiteTimezone(op), "forbidden");
    await expectCode(createPolicyVersion(op, { projectId: "p2", effectiveFrom: TODAY, overridden: ["suggestedCheckIn"], suggestedCheckIn: "06:00" }), "forbidden");
    await expectCode(createPolicyVersion(op, companyVersion({ suggestedCheckIn: "06:00" })), "forbidden");
    expect((await loadRegister(op, { projectId: "p2" })).policy?.day.suggestedCheckIn).toBe("09:00"); // unchanged
  });

  it("the register gives operators effective values only, never versions, notes or authors", async () => {
    const view = await loadRegister(ctxFor(store, actors.puneLucknow), { projectId: "p2" });
    expect(Object.keys(view.policy!).sort()).toEqual(["capture", "day", "operatorEditClosesAt", "operatorWindowClosed", "token"]);
    expect(JSON.stringify(view.policy)).not.toMatch(/notes|createdBy|Illustrative/);
  });
});

describe("company defaults and site overrides", () => {
  it("applies the company default to sites without an override; a site override wins", async () => {
    await createPolicyVersion(adminCtx(), companyVersion({ suggestedCheckIn: "08:15" }));
    const op = ctxFor(store, actors.east);
    expect((await loadRegister(op, { projectId: "p4" })).policy?.day.suggestedCheckIn).toBe("08:15"); // inherits
    expect((await loadRegister(op, { projectId: "p5" })).policy?.day.suggestedCheckIn).toBe("09:00"); // own override
  });

  it("with no suggested time, nothing is assumed: the register stays pending and 'suggested' is refused", async () => {
    const op = ctxFor(store, actors.east);
    const view = await loadRegister(op, { projectId: "p4" });
    expect(view.policy?.day.suggestedCheckIn).toBeNull();
    expect(view.rows.every((r) => r.saved === null)).toBe(true);
    const w = view.rows[0];
    const base = { projectId: "p4", contractorId: view.contractorId, workDate: TODAY };
    await expectCode(saveAttendance(op, { ...base, items: [present(w.workerId, "09:00", { checkInSource: "suggested" })] }), "invalid");
    await expectCode(saveAttendance(op, { ...base, items: [present(w.workerId, "09:00", { checkInSource: null })] }), "invalid");
    expect(await store.listAttendance({ projectIds: ["p4"], from: TODAY, to: TODAY })).toHaveLength(0);
  });

  it("a site can override a company suggestion to 'none'", async () => {
    await createPolicyVersion(adminCtx(), companyVersion({ suggestedCheckIn: "08:15" }));
    await createPolicyVersion(adminCtx(), { projectId: "p4", effectiveFrom: TODAY, overridden: ["suggestedCheckIn"], suggestedCheckIn: null });
    expect((await loadRegister(ctxFor(store, actors.east), { projectId: "p4" })).policy?.day.suggestedCheckIn).toBeNull();
  });

  it("stores an accepted suggestion as such, in the record, the change log and the report; OUT later keeps it", async () => {
    const op = ctxFor(store, actors.puneLucknow);
    const [a] = (await loadRegister(op, { projectId: "p2", contractorId: "c2" })).rows;
    const base = { projectId: "p2", contractorId: "c2", workDate: TODAY };
    await saveAttendance(op, { ...base, items: [present(a.workerId, "09:00", { checkInSource: "suggested", method: "bulk" })] });
    await saveAttendance(op, { ...base, items: [present(a.workerId, "09:00", { checkOut: "12:30", checkInSource: "entered", method: "bulk", expectedVersion: 1 })] });
    const rec = (await store.listAttendance({ projectIds: ["p2"], from: TODAY, to: TODAY })).find((r) => r.workerId === a.workerId)!;
    expect(rec).toMatchObject({ checkInSource: "suggested", version: 2 });
    const log = await getAuditLog(adminCtx(), { projectId: "p2", from: TODAY, to: TODAY });
    expect(log.filter((l) => l.workerId === a.workerId).map((l) => l.newValues.checkInSource)).toEqual(["suggested", "suggested"]);
    const report = await getReport(adminCtx(), { from: TODAY, to: TODAY, projectId: "p2" });
    expect(report.rows.find((r) => r.workerId === a.workerId)?.checkInSource).toBe("suggested");
  });
});

describe("future-time rules come from the site's policy, the same for bulk and individual", () => {
  it("gives individual and bulk saves the same verdict for the same input", async () => {
    await createPolicyVersion(adminCtx(), { projectId: "p2", effectiveFrom: TODAY, overridden: ["suggestedCheckIn", "inFutureToleranceMin", "outFutureToleranceMin"], suggestedCheckIn: "09:00", inFutureToleranceMin: 0, outFutureToleranceMin: 0 });
    const op = ctxFor(store, actors.puneLucknow);
    const rows = (await loadRegister(op, { projectId: "p2", contractorId: "c2" })).rows;
    const base = { projectId: "p2", contractorId: "c2", workDate: TODAY };
    // NOW is 12:30 IST.
    const cases: [Record<string, unknown>, boolean][] = [
      [{ checkIn: "12:30" }, true],
      [{ checkIn: "12:35" }, false],
      [{ checkIn: "09:00", checkOut: "12:30" }, true],
      [{ checkIn: "09:00", checkOut: "12:31" }, false],
    ];
    let i = 0;
    for (const [entry, ok] of cases) {
      for (const method of ["individual", "bulk"]) {
        const w = rows[i++ % rows.length];
        const current = (await store.listAttendance({ projectIds: ["p2"], from: TODAY, to: TODAY })).find((r) => r.workerId === w.workerId);
        const p = saveAttendance(op, { ...base, items: [present(w.workerId, entry.checkIn as string, { ...entry, method, expectedVersion: current?.version ?? null })] });
        if (ok) await expect(p).resolves.toMatchObject({ saved: 1 });
        else await expectCode(p, "invalid");
      }
    }
  });
});

describe("the operator edit window at midnight and the cutoff", () => {
  it("closes today's register for operators at the site's midnight (IST)", async () => {
    const at2359 = new Date("2026-10-20T18:29:00Z");
    const at0001 = new Date("2026-10-20T18:31:00Z");
    const [w] = (await loadRegister(ctxFor(store, actors.puneLucknow, at2359), { projectId: "p2", contractorId: "c2" })).rows;
    const items = [present(w.workerId, "23:50")];
    await expect(saveAttendance(ctxFor(store, actors.puneLucknow, at2359), { projectId: "p2", contractorId: "c2", workDate: TODAY, items })).resolves.toMatchObject({ saved: 1 });
    const after = ctxFor(store, actors.puneLucknow, at0001);
    await expectCode(saveAttendance(after, { projectId: "p2", contractorId: "c2", workDate: TODAY, items: [{ ...items[0], status: "absent", checkIn: null, expectedVersion: 1 }] }), "forbidden");
    const view = await loadRegister(after, { projectId: "p2", contractorId: "c2", date: TODAY });
    expect(view.today).toBe(addDays(TODAY, 1));
    expect(view.editable).toBe(false);
    expect(view.readOnlyReason).toMatch(/Past dates/);
    // Admins can still correct it.
    await expect(saveAttendance(ctxFor(store, actors.admin, at0001), { projectId: "p2", contractorId: "c2", workDate: TODAY, items: [{ ...items[0], status: "absent", checkIn: null, expectedVersion: 1 }] })).resolves.toMatchObject({ saved: 1 });
  });

  it("uses each site's own timezone (Nepal, +05:45)", async () => {
    const a = adminCtx();
    const project = await admin.createProject(a, { name: "Kathmandu Test Site", location: "Kathmandu, Nepal", timezone: "Asia/Kathmandu" });
    await admin.addContractorToProject(a, { contractorId: "c2", projectId: project.id, startDate: "2026-10-01" });
    const worker = await admin.createWorker(a, { fullName: "Test Worker", contractorId: "c2", projectId: project.id, startDate: "2026-10-01" });
    await admin.setOperatorAccess(a, { operatorId: actors.puneLucknow.id, projectId: project.id, granted: true });
    const at2359 = new Date("2026-10-20T18:14:00Z"); // 23:59 in Kathmandu, 23:44 in India
    const at0001 = new Date("2026-10-20T18:16:00Z"); // 00:01 in Kathmandu, still the 20th in India
    const view = await loadRegister(ctxFor(store, actors.puneLucknow, at2359), { projectId: project.id });
    expect(view.today).toBe("2026-10-20");
    const item = present(worker.id, "23:55");
    await expect(saveAttendance(ctxFor(store, actors.puneLucknow, at2359), { projectId: project.id, contractorId: "c2", workDate: "2026-10-20", items: [item] })).resolves.toMatchObject({ saved: 1 });
    expect((await loadRegister(ctxFor(store, actors.puneLucknow, at0001), { projectId: project.id })).today).toBe("2026-10-21");
    await expectCode(
      saveAttendance(ctxFor(store, actors.puneLucknow, at0001), { projectId: project.id, contractorId: "c2", workDate: "2026-10-20", items: [{ ...item, checkIn: "23:56", expectedVersion: 1 }] }),
      "forbidden",
    );
  });

  it("past days + cutoff: yesterday is editable only until the cutoff time today", async () => {
    // Jaipur (p1) lets operators edit 1 past day; add a 10:00 cutoff (repeating the site's other settings).
    const settings = await loadSettings(adminCtx());
    const p1 = settings.sites.find((s) => s.project.id === "p1")!;
    const keep = Object.fromEntries(p1.current!.overridden.map((f) => [f, p1.current![f]]));
    await createPolicyVersion(adminCtx(), { projectId: "p1", effectiveFrom: TODAY, overridden: [...p1.current!.overridden, "editCutoffTime"], ...keep, editCutoffTime: "10:00" });
    const yesterday = addDays(TODAY, -1);
    const before = ctxFor(store, actors.jaipur, new Date("2026-10-20T04:29:00Z")); // 09:59 IST
    const after = ctxFor(store, actors.jaipur, new Date("2026-10-20T04:31:00Z")); // 10:01 IST
    expect((await loadRegister(before, { projectId: "p1", contractorId: "c1", date: yesterday })).editable).toBe(true);
    const view = await loadRegister(after, { projectId: "p1", contractorId: "c1", date: yesterday });
    expect(view.editable).toBe(false);
    const w = view.rows.find((r) => r.saved?.status === "absent") ?? view.rows[0];
    await expectCode(
      saveAttendance(after, { projectId: "p1", contractorId: "c1", workDate: yesterday, items: [present(w.workerId, "09:00", { expectedVersion: w.saved?.version ?? null })] }),
      "forbidden",
    );
  });

  it("refuses future work dates for everyone", async () => {
    const [w] = (await loadRegister(adminCtx(), { projectId: "p2", contractorId: "c2" })).rows;
    await expectCode(saveAttendance(adminCtx(), { projectId: "p2", contractorId: "c2", workDate: addDays(TODAY, 1), items: [{ ...present(w.workerId, "09:00"), status: "absent", checkIn: null }] }), "invalid");
  });
});

describe("auto-absent is off by default and report-only when on", () => {
  it("shows unmarked workers as 'absent – not marked' only when enabled, without writing records", async () => {
    const yesterday = addDays(TODAY, -1);
    const q = { from: yesterday, to: TODAY, projectId: "p2" };
    const off = await getReport(adminCtx(), q);
    expect(off.totals.notMarkedAbsentDays).toBe(0);
    const pendingYesterday = off.rows.filter((r) => r.workDate === yesterday && r.status === "pending").length;
    const pendingToday = off.rows.filter((r) => r.workDate === TODAY && r.status === "pending").length;
    expect(pendingYesterday + pendingToday).toBe(off.totals.pendingDays);

    const records = (await store.listAttendance({ projectIds: ["p2"], from: yesterday, to: TODAY })).length;
    await createPolicyVersion(adminCtx(), { projectId: "p2", effectiveFrom: "2026-01-01", allowBackdate: true, overridden: ["suggestedCheckIn", "autoAbsentEnabled"], suggestedCheckIn: "09:00", autoAbsentEnabled: true });
    const on = await getReport(adminCtx(), q);
    expect(on.totals.notMarkedAbsentDays).toBe(pendingYesterday); // yesterday's window closed at midnight
    expect(on.totals.pendingDays).toBe(pendingToday); // today's is still open
    expect(on.totals.presentDays).toBe(off.totals.presentDays);
    expect(on.totals.amount).toBe(off.totals.amount);
    expect((await store.listAttendance({ projectIds: ["p2"], from: yesterday, to: TODAY })).length).toBe(records);
    // Grouped totals carry the same count as the grand total.
    expect(on.byContractorProject.reduce((n, g) => n + g.totals.notMarkedAbsentDays, 0)).toBe(on.totals.notMarkedAbsentDays);
    expect(on.byContractor.reduce((n, g) => n + g.totals.notMarkedAbsentDays, 0)).toBe(on.totals.notMarkedAbsentDays);
  });
});

describe("versions, retroactivity and concurrency", () => {
  it("refuses a version that starts in the past unless confirmed, and numbers versions per scope", async () => {
    const yesterday = addDays(TODAY, -1);
    const site = { projectId: "p3", effectiveFrom: yesterday, overridden: ["suggestedCheckIn"], suggestedCheckIn: "08:00" };
    await expectCode(createPolicyVersion(adminCtx(), site), "invalid");
    const v = await createPolicyVersion(adminCtx(), { ...site, allowBackdate: true });
    expect(v).toMatchObject({ projectId: "p3", version: 2, createdBy: actors.admin.id });
    await expectCode(createPolicyVersion(adminCtx(), companyVersion({ effectiveFrom: yesterday })), "invalid");
    expect((await createPolicyVersion(adminCtx(), companyVersion())).version).toBe(2);
  });

  it("gives the settings form the snapshot in force on each date, and the company values a site inherits", async () => {
    const later = addDays(TODAY, 10);
    await createPolicyVersion(adminCtx(), { projectId: "p2", effectiveFrom: later, overridden: ["suggestedCheckIn", "operatorBackdateDays"], suggestedCheckIn: "09:00", operatorBackdateDays: 2 });
    const view = await loadSettings(adminCtx());
    const p2 = view.sites.find((s) => s.project.id === "p2")!;
    const at = (date: string) => p2.snapshots.filter((s) => s.from <= date).at(-1)!;
    expect(p2.snapshots.map((s) => s.from)).toEqual(["1900-01-01", TODAY, later]);
    expect(at(TODAY)).toMatchObject({ overridden: ["suggestedCheckIn"], values: { suggestedCheckIn: "09:00", operatorBackdateDays: 0 } });
    // Editing from `later` starts from the scheduled version, so its backdate override is not dropped.
    expect(at(later)).toMatchObject({ overridden: ["suggestedCheckIn", "operatorBackdateDays"], values: { operatorBackdateDays: 2 } });
    // What "Company default" would give the site, not the site's own value.
    expect(at(TODAY).company.suggestedCheckIn).toBeNull();
    expect(p2.versionDates).toEqual(["1900-01-01", later]);

    // Company: a past date previews the company values in force then; a scheduled timezone change is kept.
    const yesterday = addDays(TODAY, -1);
    await createPolicyVersion(adminCtx(), companyVersion({ effectiveFrom: TODAY, suggestedCheckIn: "08:00" }));
    await createPolicyVersion(adminCtx(), companyVersion({ effectiveFrom: later, suggestedCheckIn: "08:00", defaultTimezone: "Asia/Kathmandu" }));
    const company = (await loadSettings(adminCtx())).company;
    const cAt = (date: string) => company.snapshots.filter((s) => s.from <= date).at(-1)!;
    expect(cAt(yesterday).company.suggestedCheckIn).toBeNull();
    expect(cAt(TODAY).company.suggestedCheckIn).toBe("08:00");
    expect(cAt(later).defaultTimezone).toBe("Asia/Kathmandu");
    expect(cAt(TODAY).defaultTimezone).toBe("Asia/Kolkata");
  });

  it("validates versions on the server", async () => {
    await expectCode(createPolicyVersion(adminCtx(), companyVersion({ inFutureToleranceMin: null })), "invalid");
    await expectCode(createPolicyVersion(adminCtx(), companyVersion({ shiftStart: "09:00", shiftEnd: null })), "invalid");
    await expectCode(createPolicyVersion(adminCtx(), companyVersion({ defaultTimezone: "Mars/Olympus" })), "invalid");
    await expectCode(createPolicyVersion(adminCtx(), { projectId: "p2", effectiveFrom: TODAY, overridden: ["allowOvernight"], allowOvernight: null }), "invalid");
    await expectCode(createPolicyVersion(adminCtx(), { projectId: "nope", effectiveFrom: TODAY, overridden: [] }), "not_found");
  });

  it("rejects a save made with settings that changed after the register was loaded", async () => {
    const op = ctxFor(store, actors.puneLucknow);
    const view = await loadRegister(op, { projectId: "p2", contractorId: "c2" });
    await createPolicyVersion(adminCtx(), { projectId: "p2", effectiveFrom: TODAY, overridden: ["suggestedCheckIn"], suggestedCheckIn: "09:30" });
    const item = present(view.rows[0].workerId, "09:00", { checkInSource: "suggested" });
    await expectCode(saveAttendance(op, { projectId: "p2", contractorId: "c2", workDate: TODAY, items: [item], policyToken: view.policy!.token }), "stale_settings");
    const fresh = await loadRegister(op, { projectId: "p2", contractorId: "c2" });
    expect(fresh.policy!.token).not.toBe(view.policy!.token);
    expect(fresh.policy!.day.suggestedCheckIn).toBe("09:30");
  });
});

describe("site timezone and labels", () => {
  it("locks a site's timezone once it has attendance", async () => {
    const a = adminCtx();
    expect(await lockedTimezones(a)).toContain("p2");
    await expectCode(admin.updateProject(a, "p2", { name: "District Hospital Fire Safety Retrofit (Demo)", location: "Pune, Maharashtra", isActive: true, timezone: "Asia/Dubai" }), "invalid");
    const fresh = await admin.createProject(a, { name: "New Site", location: "Somewhere", timezone: "Asia/Kolkata" });
    await admin.updateProject(a, fresh.id, { name: "New Site", location: "Somewhere", isActive: true, timezone: "Asia/Dubai" });
    expect((await store.listProjects()).find((p) => p.id === fresh.id)?.timezone).toBe("Asia/Dubai");
    await expectCode(admin.createProject(a, { name: "Bad Site", location: "Nowhere", timezone: "IST-ish" }), "invalid");
  });

  it("labels late arrivals from the site's shift start and grace, without changing pay", async () => {
    // Jaipur (p1): shift 09:00, 15 min grace (illustrative demo settings).
    const op = ctxFor(store, actors.jaipur);
    const view = await loadRegister(op, { projectId: "p1", contractorId: "c1" });
    const w = view.rows.find((r) => r.saved === null)!;
    await saveAttendance(op, { projectId: "p1", contractorId: "c1", workDate: TODAY, items: [present(w.workerId, "09:20", { checkOut: "12:00" })] });
    const report = await getReport(adminCtx(), { from: TODAY, to: TODAY, projectId: "p1" });
    const row = report.rows.find((r) => r.workerId === w.workerId)!;
    expect(row.labels).toMatchObject({ lateMinutes: 20, halfDay: true, overtimeMinutes: null });
    expect(row.calc.amountState).toBe("ok"); // pay still comes from the contractor's payment rule
  });

  it("preselects the company timezone for new sites", async () => {
    expect(await newSiteTimezone(adminCtx())).toBe("Asia/Kolkata");
    await createPolicyVersion(adminCtx(), companyVersion({ defaultTimezone: "Asia/Kathmandu" }));
    expect(await newSiteTimezone(adminCtx())).toBe("Asia/Kathmandu");
  });
});
