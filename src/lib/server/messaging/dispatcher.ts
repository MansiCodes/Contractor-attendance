import "server-only";
import {
  attendanceKey,
  correctionKey,
  eligibility,
  factsFor,
  INELIGIBLE_TEXT,
  nextAttemptAt,
  renderMessage,
  scheduledRunDue,
  type Ineligible,
  type MessagingSettings,
} from "@/lib/domain/messaging";
import { resolvePolicy } from "@/lib/domain/policy";
import { addDays, nowTimeIn, todayIn } from "@/lib/domain/time";
import type { Actor, AttendanceRecord } from "@/lib/domain/types";
import type { DataStore, NewMessage } from "../store/types";
import type { MessageTransport } from "./transport";

// Queues and sends WhatsApp attendance messages. Runs from the protected
// scheduled endpoint (/api/whatsapp/dispatch, called by an external scheduler)
// and from the admin's "Send now". It never depends on a browser being open.

/** How far back the scheduled run looks for completed attendance (night shifts end the next day). */
const LOOKBACK_DAYS = 3;
const SEND_BATCH = 50;

export interface QueueResult {
  queued: number;
  corrections: number;
  skipped: Partial<Record<Ineligible, number>>;
}

/**
 * Queues one message per eligible attendance record, and a separate correction
 * notice when a record changed after its message was sent. Idempotency keys make
 * a repeated run harmless.
 */
export async function queueEligible(store: DataStore, settings: MessagingSettings, opts: { now: Date; today: string; allowFictional: boolean; actor: Actor | null }): Promise<QueueResult> {
  const from = [settings.startDate, addDays(opts.today, -LOOKBACK_DAYS)].sort()[1];
  const result: QueueResult = { queued: 0, corrections: 0, skipped: {} };
  if (from > opts.today) return result;
  const [records, contacts, workers, projects, messages, policies] = await Promise.all([
    store.listAttendance({ from, to: opts.today }),
    store.listWorkerContacts(),
    store.listWorkers(),
    store.listProjects(),
    store.listMessages({ limit: 100_000 }),
    // Read as stored versions (not the per-user RPC): the scheduled run has no signed-in user.
    store.listAttendancePolicies(),
  ]);
  const contactBy = new Map(contacts.map((c) => [c.workerId, c]));
  const workerBy = new Map(workers.map((w) => [w.id, w]));
  const projectBy = new Map(projects.map((p) => [p.id, p]));
  const keys = new Set(messages.map((m) => m.idempotencyKey));
  const delivered = new Map(
    messages.filter((m) => m.kind === "attendance" && ["sent", "delivered", "read"].includes(m.status) && m.attendanceId).map((m) => [m.attendanceId!, m]),
  );
  const breakCache = new Map<string, number>();
  const breakFor = async (r: AttendanceRecord) => {
    const k = `${r.projectId}:${r.workDate}`;
    if (!breakCache.has(k)) breakCache.set(k, resolvePolicy(policies, r.projectId, r.workDate).breakMinutes ?? 0);
    return breakCache.get(k)!;
  };

  const items: NewMessage[] = [];
  for (const r of records) {
    const worker = workerBy.get(r.workerId);
    const project = projectBy.get(r.projectId);
    if (!worker || !project) continue;
    const contact = contactBy.get(r.workerId) ?? null;
    const verdict = eligibility({ contact, record: r, startDate: settings.startDate, sentKeys: keys, allowFictional: opts.allowFictional });
    const lang = contact?.preferredLanguage ?? settings.defaultLanguage;
    const base = {
      workerId: r.workerId, attendanceId: r.id, attendanceVersion: r.version, contractorId: r.contractorId, projectId: r.projectId,
      workDate: r.workDate, shift: r.shift, language: lang,
    };
    if (verdict.ok) {
      const { params, body } = renderMessage("attendance", factsFor(r, worker.fullName, project.name, project.timezone, await breakFor(r)), lang, settings.includeEnglish);
      items.push({ ...base, idempotencyKey: attendanceKey(r.id), kind: "attendance", to: verdict.to, templateName: settings.attendanceTemplate, params, body });
      result.queued++;
      continue;
    }
    if (verdict.reason === "already_sent") {
      // Changed after its message went out: a separate correction notice (history stays in the audit log).
      const sent = delivered.get(r.id);
      if (!settings.correctionNotices || !sent || sent.attendanceVersion === null || r.version <= sent.attendanceVersion) continue;
      const key = correctionKey(r.id, r.version);
      if (keys.has(key)) continue;
      const again = eligibility({ contact, record: r, startDate: settings.startDate, sentKeys: new Set(), allowFictional: opts.allowFictional });
      if (!again.ok) {
        result.skipped[again.reason] = (result.skipped[again.reason] ?? 0) + 1;
        continue;
      }
      const { params, body } = renderMessage("correction", factsFor(r, worker.fullName, project.name, project.timezone, await breakFor(r)), lang, settings.includeEnglish);
      items.push({ ...base, idempotencyKey: key, kind: "correction", to: again.to, templateName: settings.correctionTemplate, params, body });
      result.corrections++;
      continue;
    }
    result.skipped[verdict.reason] = (result.skipped[verdict.reason] ?? 0) + 1;
  }
  const added = await store.enqueueMessages(items, opts.actor);
  // Another run may have queued some first: count only what this run added.
  result.queued = added.filter((m) => m.kind === "attendance").length;
  result.corrections = added.filter((m) => m.kind === "correction").length;
  return result;
}

export interface SendResult {
  sent: number;
  failed: number;
  retrying: number;
  /** no longer eligible when their turn came */
  cancelled: number;
}

/**
 * Sends due queued messages through `transport`. Each attendance message is checked
 * again just before sending (consent, number, messages on, still present with OUT,
 * start date) and its text is rebuilt from the record as it is now. Failures are
 * retried with back-off only when the provider clearly did not take the message.
 */
export async function processQueue(store: DataStore, transport: MessageTransport, now: Date, allowFictional: boolean): Promise<SendResult> {
  const result: SendResult = { sent: 0, failed: 0, retrying: 0, cancelled: 0 };
  const claimed = await store.claimDueMessages(now.toISOString(), SEND_BATCH);
  if (claimed.length === 0) return result;
  const forRecords = claimed.filter((m) => m.kind !== "test" && m.attendanceId && m.workDate);
  const dates = forRecords.map((m) => m.workDate!).sort();
  const [settings, records, contacts, workers, projects, policies] = await Promise.all([
    store.getMessagingSettings(),
    dates.length ? store.listAttendance({ from: dates[0], to: dates[dates.length - 1] }) : Promise.resolve([]),
    forRecords.length ? store.listWorkerContacts() : Promise.resolve([]),
    forRecords.length ? store.listWorkers() : Promise.resolve([]),
    forRecords.length ? store.listProjects() : Promise.resolve([]),
    forRecords.length ? store.listAttendancePolicies() : Promise.resolve([]),
  ]);
  const recordBy = new Map(records.map((r) => [r.id, r]));
  const contactBy = new Map(contacts.map((c) => [c.workerId, c]));
  const workerBy = new Map(workers.map((w) => [w.id, w]));
  const projectBy = new Map(projects.map((p) => [p.id, p]));

  for (const claimedMessage of claimed) {
    let m = claimedMessage;
    if (m.kind !== "test") {
      const record = m.attendanceId ? recordBy.get(m.attendanceId) : undefined;
      const contact = m.workerId ? contactBy.get(m.workerId) ?? null : null;
      const worker = m.workerId ? workerBy.get(m.workerId) : undefined;
      const project = record ? projectBy.get(record.projectId) : undefined;
      const verdict =
        record && settings && worker && project
          ? eligibility({ contact, record, startDate: settings.startDate, sentKeys: new Set(), allowFictional })
          : ({ ok: false, reason: "not_present" } as const);
      if (!verdict.ok) {
        await store.completeMessage(m.id, { status: "cancelled", error: `Not sent: ${INELIGIBLE_TEXT[verdict.reason]}`, nextAttemptAt: null, transport: transport.kind, at: new Date().toISOString() });
        result.cancelled++;
        continue;
      }
      const language = contact?.preferredLanguage ?? settings!.defaultLanguage;
      const facts = factsFor(record!, worker!.fullName, project!.name, project!.timezone, resolvePolicy(policies, record!.projectId, record!.workDate).breakMinutes ?? 0);
      const { params, body } = renderMessage(m.kind === "correction" ? "correction" : "attendance", facts, language, settings!.includeEnglish);
      if (body !== m.body || verdict.to !== m.to || language !== m.language || record!.version !== m.attendanceVersion) {
        const patch = { to: verdict.to, language, params, body, attendanceVersion: record!.version };
        await store.refreshMessage(m.id, patch);
        m = { ...m, ...patch };
      }
    }
    const outcome = await transport.send(m);
    const at = new Date().toISOString();
    if (outcome.ok) {
      await store.completeMessage(m.id, { status: "sent", providerMessageId: outcome.providerMessageId, transport: transport.kind, at });
      result.sent++;
      continue;
    }
    const retryAt = outcome.retryable ? nextAttemptAt(m.attempts, now) : null;
    await store.completeMessage(m.id, { status: retryAt ? "queued" : "failed", error: outcome.error, nextAttemptAt: retryAt, transport: transport.kind, at });
    if (retryAt) result.retrying++;
    else result.failed++;
  }
  return result;
}

export interface DispatchResult {
  ran: boolean;
  reason: string | null;
  queue: QueueResult | null;
  send: SendResult | null;
}

/**
 * One dispatcher run. Scheduled runs queue new messages once a day after the send
 * time; `force` (the admin's "Send now") queues immediately. Due retries are sent
 * on every run. Nothing happens while messaging is off or paused.
 */
export async function runDispatch(
  store: DataStore,
  transport: MessageTransport,
  opts: { now: Date; timezone: string; force: boolean; allowFictional: boolean; actor: Actor | null },
): Promise<DispatchResult> {
  const settings = await store.getMessagingSettings();
  if (!settings) return { ran: false, reason: "WhatsApp messaging has not been set up", queue: null, send: null };
  if (settings.paused) return { ran: false, reason: "WhatsApp messaging is paused", queue: null, send: null };
  if (!settings.enabled) return { ran: false, reason: "WhatsApp messaging is off", queue: null, send: null };
  const today = todayIn(opts.timezone, opts.now);
  let queue: QueueResult | null = null;
  if (opts.force || scheduledRunDue(settings, today, nowTimeIn(opts.timezone, opts.now))) {
    queue = await queueEligible(store, settings, { now: opts.now, today, allowFictional: opts.allowFictional, actor: opts.actor });
    if (!opts.force) await store.setLastScheduledRun(today);
  }
  const send = await processQueue(store, transport, opts.now, opts.allowFictional);
  return { ran: true, reason: null, queue, send };
}
