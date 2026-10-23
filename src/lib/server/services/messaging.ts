import { z } from "zod";
import { invalid, notFound } from "@/lib/errors";
import {
  checkNumber,
  DEFAULT_MESSAGING_SETTINGS,
  FICTIONAL_COUNTRY_CODE,
  maskNumber,
  renderMessage,
  type MessageLanguage,
  type MessageStatus,
  type MessagingSettings,
  type WorkerContact,
} from "@/lib/domain/messaging";
import { dateString, employeeCode, timeString } from "@/lib/domain/schemas";
import { readWorkbookGrids } from "@/lib/import/xlsx-grid";
import type { CellValue } from "@/lib/domain/master-import";
import { runDispatch } from "../messaging/dispatcher";
import { getTransport, providerStatus } from "../messaging/transport";
import type { WorkerContactFields } from "../store/types";
import { assertAdmin, headOfficeTimezone, headOfficeToday, type ServiceContext } from "./context";

// WhatsApp messaging for head office admins only. Operators never see numbers,
// consent, settings or messages, and credentials never leave the server.

const LANGS = ["hi", "hi_latn", "en"] as const;
const allowFictional = (ctx: ServiceContext) => ctx.store.kind === "demo";

async function settingsOrDefault(ctx: ServiceContext): Promise<MessagingSettings> {
  return (await ctx.store.getMessagingSettings()) ?? { ...DEFAULT_MESSAGING_SETTINGS, startDate: await headOfficeToday(ctx) };
}

/** "+91 98xxxxxxxx" style input → a checked E.164 number. */
function parseFullNumber(raw: string, fictionalOk: boolean) {
  const t = raw.replace(/[\s\-().]/g, "");
  const cc = t.startsWith(FICTIONAL_COUNTRY_CODE) ? FICTIONAL_COUNTRY_CODE : t.startsWith("+91") ? "+91" : null;
  if (!cc) return { ok: false as const, reason: "Start with the country code, e.g. +91" };
  return checkNumber(cc, t.slice(cc.length), fictionalOk);
}

// ---------- overview ----------

export interface MessageHistoryRow {
  id: string;
  kind: "attendance" | "correction" | "test";
  workerName: string;
  employeeCode: string | null;
  contractorName: string;
  plantName: string;
  workDate: string | null;
  status: MessageStatus;
  sentAt: string | null;
  createdAt: string;
  to: string;
  attempts: number;
  lastError: string | null;
  transport: "mock" | "cloud_api" | null;
  body: string;
}

export interface ContactRow {
  workerId: string;
  workerName: string;
  employeeCode: string | null;
  workerCode: string;
  contractorName: string;
  contact: WorkerContact | null;
  numberValid: boolean;
}

export async function messagingOverview(ctx: ServiceContext, q: { status?: string | null } = {}) {
  assertAdmin(ctx);
  const [settings, contacts, workers, contractors, projects, messages] = await Promise.all([
    settingsOrDefault(ctx),
    ctx.store.listWorkerContacts(),
    ctx.store.listWorkers(),
    ctx.store.listContractors(),
    ctx.store.listProjects(),
    ctx.store.listMessages({ limit: 100_000 }),
  ]);
  const counts: Record<MessageStatus, number> = { queued: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0, cancelled: 0 };
  for (const m of messages) counts[m.status]++;
  const workerBy = new Map(workers.map((w) => [w.id, w]));
  const contractorBy = new Map(contractors.map((c) => [c.id, c.name]));
  const projectBy = new Map(projects.map((p) => [p.id, p.name]));
  const contactBy = new Map(contacts.map((c) => [c.workerId, c]));
  const status = q.status && q.status in counts ? (q.status as MessageStatus) : null;
  const history: MessageHistoryRow[] = messages
    .filter((m) => !status || m.status === status)
    .slice(0, 300)
    .map((m) => {
      const w = m.workerId ? workerBy.get(m.workerId) : null;
      return {
        id: m.id,
        kind: m.kind,
        workerName: m.kind === "test" ? "Test message" : w?.fullName ?? "Unknown worker",
        employeeCode: w?.employeeCode ?? null,
        contractorName: m.contractorId ? contractorBy.get(m.contractorId) ?? "—" : "—",
        plantName: m.projectId ? projectBy.get(m.projectId) ?? "—" : "—",
        workDate: m.workDate,
        status: m.status,
        sentAt: m.sentAt,
        createdAt: m.createdAt,
        to: maskNumber(m.to),
        attempts: m.attempts,
        lastError: m.lastError,
        transport: m.transport,
        body: m.body,
      };
    });
  const contactRows: ContactRow[] = workers
    .filter((w) => w.isActive)
    .map((w) => {
      const c = contactBy.get(w.id) ?? null;
      return {
        workerId: w.id,
        workerName: w.fullName,
        employeeCode: w.employeeCode,
        workerCode: w.code,
        contractorName: contractorBy.get(w.contractorId) ?? "—",
        contact: c,
        numberValid: !!c?.whatsappNumber && checkNumber(c.countryCode, c.whatsappNumber, allowFictional(ctx)).ok,
      };
    })
    .sort((a, b) => a.contractorName.localeCompare(b.contractorName) || a.workerName.localeCompare(b.workerName, "en-IN"));
  return {
    settings,
    provider: providerStatus(),
    counts,
    pending: counts.queued + counts.sending,
    history,
    contacts: contactRows,
    consent: {
      granted: contacts.filter((c) => c.consentStatus === "granted").length,
      withdrawn: contacts.filter((c) => c.consentStatus === "withdrawn").length,
      ready: contactRows.filter((r) => r.contact?.enabled && r.contact.consentStatus === "granted" && r.numberValid).length,
    },
    demo: ctx.store.kind === "demo",
  };
}

// ---------- settings ----------

const templateName = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{1,512}$/, "Use the template name exactly as approved in WhatsApp Manager (lowercase letters, digits, _)");

const settingsInput = z.object({
  enabled: z.boolean(),
  paused: z.boolean(),
  sendTime: timeString,
  defaultLanguage: z.enum(LANGS),
  includeEnglish: z.boolean(),
  attendanceTemplate: templateName,
  correctionTemplate: templateName,
  correctionNotices: z.boolean(),
  startDate: dateString,
  testNumber: z
    .string()
    .trim()
    .max(20)
    .nullish()
    .transform((v) => (v ? v : null)),
});

export async function saveMessagingSettings(ctx: ServiceContext, raw: unknown) {
  assertAdmin(ctx);
  const input = settingsInput.parse(raw);
  const current = await settingsOrDefault(ctx);
  let testNumber: string | null = null;
  if (input.testNumber) {
    const n = parseFullNumber(input.testNumber, allowFictional(ctx));
    if (!n.ok) throw invalid(`Test number: ${n.reason}`);
    testNumber = n.e164;
  }
  // Moving the start date earlier would message older (e.g. imported) records retroactively.
  const today = await headOfficeToday(ctx);
  if (input.startDate < current.startDate && input.startDate < today) {
    throw invalid(`The start date cannot move back before ${current.startDate < today ? current.startDate : today}: that would send messages for older attendance.`);
  }
  return ctx.store.saveMessagingSettings({ ...input, testNumber }, ctx.actor);
}

export async function setPaused(ctx: ServiceContext, paused: boolean) {
  assertAdmin(ctx);
  const s = await settingsOrDefault(ctx);
  const { updatedAt: _u, updatedBy: _b, lastScheduledRun: _l, ...fields } = s;
  void _u;
  void _b;
  void _l;
  return ctx.store.saveMessagingSettings({ ...fields, paused }, ctx.actor);
}

// ---------- contacts ----------

const contactInput = z
  .object({
    countryCode: z.string().trim().regex(/^\+\d{1,4}$/, "Country code like +91"),
    whatsappNumber: z
      .string()
      .trim()
      .max(20)
      .nullish()
      .transform((v) => (v ? v : null)),
    enabled: z.boolean(),
    consentStatus: z.enum(["unknown", "granted", "withdrawn"]),
    consentSource: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .transform((v) => (v ? v : null)),
    preferredLanguage: z.enum(LANGS).nullable().default(null),
  })
  .superRefine((v, c) => {
    if (v.consentStatus !== "unknown" && !v.consentSource) c.addIssue({ code: "custom", path: ["consentSource"], message: "Say how consent was given or withdrawn" });
  });

function toContactFields(ctx: ServiceContext, workerId: string, input: z.output<typeof contactInput>, previous: WorkerContact | null): WorkerContactFields {
  let national: string | null = null;
  if (input.whatsappNumber) {
    const n = checkNumber(input.countryCode, input.whatsappNumber, allowFictional(ctx));
    if (!n.ok) throw invalid(n.reason);
    national = n.national;
  }
  if (input.enabled && !national) throw invalid("Add a WhatsApp number before turning messages on");
  const consentChanged = input.consentStatus !== (previous?.consentStatus ?? "unknown");
  return {
    workerId,
    countryCode: input.countryCode,
    whatsappNumber: national,
    enabled: input.enabled,
    consentStatus: input.consentStatus,
    consentAt: input.consentStatus === "unknown" ? null : consentChanged ? ctx.now.toISOString() : previous?.consentAt ?? ctx.now.toISOString(),
    consentSource: input.consentStatus === "unknown" ? null : input.consentSource,
    preferredLanguage: input.preferredLanguage,
  };
}

export async function saveWorkerContact(ctx: ServiceContext, workerId: string, raw: unknown) {
  assertAdmin(ctx);
  const worker = (await ctx.store.listWorkers()).find((w) => w.id === workerId);
  if (!worker) throw notFound("Worker");
  const previous = (await ctx.store.listWorkerContacts()).find((c) => c.workerId === workerId) ?? null;
  await ctx.store.saveWorkerContacts([toContactFields(ctx, workerId, contactInput.parse(raw), previous)], ctx.actor);
}

export async function consentHistory(ctx: ServiceContext, workerId: string) {
  assertAdmin(ctx);
  const [events, profiles] = await Promise.all([ctx.store.listConsentEvents(workerId), ctx.store.listProfiles()]);
  const by = new Map(profiles.map((p) => [p.id, p.fullName]));
  return events.sort((a, b) => b.at.localeCompare(a.at)).map((e) => ({ ...e, byName: e.by ? by.get(e.by) ?? "Unknown user" : "System" }));
}

// ---------- bulk contacts import (template workbook) ----------

const CONTACT_COLUMNS = {
  employeeCode: /emp(loyee)?\s*(id|code)/,
  contractor: /contractor/,
  number: /whats\s*app\s*(number|no)|mobile|phone/,
  countryCode: /country/,
  enabled: /messages|enabled|send/,
  consent: /consent$|consent\s*\(|consent status/,
  source: /consent\s*source|how/,
  language: /language/,
} as const;

export interface ContactImportRow {
  row: number;
  employeeCode: string | null;
  contractor: string | null;
  workerId: string | null;
  workerName: string | null;
  error: string | null;
  fields: WorkerContactFields | null;
}

const cellText = (v: CellValue | undefined) => (v === null || v === undefined ? null : String(v).trim() || null);
const yes = (v: string | null) => (v ? /^(y|yes|on|true|haan|1)$/i.test(v) : false);

/** Reads the filled-in contacts template and matches rows by contractor and employee ID. Nothing is saved. */
export async function previewContactsImport(ctx: ServiceContext, file: { name: string; bytes: Uint8Array }): Promise<ContactImportRow[]> {
  assertAdmin(ctx);
  if (!/\.xlsx$/i.test(file.name) || file.bytes[0] !== 0x50) throw invalid("Upload the filled-in template as an .xlsx file");
  if (file.bytes.byteLength > 3 * 1024 * 1024) throw invalid("The file is larger than 3 MB");
  const grids = await readWorkbookGrids(file.bytes);
  const grid = grids[0];
  if (!grid) throw invalid("The workbook is empty");
  const byRow = new Map<number, Map<number, CellValue>>();
  for (const c of grid.cells) {
    if (!byRow.has(c.row)) byRow.set(c.row, new Map());
    byRow.get(c.row)!.set(c.col, c.value);
  }
  const headerRow = [...byRow.entries()].find(([, cols]) => [...cols.values()].some((v) => CONTACT_COLUMNS.employeeCode.test(String(v ?? "").toLowerCase())))?.[0];
  if (headerRow === undefined) throw invalid("No “Employee ID” column found. Use the template from this page.");
  const col: Partial<Record<keyof typeof CONTACT_COLUMNS, number>> = {};
  for (const [c, v] of byRow.get(headerRow)!) {
    const h = String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    for (const [k, re] of Object.entries(CONTACT_COLUMNS) as [keyof typeof CONTACT_COLUMNS, RegExp][]) if (col[k] === undefined && re.test(h)) {
      col[k] = c;
      break;
    }
  }
  const [workers, contractors, contacts] = await Promise.all([ctx.store.listWorkers(), ctx.store.listContractors(), ctx.store.listWorkerContacts()]);
  const contractorByName = new Map(contractors.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const out: ContactImportRow[] = [];
  for (const [r, cols] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    if (r <= headerRow) continue;
    const get = (k: keyof typeof CONTACT_COLUMNS) => (col[k] === undefined ? null : cellText(cols.get(col[k]!)));
    const code = employeeCode.safeParse(get("employeeCode")).data ?? null;
    const contractor = get("contractor");
    const number = get("number");
    if (!code && !number) continue;
    const row: ContactImportRow = { row: r, employeeCode: code, contractor, workerId: null, workerName: null, error: null, fields: null };
    out.push(row);
    const contractorId = contractor ? contractorByName.get(contractor.toLowerCase()) : undefined;
    const matches = workers.filter((w) => w.employeeCode === code && (!contractorId || w.contractorId === contractorId));
    if (!code) row.error = "No employee ID";
    else if (contractor && !contractorId) row.error = `Unknown contractor “${contractor}”`;
    else if (matches.length === 0) row.error = "No worker with this employee ID";
    else if (matches.length > 1) row.error = "This employee ID exists at more than one contractor: fill in the Contractor column";
    if (row.error) continue;
    const w = matches[0];
    row.workerId = w.id;
    row.workerName = w.fullName;
    const consentText = (get("consent") ?? "").toLowerCase();
    const consentStatus = /^(granted|yes|haan|given)/.test(consentText) ? "granted" : /^(withdrawn|no|revoked)/.test(consentText) ? "withdrawn" : "unknown";
    const langText = (get("language") ?? "").toLowerCase();
    const parsed = contactInput.safeParse({
      countryCode: get("countryCode") ?? "+91",
      whatsappNumber: number,
      enabled: yes(get("enabled")),
      consentStatus,
      consentSource: get("source"),
      preferredLanguage: langText.startsWith("hi_l") || langText.includes("roman") ? "hi_latn" : langText.startsWith("en") ? "en" : langText.startsWith("hi") ? "hi" : null,
    });
    if (!parsed.success) {
      row.error = parsed.error.issues[0]?.message ?? "Not valid";
      continue;
    }
    try {
      row.fields = toContactFields(ctx, w.id, parsed.data, contacts.find((c) => c.workerId === w.id) ?? null);
    } catch (e) {
      row.error = (e as Error).message;
    }
  }
  return out;
}

export async function applyContactsImport(ctx: ServiceContext, file: { name: string; bytes: Uint8Array }) {
  const rows = await previewContactsImport(ctx, file);
  const good = rows.filter((r) => r.fields).map((r) => r.fields!);
  if (good.length === 0) throw invalid("No valid rows to import");
  if (new Set(good.map((g) => g.workerId)).size !== good.length) throw invalid("The same worker appears twice in the file");
  await ctx.store.saveWorkerContacts(good, ctx.actor);
  return { saved: good.length, skipped: rows.length - good.length };
}

// ---------- sending ----------

const SAMPLE = { workerName: "राम कुमार", plantName: "PVC Plant", shift: "day" as const, checkIn: "09:00", checkOut: "17:30", checkOutNextDay: false, workedMinutes: 480 };

export async function previewMessage(ctx: ServiceContext, raw: unknown) {
  assertAdmin(ctx);
  const q = z.object({ language: z.enum(LANGS), includeEnglish: z.boolean(), kind: z.enum(["attendance", "correction"]).default("attendance") }).parse(raw);
  const today = await headOfficeToday(ctx);
  return renderMessage(q.kind, { ...SAMPLE, workerName: q.language === "hi" ? SAMPLE.workerName : "Ram Kumar", workDate: today }, q.language, q.includeEnglish);
}

/** "Send now": queue every eligible message and send what is due, through the configured transport. */
export async function sendNow(ctx: ServiceContext) {
  assertAdmin(ctx);
  const result = await runDispatch(ctx.store, getTransport(), {
    now: ctx.now,
    timezone: await headOfficeTimezone(ctx),
    force: true,
    allowFictional: allowFictional(ctx),
    actor: ctx.actor,
  });
  if (!result.ran) throw invalid(result.reason ?? "Nothing was sent");
  return result;
}

/** One sample message to the test number (never to a worker). */
export async function sendTestMessage(ctx: ServiceContext, raw: unknown) {
  assertAdmin(ctx);
  const { language } = z.object({ language: z.enum(LANGS) }).parse(raw);
  const settings = await settingsOrDefault(ctx);
  if (!settings.testNumber) throw invalid("Save a test number first");
  const n = parseFullNumber(settings.testNumber, allowFictional(ctx));
  if (!n.ok) throw invalid(`Test number: ${n.reason}`);
  const { params, body } = await previewMessage(ctx, { language, includeEnglish: settings.includeEnglish });
  const [msg] = await ctx.store.enqueueMessages(
    [
      {
        idempotencyKey: `test:${ctx.now.toISOString()}:${ctx.actor.id}`, kind: "test", workerId: null, attendanceId: null, attendanceVersion: null,
        contractorId: null, projectId: null, workDate: null, shift: null, to: n.e164, language: language as MessageLanguage,
        templateName: settings.attendanceTemplate, params, body,
      },
    ],
    ctx.actor,
  );
  const transport = getTransport();
  const claimed = msg ? await ctx.store.claimMessage(msg.id, ctx.now.toISOString()) : null;
  if (!claimed) throw invalid("The test message could not be queued");
  const outcome = await transport.send(claimed);
  const at = new Date().toISOString();
  if (outcome.ok) await ctx.store.completeMessage(claimed.id, { status: "sent", providerMessageId: outcome.providerMessageId, transport: transport.kind, at });
  else await ctx.store.completeMessage(claimed.id, { status: "failed", error: outcome.error, nextAttemptAt: null, transport: transport.kind, at });
  return { ok: outcome.ok, transport: transport.kind, error: outcome.ok ? null : outcome.error };
}

export async function retryFailed(ctx: ServiceContext) {
  assertAdmin(ctx);
  return ctx.store.requeueFailed();
}

