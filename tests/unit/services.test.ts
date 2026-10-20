import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { loadRegister, saveAttendance, dailySummaries } from "@/lib/server/services/attendance";
import * as admin from "@/lib/server/services/admin";
import { getAuditLog, getOverview, getReport } from "@/lib/server/services/reports";
import type { DemoStore } from "@/lib/server/store/demo-store";
import { addDays } from "@/lib/domain/time";
import { actors, ctxFor, freshStore, NOW, TODAY } from "./helpers";

let store: DemoStore;
beforeEach(() => {
  store = freshStore();
});

const expectCode = async (p: Promise<unknown>, code: AppError["code"]) => {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await p.catch((e: AppError) => expect(e.code).toBe(code));
};

/** First pending worker on the Pune (p2) / Pragati (c2) register today. */
async function puneRegister() {
  return loadRegister(ctxFor(store, actors.puneLucknow), { projectId: "p2", contractorId: "c2" });
}

describe("1. operators cannot create or change workers", () => {
  it("rejects worker creation, deactivation, transfer and rate changes by an operator", async () => {
    const op = ctxFor(store, actors.puneLucknow);
    await expectCode(admin.createWorker(op, { fullName: "Test Worker", contractorId: "c2", projectId: "p2", startDate: TODAY }), "forbidden");
    await expectCode(admin.deactivateWorker(op, "w1", { lastWorkingDate: TODAY }), "forbidden");
    await expectCode(admin.transferWorker(op, "w1", { projectId: "p3", contractorId: "c1", effectiveDate: TODAY }), "forbidden");
    await expectCode(admin.createPaymentRule(op, { contractorId: "c4", effectiveFrom: TODAY, rateType: "per_day", dayRate: 1 }), "forbidden");
    await expectCode(admin.setOperatorAccess(op, { operatorId: actors.puneLucknow.id, projectId: "p1", granted: true }), "forbidden");
    expect((await store.listWorkers()).some((w) => w.fullName === "Test Worker")).toBe(false);
  });
});

describe("2. operators cannot access unauthorised project data", () => {
  it("only lists assigned sites and never loads another site's register", async () => {
    const view = await loadRegister(ctxFor(store, actors.puneLucknow), { projectId: "p1" });
    expect(view.projects.map((p) => p.id).sort()).toEqual(["p2", "p3"]);
    expect(view.project?.id).not.toBe("p1");
  });

  it("rejects saving attendance for a site the operator is not assigned to", async () => {
    const jaipur = await loadRegister(ctxFor(store, actors.jaipur), { projectId: "p1", contractorId: "c2" });
    const w = jaipur.rows[0];
    await expectCode(
      saveAttendance(ctxFor(store, actors.puneLucknow), {
        projectId: "p1", contractorId: "c2", workDate: TODAY,
        items: [{ workerId: w.workerId, status: "absent", checkIn: null, checkOut: null, method: "individual", expectedVersion: w.saved?.version ?? null }],
      }),
      "forbidden",
    );
  });

  it("blocks company-wide reports, payables and audit logs for operators", async () => {
    const op = ctxFor(store, actors.jaipur);
    await expectCode(getReport(op, { from: "2026-10-01", to: TODAY }), "forbidden");
    await expectCode(getOverview(op), "forbidden");
    await expectCode(getAuditLog(op, {}), "forbidden");
    const days = await dailySummaries(op, { days: 7 });
    expect(new Set(days.map((d) => d.projectId))).toEqual(new Set(["p1"]));
  });

  it("restricts operators to today (by default) but lets admins correct past dates", async () => {
    const yesterday = addDays(TODAY, -1);
    const view = await loadRegister(ctxFor(store, actors.puneLucknow), { projectId: "p2", contractorId: "c2", date: yesterday });
    expect(view.editable).toBe(false);
    const row = view.rows[0];
    const item = { workerId: row.workerId, status: "absent" as const, checkIn: null, checkOut: null, method: "individual" as const, expectedVersion: row.saved?.version ?? null };
    await expectCode(saveAttendance(ctxFor(store, actors.puneLucknow), { projectId: "p2", contractorId: "c2", workDate: yesterday, items: [item] }), "forbidden");
    const res = await saveAttendance(ctxFor(store, actors.admin), { projectId: "p2", contractorId: "c2", workDate: yesterday, items: [item] });
    expect(res.saved).toBeLessThanOrEqual(1);
  });

  it("rejects future dates for everyone", async () => {
    const view = await puneRegister();
    const row = view.rows[0];
    await expectCode(
      saveAttendance(ctxFor(store, actors.admin), {
        projectId: "p2", contractorId: "c2", workDate: addDays(TODAY, 1),
        items: [{ workerId: row.workerId, status: "absent", checkIn: null, checkOut: null, method: "individual", expectedVersion: null }],
      }),
      "invalid",
    );
  });
});

describe("3–4. admin manages workers; workers appear only on their assigned site", () => {
  it("adds a worker who then appears only on that site's register", async () => {
    const a = ctxFor(store, actors.admin);
    const w = await admin.createWorker(a, { fullName: "नया कामगार", contractorId: "c2", projectId: "p2", startDate: TODAY });
    expect(w.code).toMatch(/^W-\d{5}$/);
    expect((await puneRegister()).rows.some((r) => r.workerId === w.id)).toBe(true);
    const jaipur = await loadRegister(a, { projectId: "p1", contractorId: "c2" });
    expect(jaipur.rows.some((r) => r.workerId === w.id)).toBe(false);
  });

  it("cannot deploy a worker where the contractor is not assigned", async () => {
    await expectCode(
      admin.createWorker(ctxFor(store, actors.admin), { fullName: "Wrong Site", contractorId: "c3", projectId: "p1", startDate: TODAY }),
      "invalid",
    );
  });

  it("deactivated workers leave the register after their last working date but keep history", async () => {
    const a = ctxFor(store, actors.admin);
    const view = await puneRegister();
    const target = view.rows.find((r) => r.saved === null)!;
    await admin.deactivateWorker(a, target.workerId, { lastWorkingDate: addDays(TODAY, -1) });
    expect((await puneRegister()).rows.some((r) => r.workerId === target.workerId)).toBe(false);
    const past = await loadRegister(a, { projectId: "p2", contractorId: "c2", date: addDays(TODAY, -3) });
    expect(past.rows.some((r) => r.workerId === target.workerId)).toBe(true);
    await admin.reactivateWorker(a, target.workerId, { projectId: "p2", startDate: TODAY });
    expect((await puneRegister()).rows.some((r) => r.workerId === target.workerId)).toBe(true);
  });
});

describe("5–8. attendance capture rules", () => {
  it("loading the register creates no records: everyone starts pending with a suggested 9 AM", async () => {
    const before = (await store.listAttendance({ from: TODAY, to: TODAY })).length;
    const view = await puneRegister();
    expect(view.project?.defaultCheckIn).toBe("09:00");
    expect(view.rows.every((r) => r.saved === null)).toBe(true);
    expect((await store.listAttendance({ from: TODAY, to: TODAY })).length).toBe(before);
    const report = await getReport(ctxFor(store, actors.admin), { from: TODAY, to: TODAY, projectId: "p2", contractorId: "c2" });
    expect(report.totals.presentDays).toBe(0);
    expect(report.totals.pendingDays).toBe(view.rows.length);
    expect(report.totals.amount).toBe(0);
  });

  it("confirms presence, late arrival, absence and checkout; totals follow", async () => {
    const op = ctxFor(store, actors.puneLucknow);
    const [a, b, c] = (await puneRegister()).rows;
    await saveAttendance(op, {
      projectId: "p2", contractorId: "c2", workDate: TODAY,
      items: [
        { workerId: a.workerId, status: "present", checkIn: "09:00", checkOut: "12:00", method: "individual", expectedVersion: null },
        { workerId: b.workerId, status: "present", checkIn: "10:15", checkOut: null, method: "individual", expectedVersion: null },
        { workerId: c.workerId, status: "absent", checkIn: null, checkOut: null, method: "individual", expectedVersion: null },
      ],
    });
    const report = await getReport(ctxFor(store, actors.admin), { from: TODAY, to: TODAY, projectId: "p2", contractorId: "c2" });
    const row = (id: string) => report.rows.find((r) => r.workerId === id)!;
    expect(row(a.workerId).calc.netMinutes).toBe(150); // 3h minus 30 min break (Pragati demo rule)
    expect(row(a.workerId).calc.amount).toBe(212.5); // 2.5h × ₹85
    expect(row(b.workerId).checkIn).toBe("10:15");
    expect(row(b.workerId).calc.incomplete).toBe(true);
    expect(row(b.workerId).calc.amount).toBeNull();
    expect(row(c.workerId).calc.amount).toBe(0);
    expect(report.totals.presentDays).toBe(2);
    expect(report.totals.absentDays).toBe(1);
    expect(report.totals.incompleteDays).toBe(1);
    expect(report.totals.amount).toBe(212.5);
  });

  it("rejects OUT before IN, and OUT in the future", async () => {
    const op = ctxFor(store, actors.puneLucknow);
    const [a] = (await puneRegister()).rows;
    const base = { projectId: "p2", contractorId: "c2", workDate: TODAY };
    await expectCode(saveAttendance(op, { ...base, items: [{ workerId: a.workerId, status: "present", checkIn: "09:00", checkOut: "08:00", method: "individual", expectedVersion: null }] }), "invalid");
    // NOW is 12:30 IST — an 18:00 checkout has not happened yet.
    await expectCode(saveAttendance(op, { ...base, items: [{ workerId: a.workerId, status: "present", checkIn: "09:00", checkOut: "18:00", method: "individual", expectedVersion: null }] }), "invalid");
    expect((await store.listAttendance({ projectIds: ["p2"], from: TODAY, to: TODAY })).length).toBe(0);
  });

  it("saves are all-or-nothing", async () => {
    const op = ctxFor(store, actors.puneLucknow);
    const [a, b] = (await puneRegister()).rows;
    await expectCode(
      saveAttendance(op, {
        projectId: "p2", contractorId: "c2", workDate: TODAY,
        items: [
          { workerId: a.workerId, status: "present", checkIn: "09:00", checkOut: null, method: "individual", expectedVersion: null },
          { workerId: b.workerId, status: "present", checkIn: "09:00", checkOut: "08:30", method: "individual", expectedVersion: null },
        ],
      }),
      "invalid",
    );
    expect((await store.listAttendance({ projectIds: ["p2"], from: TODAY, to: TODAY })).length).toBe(0);
  });

  it("detects concurrent edits with record versions", async () => {
    const op = ctxFor(store, actors.puneLucknow);
    const [a] = (await puneRegister()).rows;
    const item = { workerId: a.workerId, status: "present" as const, checkIn: "09:00", checkOut: null, method: "individual" as const, expectedVersion: null };
    await saveAttendance(op, { projectId: "p2", contractorId: "c2", workDate: TODAY, items: [item] });
    await expectCode(saveAttendance(op, { projectId: "p2", contractorId: "c2", workDate: TODAY, items: [{ ...item, status: "absent", checkIn: null }] }), "conflict");
  });

  it("supports overnight shifts only where enabled (Bhubaneswar demo site)", async () => {
    const lateNow = new Date("2026-10-20T00:30:00.000Z"); // 06:00 IST on the 20th
    const east = ctxFor(store, actors.east, lateNow);
    const yesterday = addDays(TODAY, -1);
    const a = ctxFor(store, actors.admin, lateNow);
    const view = await loadRegister(a, { projectId: "p5", contractorId: "c4", date: yesterday });
    const w = view.rows[0];
    await saveAttendance(a, {
      projectId: "p5", contractorId: "c4", workDate: yesterday,
      items: [{ workerId: w.workerId, status: "present", checkIn: "21:00", checkOut: "05:30", method: "individual", expectedVersion: w.saved?.version ?? null }],
    });
    const rec = (await store.listAttendance({ projectIds: ["p5"], from: yesterday, to: yesterday })).find((r) => r.workerId === w.workerId)!;
    expect(rec.checkOutAt).toBe("2026-10-20T00:00:00.000Z"); // 05:30 IST next day
    expect(east.actor.role).toBe("operator");
  });
});

describe("9–10. totals and multi-site contractors", () => {
  it("contractor and grand totals equal the sum of their rows", async () => {
    const report = await getReport(ctxFor(store, actors.admin), { from: "2026-10-01", to: TODAY });
    const sum = (f: (r: (typeof report.rows)[number]) => number) => Math.round(report.rows.reduce((s, r) => s + f(r), 0) * 100) / 100;
    expect(report.totals.presentDays).toBe(report.rows.filter((r) => r.status === "present").length);
    expect(report.totals.amount).toBe(sum((r) => (r.calc.amountState === "ok" ? r.calc.amount ?? 0 : 0)));
    expect(report.totals.netHours).toBe(sum((r) => (r.calc.complete ? r.calc.netHours ?? 0 : 0)));
    const groupSum = Math.round(report.byContractor.reduce((s, g) => s + g.totals.amount, 0) * 100) / 100;
    expect(groupSum).toBe(report.totals.amount);
    for (const g of report.byContractor) {
      const parts = report.byContractorProject.filter((p) => p.contractorId === g.contractorId);
      expect(parts.reduce((s, p) => s + p.totals.presentDays, 0)).toBe(g.totals.presentDays);
    }
  });

  it("a contractor deployed at several sites is reported per site and in total", async () => {
    const report = await getReport(ctxFor(store, actors.admin), { from: "2026-10-01", to: TODAY, contractorId: "c4" });
    expect(report.byContractor).toHaveLength(1);
    expect(report.byContractor[0].sites).toBe(3);
    expect(new Set(report.byContractorProject.map((g) => g.projectId))).toEqual(new Set(["p2", "p3", "p5"]));
    expect(report.byContractor[0].ruleConfigured).toBe(false); // demo contractor without a rule
  });
});

describe("11. transfers preserve history", () => {
  it("keeps past attendance at the old site and moves the worker from the effective date", async () => {
    const a = ctxFor(store, actors.admin);
    const view = await loadRegister(a, { projectId: "p3", contractorId: "c1" });
    const w = view.rows.find((r) => r.assigned)!;
    const pastDate = addDays(TODAY, -2);
    const before = (await store.listAttendance({ from: "2026-09-01", to: TODAY })).filter((r) => r.workerId === w.workerId);
    expect(before.length).toBeGreaterThan(0);

    await admin.transferWorker(a, w.workerId, { projectId: "p1", contractorId: "c1", effectiveDate: TODAY });

    const after = (await store.listAttendance({ from: "2026-09-01", to: TODAY })).filter((r) => r.workerId === w.workerId);
    expect(after).toEqual(before);
    expect(after.every((r) => r.projectId === "p3")).toBe(true);
    const oldSitePast = await loadRegister(a, { projectId: "p3", contractorId: "c1", date: pastDate });
    expect(oldSitePast.rows.some((r) => r.workerId === w.workerId)).toBe(true);
    expect((await loadRegister(a, { projectId: "p3", contractorId: "c1" })).rows.some((r) => r.workerId === w.workerId)).toBe(false);
    expect((await loadRegister(a, { projectId: "p1", contractorId: "c1" })).rows.some((r) => r.workerId === w.workerId)).toBe(true);
  });

  it("the seeded transferred worker has history at Lucknow and current deployment in Jaipur", async () => {
    const assignments = (await store.listWorkerAssignments()).filter((x) => x.workerId === "w53");
    expect(assignments.map((x) => x.projectId)).toEqual(["p3", "p1"]);
  });
});

describe("12. rate changes do not silently rewrite history", () => {
  it("a new rule version applies from its effective date only", async () => {
    const a = ctxFor(store, actors.admin);
    const range = { from: "2026-10-01", to: addDays(TODAY, -1), contractorId: "c2" };
    const before = await getReport(a, range);
    await admin.createPaymentRule(a, { contractorId: "c2", effectiveFrom: TODAY, rateType: "per_hour", hourRate: 120, unpaidBreakMinutes: 30 });
    const after = await getReport(a, range);
    expect(after.totals.amount).toBe(before.totals.amount);
    expect((await store.listPaymentRules()).filter((r) => r.contractorId === "c2").map((r) => r.version)).toEqual([1, 2]);
  });

  it("refuses a backdated rule unless explicitly confirmed", async () => {
    const a = ctxFor(store, actors.admin);
    await expectCode(admin.createPaymentRule(a, { contractorId: "c4", effectiveFrom: "2026-10-01", rateType: "per_day", dayRate: 500 }), "invalid");
    const r = await admin.createPaymentRule(a, { contractorId: "c4", effectiveFrom: "2026-10-01", rateType: "per_day", dayRate: 500, allowBackdate: true });
    expect(r.version).toBe(1);
  });

  it("unconfigured contractors show 'Not configured', not an invented amount", async () => {
    const overview = await getOverview(ctxFor(store, actors.admin));
    expect(overview.contractorRows.find((c) => c.contractorId === "c4")?.payable).toBe("Not configured");
  });
});

describe("15. audit log", () => {
  it("records who changed what, old and new values, and bulk vs individual", async () => {
    const op = ctxFor(store, actors.puneLucknow);
    const [a, b] = (await puneRegister()).rows;
    await saveAttendance(op, {
      projectId: "p2", contractorId: "c2", workDate: TODAY,
      items: [
        { workerId: a.workerId, status: "present", checkIn: "09:00", checkOut: null, method: "bulk", expectedVersion: null },
        { workerId: b.workerId, status: "present", checkIn: "09:00", checkOut: null, method: "bulk", expectedVersion: null },
      ],
    });
    await saveAttendance(op, {
      projectId: "p2", contractorId: "c2", workDate: TODAY,
      items: [{ workerId: a.workerId, status: "present", checkIn: "09:20", checkOut: null, method: "individual", expectedVersion: 1 }],
    });
    const log = await getAuditLog(ctxFor(store, actors.admin), { projectId: "p2", from: TODAY, to: TODAY });
    const forA = log.filter((l) => l.workerId === a.workerId);
    expect(forA).toHaveLength(2);
    const [update, create] = forA;
    expect(create.action).toBe("create");
    expect(create.method).toBe("bulk");
    expect(create.oldValues).toBeNull();
    expect(update.action).toBe("update");
    expect(update.method).toBe("individual");
    expect(update.changedBy).toBe(actors.puneLucknow.id);
    expect(update.changedByRole).toBe("operator");
    expect(update.oldValues?.checkInAt).toBe("2026-10-20T03:30:00.000Z");
    expect(update.newValues.checkInAt).toBe("2026-10-20T03:50:00.000Z");
    expect(log.find((l) => l.workerId === b.workerId)?.method).toBe("bulk");
  });

  it("unchanged entries create no audit noise", async () => {
    const op = ctxFor(store, actors.puneLucknow);
    const [a] = (await puneRegister()).rows;
    const item = { workerId: a.workerId, status: "absent" as const, checkIn: null, checkOut: null, method: "individual" as const };
    await saveAttendance(op, { projectId: "p2", contractorId: "c2", workDate: TODAY, items: [{ ...item, expectedVersion: null }] });
    const res = await saveAttendance(op, { projectId: "p2", contractorId: "c2", workDate: TODAY, items: [{ ...item, expectedVersion: 1 }] });
    expect(res.saved).toBe(0);
    expect((await store.listAuditLogs({ projectIds: ["p2"], from: TODAY, to: TODAY, limit: 50 })).length).toBe(1);
  });
});

describe("overview", () => {
  it("answers the head-office questions", async () => {
    const o = await getOverview(ctxFor(store, actors.admin));
    expect(o.cards.activeSites).toBe(5);
    expect(o.cards.contractors).toBe(4);
    expect(o.cards.activeWorkers).toBe(53);
    expect(o.cards.presentToday + o.cards.absentToday + o.cards.pendingToday).toBe(53);
    expect(o.attention.length).toBeGreaterThan(0);
    expect(o.contractorRows).toHaveLength(4);
    expect(NOW.toISOString()).toBe("2026-10-20T07:00:00.000Z");
  });
});
