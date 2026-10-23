import { formatMinutes, formatTime12, instantToLocal, minutesBetween } from "./time";
import type { AttendanceRecord, Shift } from "./types";

// WhatsApp attendance messages: who may receive one, what it says, and how a
// message is identified so it is never sent twice. Pure functions only; sending
// is done server-side by a transport (mock in demo, Meta Cloud API when enabled).
//
// A message is only sent when ALL of these hold: a valid number, messaging
// enabled for the worker, consent given, attendance confirmed as present with a
// confirmed OUT (so the duration is complete), the work date on or after the
// messaging start date (no retroactive messages for older or imported records),
// and no message already sent for that record. Absences never get a message.
// Messages contain no wages or payment amounts.

export type ConsentStatus = "unknown" | "granted" | "withdrawn";
/** hi = Hindi (Devanagari), hi_latn = Hindi in Roman letters, en = English */
export type MessageLanguage = "hi" | "hi_latn" | "en";
export type MessageKind = "attendance" | "correction" | "test";
export type MessageStatus = "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "cancelled";

export interface WorkerContact {
  workerId: string;
  /** "+91" for India; "+999" marks a fictional demo number (never real) */
  countryCode: string;
  /** national number, digits only */
  whatsappNumber: string | null;
  enabled: boolean;
  consentStatus: ConsentStatus;
  consentAt: string | null;
  /** how consent was given or withdrawn, e.g. "Signed form at gate", "Verbal, recorded by supervisor" */
  consentSource: string | null;
  preferredLanguage: MessageLanguage | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ConsentEvent {
  id: string;
  workerId: string;
  consentStatus: ConsentStatus;
  source: string | null;
  at: string;
  by: string | null;
}

export interface MessagingSettings {
  /** automatic daily messages */
  enabled: boolean;
  /** stops queuing and sending until resumed (queued messages wait) */
  paused: boolean;
  /** daily send time in the head-office timezone, "HH:mm" */
  sendTime: string;
  defaultLanguage: MessageLanguage;
  /** add an English line under the Hindi text */
  includeEnglish: boolean;
  /** Meta template names (must be approved in WhatsApp Manager before live use) */
  attendanceTemplate: string;
  correctionTemplate: string;
  /** offer a separate notice when a record changes after its message was sent */
  correctionNotices: boolean;
  /** only work dates on or after this get messages (no retroactive sending) */
  startDate: string;
  /** number used for test messages, E.164 */
  testNumber: string | null;
  /** last head-office date the scheduled run happened */
  lastScheduledRun: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface OutboundMessage {
  id: string;
  idempotencyKey: string;
  kind: MessageKind;
  workerId: string | null;
  attendanceId: string | null;
  attendanceVersion: number | null;
  contractorId: string | null;
  projectId: string | null;
  workDate: string | null;
  shift: Shift | null;
  /** E.164, e.g. +91XXXXXXXXXX */
  to: string;
  language: MessageLanguage;
  templateName: string;
  /** template body parameters, in order */
  params: string[];
  /** the text as the worker sees it (for preview and history) */
  body: string;
  status: MessageStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  providerMessageId: string | null;
  transport: "mock" | "cloud_api" | null;
  createdAt: string;
  sentAt: string | null;
  updatedAt: string;
  createdBy: string | null;
}

export const DEFAULT_MESSAGING_SETTINGS: Omit<MessagingSettings, "startDate"> = {
  enabled: false,
  paused: false,
  sendTime: "20:00",
  defaultLanguage: "hi",
  includeEnglish: false,
  attendanceTemplate: "attendance_summary_hi",
  correctionTemplate: "attendance_correction_hi",
  correctionNotices: true,
  testNumber: null,
  lastScheduledRun: null,
  updatedAt: null,
  updatedBy: null,
};

export const FICTIONAL_COUNTRY_CODE = "+999";

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export type NumberCheck = { ok: true; e164: string; national: string; fictional: boolean } | { ok: false; reason: string };

/**
 * Validates a WhatsApp number. India (+91): a 10-digit mobile starting 6–9
 * (spaces, dashes, a leading 0 or 91 are accepted). "+999" is the fictional
 * demo code and is only accepted when `allowFictional` (demo mode).
 */
export function checkNumber(countryCode: string, raw: string | null, allowFictional = false): NumberCheck {
  if (!raw || !raw.trim()) return { ok: false, reason: "No number" };
  const cc = countryCode.trim().startsWith("+") ? countryCode.trim() : `+${countryCode.trim()}`;
  let digits = raw.replace(/[\s\-().]/g, "");
  if (/[^\d+]/.test(digits)) return { ok: false, reason: "Use digits only" };
  digits = digits.replace(/^\+/, "");
  if (cc === "+91") {
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    if (!/^[6-9]\d{9}$/.test(digits)) return { ok: false, reason: "Not a valid Indian mobile number (10 digits starting 6–9)" };
    return { ok: true, e164: `+91${digits}`, national: digits, fictional: false };
  }
  if (cc === FICTIONAL_COUNTRY_CODE) {
    if (!allowFictional) return { ok: false, reason: "Fictional demo numbers (+999) cannot receive messages" };
    if (!/^\d{6,10}$/.test(digits)) return { ok: false, reason: "Demo numbers have 6–10 digits" };
    return { ok: true, e164: `${cc}${digits}`, national: digits, fictional: true };
  }
  if (!/^\+[1-9]\d{0,3}$/.test(cc)) return { ok: false, reason: "Country code is not valid" };
  if (!/^\d{6,14}$/.test(digits) || cc.length - 1 + digits.length > 15) return { ok: false, reason: "Number is not valid" };
  return { ok: true, e164: `${cc}${digits}`, national: digits, fictional: false };
}

/** Shows a number with all but the last 4 digits hidden (history, logs). */
export const maskNumber = (e164: string) => (e164.length <= 6 ? e164 : `${e164.slice(0, 3)}${"•".repeat(Math.max(0, e164.length - 7))}${e164.slice(-4)}`);

// ---------------------------------------------------------------------------
// Eligibility and identity
// ---------------------------------------------------------------------------

export const attendanceKey = (attendanceId: string) => `att:${attendanceId}`;
export const correctionKey = (attendanceId: string, version: number) => `cor:${attendanceId}:v${version}`;

export type Ineligible =
  | "no_number"
  | "invalid_number"
  | "disabled"
  | "no_consent"
  | "not_present"
  | "no_checkout"
  | "before_start_date"
  | "already_sent";

export const INELIGIBLE_TEXT: Record<Ineligible, string> = {
  no_number: "No WhatsApp number",
  invalid_number: "WhatsApp number is not valid",
  disabled: "WhatsApp messages are turned off for this worker",
  no_consent: "No consent recorded (or consent withdrawn)",
  not_present: "Only confirmed present days get a message",
  no_checkout: "OUT time not confirmed yet",
  before_start_date: "Before the messaging start date (no retroactive messages)",
  already_sent: "Already sent",
};

export function eligibility(input: {
  contact: WorkerContact | null;
  record: Pick<AttendanceRecord, "id" | "status" | "checkInAt" | "checkOutAt" | "workDate">;
  startDate: string;
  sentKeys: ReadonlySet<string>;
  allowFictional: boolean;
}): { ok: true; to: string } | { ok: false; reason: Ineligible } {
  const { contact, record } = input;
  if (record.status !== "present") return { ok: false, reason: "not_present" };
  if (!record.checkInAt || !record.checkOutAt || minutesBetween(record.checkInAt, record.checkOutAt) <= 0) return { ok: false, reason: "no_checkout" };
  if (record.workDate < input.startDate) return { ok: false, reason: "before_start_date" };
  if (!contact || !contact.whatsappNumber) return { ok: false, reason: "no_number" };
  const n = checkNumber(contact.countryCode, contact.whatsappNumber, input.allowFictional);
  if (!n.ok) return { ok: false, reason: "invalid_number" };
  if (!contact.enabled) return { ok: false, reason: "disabled" };
  if (contact.consentStatus !== "granted") return { ok: false, reason: "no_consent" };
  if (input.sentKeys.has(attendanceKey(record.id))) return { ok: false, reason: "already_sent" };
  return { ok: true, to: n.e164 };
}

// ---------------------------------------------------------------------------
// Message text (no wages, ever)
// ---------------------------------------------------------------------------

export interface MessageFacts {
  workerName: string;
  /** "yyyy-MM-dd" */
  workDate: string;
  plantName: string;
  shift: Shift;
  /** local "HH:mm" */
  checkIn: string;
  checkOut: string;
  checkOutNextDay: boolean;
  workedMinutes: number;
}

const HI_MONTHS = ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"];
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dateText = (d: string, lang: MessageLanguage) => {
  const [y, m, day] = d.split("-").map(Number);
  return lang === "hi" ? `${day} ${HI_MONTHS[m - 1]} ${y}` : `${day} ${EN_MONTHS[m - 1]} ${y}`;
};
const hoursText = (min: number, lang: MessageLanguage) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (lang === "hi") return m ? `${h} घंटे ${m} मिनट` : `${h} घंटे`;
  if (lang === "hi_latn") return m ? `${h} ghante ${m} minute` : `${h} ghante`;
  return formatMinutes(min);
};
const timeText = (t: string, nextDay: boolean, lang: MessageLanguage) =>
  `${formatTime12(t)}${nextDay ? (lang === "hi" ? " (अगले दिन)" : lang === "hi_latn" ? " (agle din)" : " (next day)") : ""}`;
const shiftText = (s: Shift, lang: MessageLanguage) =>
  lang === "hi" ? (s === "night" ? "रात" : "दिन") : lang === "hi_latn" ? (s === "night" ? "raat" : "din") : s === "night" ? "Night" : "Day";

/** Template parameters in order: name, date, plant, shift, IN, OUT, worked time. */
export function messageParams(f: MessageFacts, lang: MessageLanguage): string[] {
  return [f.workerName, dateText(f.workDate, lang), f.plantName, shiftText(f.shift, lang), timeText(f.checkIn, false, lang), timeText(f.checkOut, f.checkOutNextDay, lang), hoursText(f.workedMinutes, lang)];
}

const TEMPLATES: Record<MessageLanguage, { attendance: string; correction: string }> = {
  hi: {
    attendance: "नमस्ते {1} जी, {2} की आपकी हाज़िरी दर्ज हो गई है।\nप्लांट: {3} ({4} शिफ्ट)\nआने का समय: {5}\nजाने का समय: {6}\nकुल समय: {7}\nकोई गलती हो तो अपने सुपरवाइज़र को बताएं।",
    correction: "नमस्ते {1} जी, {2} की आपकी हाज़िरी में सुधार किया गया है।\nप्लांट: {3} ({4} शिफ्ट)\nआने का समय: {5}\nजाने का समय: {6}\nकुल समय: {7}\nकोई सवाल हो तो अपने सुपरवाइज़र से पूछें।",
  },
  hi_latn: {
    attendance: "Namaste {1} ji, {2} ki aapki haaziri darj ho gayi hai.\nPlant: {3} ({4} shift)\nAane ka samay: {5}\nJaane ka samay: {6}\nKul samay: {7}\nKoi galti ho to apne supervisor ko batayein.",
    correction: "Namaste {1} ji, {2} ki aapki haaziri mein sudhaar kiya gaya hai.\nPlant: {3} ({4} shift)\nAane ka samay: {5}\nJaane ka samay: {6}\nKul samay: {7}\nKoi sawaal ho to apne supervisor se poochhein.",
  },
  en: {
    attendance: "Hello {1}, your attendance for {2} has been recorded.\nPlant: {3} ({4} shift)\nIN: {5}\nOUT: {6}\nTotal time: {7}\nIf anything is wrong, please tell your supervisor.",
    correction: "Hello {1}, your attendance for {2} has been corrected.\nPlant: {3} ({4} shift)\nIN: {5}\nOUT: {6}\nTotal time: {7}\nPlease ask your supervisor if you have questions.",
  },
};

const fill = (template: string, params: string[]) => template.replace(/\{(\d)\}/g, (_, i) => params[Number(i) - 1] ?? "");

/** The text a worker receives. With `includeEnglish`, Hindi messages get the English text below. */
export function renderMessage(kind: "attendance" | "correction", f: MessageFacts, lang: MessageLanguage, includeEnglish: boolean): { params: string[]; body: string } {
  const params = messageParams(f, lang);
  let body = fill(TEMPLATES[lang][kind], params);
  if (includeEnglish && lang !== "en") body += `\n\n${fill(TEMPLATES.en[kind], messageParams(f, "en"))}`;
  return { params, body };
}

/** Facts for a record (present with IN and OUT), in the plant's timezone. */
export function factsFor(record: Pick<AttendanceRecord, "workDate" | "shift" | "checkInAt" | "checkOutAt">, workerName: string, plantName: string, timezone: string, breakMinutes: number): MessageFacts {
  const inL = instantToLocal(record.checkInAt!, timezone);
  const outL = instantToLocal(record.checkOutAt!, timezone);
  return {
    workerName,
    workDate: record.workDate,
    plantName,
    shift: record.shift,
    checkIn: inL.time,
    checkOut: outL.time,
    checkOutNextDay: outL.date > record.workDate,
    workedMinutes: Math.max(0, minutesBetween(record.checkInAt!, record.checkOutAt!) - breakMinutes),
  };
}

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

/** Attempts allowed before a message is marked failed for good. */
export const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 5, 30, 120];

/** When to try again after `attempts` failed tries, or null when it should stop. */
export function nextAttemptAt(attempts: number, now: Date): string | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000).toISOString();
}

/** Whether the daily scheduled run is due: after the send time, once per head-office day. */
export function scheduledRunDue(settings: Pick<MessagingSettings, "enabled" | "paused" | "sendTime" | "lastScheduledRun">, today: string, nowTime: string): boolean {
  return settings.enabled && !settings.paused && nowTime >= settings.sendTime && settings.lastScheduledRun !== today;
}

/** Statuses after which the provider will not change a message any more (except delivered → read). */
export const STATUS_ORDER: Record<MessageStatus, number> = { queued: 0, sending: 1, failed: 2, cancelled: 2, sent: 3, delivered: 4, read: 5 };
