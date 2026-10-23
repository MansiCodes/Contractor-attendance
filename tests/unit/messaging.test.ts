import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkNumber, eligibility, renderMessage } from "@/lib/domain/messaging";
import { runDispatch } from "@/lib/server/messaging/dispatcher";
import { mockTransport, parseStatusUpdates, providerStatus, verifyWebhookSignature } from "@/lib/server/messaging/transport";
import { loadRegister, saveAttendance } from "@/lib/server/services/attendance";
import { messagingOverview, saveMessagingSettings, saveWorkerContact, sendNow, sendTestMessage } from "@/lib/server/services/messaging";
import type { DemoStore } from "@/lib/server/store/demo-store";
import { actors, ctxFor, freshStore, NOW, TODAY } from "./helpers";

// WhatsApp messages in demo mode: the mock transport, the demo store and the real
// dispatcher. The demo contacts are Shakti (c1) workers at the PVC plant (p1)
// with fictional +999 numbers.

const admin = (store: DemoStore) => ctxFor(store, actors.admin);
const enable = (store: DemoStore, extra: Record<string, unknown> = {}) =>
  saveMessagingSettings(admin(store), {
    enabled: true, paused: false, sendTime: "20:00", defaultLanguage: "hi", includeEnglish: false, attendanceTemplate: "attendance_summary_hi",
    correctionTemplate: "attendance_correction_hi", correctionNotices: true, startDate: TODAY, testNumber: "+9995550199", ...extra,
  });

/** Records OUT 12:00 today for every c1 worker present at p1 (the seed marks them present without OUT). */
async function checkOutEveryone(store: DemoStore, out = "12:00") {
  const op = ctxFor(store, actors.pvc);
  const view = await loadRegister(op, { projectId: "p1", contractorId: "c1" });
  const items = view.rows
    .filter((r) => r.saved?.status === "present")
    .map((r) => ({ workerId: r.workerId, status: "present" as const, checkIn: r.saved!.checkIn, checkOut: out, checkInSource: r.saved!.checkInSource, method: "bulk" as const, expectedVersion: r.saved!.version }));
  await saveAttendance(op, { projectId: "p1", contractorId: "c1", workDate: TODAY, items });
  return view.rows;
}

const dispatch = (store: DemoStore, force = true) => runDispatch(store, mockTransport, { now: NOW, timezone: "Asia/Kolkata", force, allowFictional: true, actor: null });

describe("WhatsApp eligibility", () => {
  const record = { id: "a1", status: "present" as const, checkInAt: "2026-10-20T03:30:00Z", checkOutAt: "2026-10-20T12:00:00Z", workDate: TODAY };
  const contact = { workerId: "w", countryCode: "+91", whatsappNumber: "9876543210", enabled: true, consentStatus: "granted" as const, consentAt: "x", consentSource: "form", preferredLanguage: null, updatedAt: "", updatedBy: null };
  const check = (o: Partial<Parameters<typeof eligibility>[0]>) => eligibility({ contact, record, startDate: TODAY, sentKeys: new Set(), allowFictional: false, ...o });

  it("needs consent, a valid number, messages on, a confirmed OUT, no earlier message, and a date on or after the start", () => {
    expect(check({})).toEqual({ ok: true, to: "+919876543210" });
    expect(check({ contact: { ...contact, consentStatus: "unknown" } })).toEqual({ ok: false, reason: "no_consent" });
    expect(check({ contact: { ...contact, consentStatus: "withdrawn" } })).toEqual({ ok: false, reason: "no_consent" });
    expect(check({ contact: { ...contact, whatsappNumber: "12345" } })).toEqual({ ok: false, reason: "invalid_number" });
    expect(check({ contact: { ...contact, enabled: false } })).toEqual({ ok: false, reason: "disabled" });
    expect(check({ contact: null })).toEqual({ ok: false, reason: "no_number" });
    expect(check({ record: { ...record, checkOutAt: null } })).toEqual({ ok: false, reason: "no_checkout" });
    expect(check({ record: { ...record, status: "absent", checkInAt: null, checkOutAt: null } })).toEqual({ ok: false, reason: "not_present" });
    expect(check({ startDate: "2026-10-21" })).toEqual({ ok: false, reason: "before_start_date" });
    expect(check({ sentKeys: new Set(["att:a1"]) })).toEqual({ ok: false, reason: "already_sent" });
  });

  it("validates Indian mobile numbers and keeps fictional demo numbers out of live mode", () => {
    expect(checkNumber("+91", "098765 43210")).toMatchObject({ ok: true, e164: "+919876543210" });
    expect(checkNumber("+91", "+91 98765-43210")).toMatchObject({ ok: true, e164: "+919876543210" });
    expect(checkNumber("+91", "5876543210").ok).toBe(false);
    expect(checkNumber("+999", "5550101").ok).toBe(false);
    expect(checkNumber("+999", "5550101", true)).toMatchObject({ ok: true, fictional: true });
  });

  it("messages are in Hindi by default, with optional English, and never mention wages", () => {
    const facts = { workerName: "राम", workDate: TODAY, plantName: "PVC Plant", shift: "night" as const, checkIn: "21:00", checkOut: "05:30", checkOutNextDay: true, workedMinutes: 510 };
    const hi = renderMessage("attendance", facts, "hi", false);
    expect(hi.body).toContain("हाज़िरी दर्ज");
    expect(hi.body).toContain("अगले दिन");
    expect(hi.body).toContain("8 घंटे 30 मिनट");
    expect(hi.body).not.toMatch(/₹|rs\.?\s|wage|salary|वेतन|मज़दूरी/i);
    const both = renderMessage("attendance", facts, "hi", true);
    expect(both.body).toContain("Hello राम");
    expect(hi.params).toHaveLength(7);
  });
});

describe("WhatsApp sending (mock transport, demo store)", () => {
  it("the mock is used without any credentials", () => {
    const s = providerStatus({ APP_MODE: "demo" });
    expect(s).toMatchObject({ transport: "mock", liveSendingEnabled: false });
    // Even in live mode, nothing is sent without the explicit switch and credentials.
    const live = { APP_MODE: "live", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" };
    expect(providerStatus(live).liveSendingEnabled).toBe(false);
    expect(providerStatus({ ...live, WHATSAPP_LIVE_SENDING: "enabled" }).liveSendingEnabled).toBe(false);
    expect(providerStatus({ ...live, WHATSAPP_LIVE_SENDING: "enabled", WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "1" }).liveSendingEnabled).toBe(true);
  });

  it("sends nothing while messaging is off, and nothing before OUT is recorded", async () => {
    const store = freshStore();
    expect((await dispatch(store)).ran).toBe(false);
    await enable(store);
    const r = await dispatch(store);
    expect(r.queue?.queued).toBe(0);
    expect(r.queue?.skipped.no_checkout).toBeGreaterThan(0);
  });

  it("sends once per confirmed day to consented workers only; a second run sends nothing", async () => {
    const store = freshStore();
    await enable(store);
    await checkOutEveryone(store);
    const contacts = await store.listWorkerContacts();
    const first = await dispatch(store);
    const messages = await store.listMessages({ limit: 100 });
    const consented = new Set(contacts.filter((c) => c.consentStatus === "granted" && c.enabled).map((c) => c.workerId));
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => consented.has(m.workerId!))).toBe(true);
    expect(first.queue?.skipped.no_consent).toBeGreaterThan(0);
    const again = await dispatch(store);
    expect(again.queue?.queued).toBe(0);
    expect((await store.listMessages({ limit: 100 })).length).toBe(messages.length);
    // The fictional "0000" number simulates an unreachable phone: it is retried, not lost.
    expect(messages.filter((m) => m.status === "sent").length + (first.send?.retrying ?? 0)).toBe(messages.length);
  });

  it("a change after the message went out gets a separate correction notice, once", async () => {
    const store = freshStore();
    await enable(store);
    await checkOutEveryone(store);
    await dispatch(store);
    const sent = (await store.listMessages({ limit: 100 })).find((m) => m.status === "sent")!;
    // Correct that worker's OUT time.
    const op = ctxFor(store, actors.pvc);
    const row = (await loadRegister(op, { projectId: "p1", contractorId: "c1" })).rows.find((r) => r.workerId === sent.workerId)!;
    await saveAttendance(op, {
      projectId: "p1", contractorId: "c1", workDate: TODAY,
      items: [{ workerId: row.workerId, status: "present", checkIn: row.saved!.checkIn, checkOut: "12:15", checkInSource: row.saved!.checkInSource, method: "individual", expectedVersion: row.saved!.version }],
    });
    const r = await dispatch(store);
    expect(r.queue?.corrections).toBe(1);
    const corrections = (await store.listMessages({ limit: 100 })).filter((m) => m.kind === "correction");
    expect(corrections).toHaveLength(1);
    expect(corrections[0].body).toContain("सुधार");
    expect((await dispatch(store)).queue?.corrections).toBe(0);
    // Turned off: no correction notices.
    await enable(store, { correctionNotices: false });
    expect((await dispatch(store)).queue?.corrections).toBe(0);
  });

  it("withdrawn consent stops messages at once", async () => {
    const store = freshStore();
    await enable(store);
    const granted = (await store.listWorkerContacts()).find((c) => c.consentStatus === "granted" && c.enabled)!;
    await saveWorkerContact(admin(store), granted.workerId, { countryCode: "+999", whatsappNumber: granted.whatsappNumber, enabled: true, consentStatus: "withdrawn", consentSource: "Asked to stop" });
    await checkOutEveryone(store);
    await dispatch(store);
    expect((await store.listMessages({ limit: 100 })).some((m) => m.workerId === granted.workerId)).toBe(false);
    expect((await store.listConsentEvents(granted.workerId)).map((e) => e.consentStatus)).toEqual(["granted", "withdrawn"]);
  });

  it("does not message older records (no retroactive sending) and pausing stops everything", async () => {
    const store = freshStore();
    await enable(store, { startDate: "2026-10-21" });
    await checkOutEveryone(store);
    // Records before the start date are not even considered.
    expect((await dispatch(store)).queue?.queued).toBe(0);
    expect(await store.listMessages({ limit: 10 })).toHaveLength(0);
    await expect(saveMessagingSettings(admin(store), { ...(await store.getMessagingSettings())!, startDate: "2026-10-01" })).rejects.toThrow(/cannot move back/);
    await enable(store, { startDate: TODAY, paused: true });
    expect((await dispatch(store)).ran).toBe(false);
    expect(await store.listMessages({ limit: 10 })).toHaveLength(0);
  });

  it("the scheduled run waits for the send time and runs once a day", async () => {
    const store = freshStore();
    await enable(store, { sendTime: "20:00" });
    await checkOutEveryone(store);
    expect((await dispatch(store, false)).queue).toBeNull(); // 12:30 IST, before 20:00
    await enable(store, { sendTime: "12:00" });
    expect((await dispatch(store, false)).queue?.queued).toBeGreaterThan(0);
    expect((await dispatch(store, false)).queue).toBeNull(); // already ran today
  });

  it("test messages go to the test number only; operators cannot reach any of this", async () => {
    const store = freshStore();
    await enable(store);
    const res = await sendTestMessage(admin(store), { language: "hi" });
    expect(res).toMatchObject({ ok: true, transport: "mock" });
    const [m] = await store.listMessages({ limit: 1 });
    expect(m).toMatchObject({ kind: "test", to: "+9995550199", workerId: null });
    const op = ctxFor(store, actors.pvc);
    await expect(messagingOverview(op)).rejects.toThrow(/admin/i);
    await expect(sendNow(op)).rejects.toThrow(/admin/i);
    await expect(saveWorkerContact(op, m.id, {})).rejects.toThrow(/admin/i);
    const overview = await messagingOverview(admin(store));
    expect(overview.history[0].to).toMatch(/^\+99•+0199$/); // numbers are masked in history
  });
});

describe("Provider webhook", () => {
  it("accepts only correctly signed payloads", () => {
    const body = JSON.stringify({ entry: [] });
    const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(verifyWebhookSignature(body, sig, "s3cret")).toBe(true);
    expect(verifyWebhookSignature(body, sig, "other")).toBe(false);
    expect(verifyWebhookSignature(`${body} `, sig, "s3cret")).toBe(false);
    expect(verifyWebhookSignature(body, null, "s3cret")).toBe(false);
    expect(verifyWebhookSignature(body, sig, undefined)).toBe(false);
  });

  it("reads statuses and only moves a message forward", async () => {
    const updates = parseStatusUpdates({
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "delivered", timestamp: "1792745000" }, { id: "wamid.1", status: "bogus" }] } }] }],
    });
    expect(updates).toEqual([{ providerMessageId: "wamid.1", status: "delivered", at: new Date(1792745000 * 1000).toISOString(), error: null }]);
    const store = freshStore();
    await enable(store);
    await sendTestMessage(admin(store), { language: "en" });
    const [m] = await store.listMessages({ limit: 1 });
    expect(await store.applyMessageStatus(m.providerMessageId!, "read", NOW.toISOString(), null)).toBe(true);
    await store.applyMessageStatus(m.providerMessageId!, "delivered", NOW.toISOString(), null);
    expect((await store.listMessages({ limit: 1 }))[0].status).toBe("read");
    expect(await store.applyMessageStatus("unknown", "read", NOW.toISOString(), null)).toBe(false);
  });
});
