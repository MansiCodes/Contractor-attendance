import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

// All elapsed-time maths is done on absolute instants (epoch milliseconds),
// never by subtracting formatted strings. Calendar dates are plain
// "yyyy-MM-dd" strings interpreted in a project's own timezone.

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function isValidDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function parseDate(date: string): [number, number, number] {
  if (!isValidDate(date)) throw new Error(`Invalid date: ${date}`);
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

function parseTime(time: string): [number, number] {
  if (!isValidTime(time)) throw new Error(`Invalid time: ${time}`);
  const [h, m] = time.split(":").map(Number);
  return [h, m];
}

/** Calendar arithmetic on date strings, independent of server timezone. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function dayOfWeek(date: string): number {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function monthRange(date: string): { from: string; to: string } {
  const [y, m] = parseDate(date);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}` };
}

/** Today's calendar date in the given timezone. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  return format(new TZDate(now.getTime(), timezone), "yyyy-MM-dd");
}

/** Current wall-clock time ("HH:mm") in the given timezone. */
export function nowTimeIn(timezone: string, now: Date = new Date()): string {
  return format(new TZDate(now.getTime(), timezone), "HH:mm");
}

/** Converts a local date + wall-clock time in `timezone` to an absolute instant. */
export function localToInstant(date: string, time: string, timezone: string): Date {
  const [y, mo, d] = parseDate(date);
  const [h, mi] = parseTime(time);
  return new Date(new TZDate(y, mo - 1, d, h, mi, 0, timezone).getTime());
}

/** Converts an absolute instant to local date and time strings in `timezone`. */
export function instantToLocal(iso: string, timezone: string): { date: string; time: string } {
  const z = new TZDate(new Date(iso).getTime(), timezone);
  return { date: format(z, "yyyy-MM-dd"), time: format(z, "HH:mm") };
}

export function minutesBetween(startIso: string, endIso: string): number {
  return Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000);
}

/** "09:00" -> "09:00 AM" */
export function formatTime12(time: string): string {
  const [h, m] = parseTime(time);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "2026-10-20" -> "Tue, 20 Oct 2026" */
export function formatDateLong(date: string): string {
  const [y, m, d] = parseDate(date);
  return format(new Date(y, m - 1, d), "EEE, d MMM yyyy");
}

/** "2026-10-20" -> "Tuesday, 20 October" (the year is added when it differs from `today`'s) */
export function formatDateHeading(date: string, today?: string): string {
  const [y, m, d] = parseDate(date);
  const sameYear = !today || today.slice(0, 4) === date.slice(0, 4);
  return format(new Date(y, m - 1, d), sameYear ? "EEEE, d MMMM" : "EEEE, d MMMM yyyy");
}

/** "2026-10-20" -> "20 Oct" */
export function formatDateShort(date: string): string {
  const [y, m, d] = parseDate(date);
  return format(new Date(y, m - 1, d), "d MMM");
}

export function formatMonth(date: string): string {
  const [y, m] = parseDate(date);
  return format(new Date(y, m - 1, 1), "MMMM yyyy");
}

/** 510 -> "8h 30m" */
export function formatMinutes(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  return `${sign}${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, "0")}m`;
}

export function shiftTime(time: string, deltaMinutes: number): string {
  const [h, m] = parseTime(time);
  const total = (((h * 60 + m + deltaMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function roundTimeTo(time: string, step: number): string {
  const [h, m] = parseTime(time);
  const total = Math.round((h * 60 + m) / step) * step;
  return shiftTime("00:00", Math.min(total, 1435));
}

export type ShiftResolution =
  | { ok: true; checkInAt: string; checkOutAt: string | null; overnight: boolean }
  | { ok: false; error: string };

/**
 * Resolves local IN/OUT wall-clock times for a work date into instants.
 * OUT earlier than or equal to IN is rejected unless overnight shifts are
 * explicitly enabled for the project, in which case OUT is placed on the next day.
 */
export function resolveShift(
  workDate: string,
  checkIn: string,
  checkOut: string | null,
  timezone: string,
  allowOvernight: boolean,
): ShiftResolution {
  if (!isValidTime(checkIn)) return { ok: false, error: "IN time is not valid" };
  const inAt = localToInstant(workDate, checkIn, timezone);
  if (checkOut === null) return { ok: true, checkInAt: inAt.toISOString(), checkOutAt: null, overnight: false };
  if (!isValidTime(checkOut)) return { ok: false, error: "OUT time is not valid" };
  let outAt = localToInstant(workDate, checkOut, timezone);
  let overnight = false;
  if (outAt.getTime() <= inAt.getTime()) {
    if (!allowOvernight) return { ok: false, error: "OUT time must be after IN time" };
    outAt = localToInstant(addDays(workDate, 1), checkOut, timezone);
    overnight = true;
  }
  return { ok: true, checkInAt: inAt.toISOString(), checkOutAt: outAt.toISOString(), overnight };
}
