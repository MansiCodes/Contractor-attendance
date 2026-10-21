import { z } from "zod";
import { POLICY_EPOCH, POLICY_FIELDS, REQUIRED_POLICY_FIELDS } from "./policy";
import { isValidDate, isValidTime, isValidTimezone } from "./time";

// Input validation shared by client forms (React Hook Form) and server actions.

export const dateString = z.string().refine(isValidDate, "Enter a valid date");
export const timeString = z.string().refine(isValidTime, "Enter a valid time (HH:mm)");
export const id = z.string().min(1, "Required").max(64);

const name = (label: string) =>
  z
    .string()
    .trim()
    .min(2, `${label} must have at least 2 characters`)
    .max(120, `${label} is too long`);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish() // the client resolver already turns "" into null before sending
    .transform((v) => (v ? v : null));

export const contractorInput = z.object({
  name: name("Contractor name"),
  location: name("Location"),
});
export type ContractorInput = z.input<typeof contractorInput>;

export const contractorUpdate = contractorInput.extend({ isActive: z.boolean() });

export const timezoneString = z.string().trim().refine(isValidTimezone, "Choose a valid timezone");

// Attendance rules (suggested IN, overnight, past-day edits) live in attendance policies, not here.
export const projectInput = z.object({
  name: name("Project name"),
  location: name("Location"),
  isActive: z.boolean().default(true),
  timezone: timezoneString,
});
export type ProjectInput = z.input<typeof projectInput>;

const optionalTime = z.preprocess((v) => (v === "" || v === undefined ? null : v), timeString.nullable());
const optionalInt = (min: number, max: number) =>
  z.preprocess((v) => (v === "" || v === undefined || v === null ? null : v), z.coerce.number().int().min(min).max(max).nullable());
const optionalHours = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? null : v),
  z.coerce.number().min(0.25, "At least 0.25 hours").max(24, "Must be 24 hours or less").nullable(),
);

/**
 * One new policy version. projectId null = company defaults (every required field set).
 * For a site, `overridden` lists the fields it sets; every other field inherits the company value.
 */
export const attendancePolicyInput = z
  .object({
    projectId: id.nullable(),
    effectiveFrom: dateString,
    overridden: z.array(z.enum(POLICY_FIELDS)).default([]),
    suggestedCheckIn: optionalTime,
    shiftStart: optionalTime,
    shiftEnd: optionalTime,
    allowOvernight: z.boolean().nullable().default(null),
    inFutureToleranceMin: optionalInt(0, 240),
    outFutureToleranceMin: optionalInt(0, 60),
    lateGraceMin: optionalInt(0, 240),
    halfDayBelowHours: optionalHours,
    overtimeAfterHours: optionalHours,
    overtimeMinMinutes: optionalInt(0, 240),
    operatorBackdateDays: optionalInt(0, 7),
    editCutoffTime: optionalTime,
    autoAbsentEnabled: z.boolean().nullable().default(null),
    defaultTimezone: z.preprocess((v) => (v === "" || v === undefined ? null : v), timezoneString.nullable()),
    notes: optionalText(300),
    allowBackdate: z.boolean().default(false),
  })
  .transform((v) => {
    if (v.projectId === null) return { ...v, overridden: [...POLICY_FIELDS] };
    // A site row only stores what it overrides.
    const overridden = POLICY_FIELDS.filter((f) => v.overridden.includes(f));
    const out = { ...v, overridden, defaultTimezone: null };
    for (const f of POLICY_FIELDS) if (!overridden.includes(f)) (out as Record<string, unknown>)[f] = null;
    return out;
  })
  .superRefine((v, ctx) => {
    const company = v.projectId === null;
    if (v.effectiveFrom < POLICY_EPOCH) ctx.addIssue({ code: "custom", path: ["effectiveFrom"], message: `Choose a date from ${POLICY_EPOCH}` });
    if (company && !v.defaultTimezone) ctx.addIssue({ code: "custom", path: ["defaultTimezone"], message: "Choose the timezone for new sites" });
    for (const f of REQUIRED_POLICY_FIELDS) {
      if ((company || v.overridden.includes(f)) && v[f] === null) ctx.addIssue({ code: "custom", path: [f], message: "Required" });
    }
    if (!company && v.overridden.includes("shiftStart") !== v.overridden.includes("shiftEnd"))
      ctx.addIssue({ code: "custom", path: ["shiftEnd"], message: "Shift start and end are set together" });
    if ((v.shiftStart === null) !== (v.shiftEnd === null))
      ctx.addIssue({ code: "custom", path: ["shiftEnd"], message: "Set both shift start and end, or neither" });
    if (v.halfDayBelowHours !== null && v.overtimeAfterHours !== null && v.halfDayBelowHours >= v.overtimeAfterHours)
      ctx.addIssue({ code: "custom", path: ["halfDayBelowHours"], message: "Half-day threshold must be below the overtime threshold" });
  });
export type AttendancePolicyInput = z.input<typeof attendancePolicyInput>;

export const workerCreate = z.object({
  fullName: name("Worker name"),
  contractorId: id,
  projectId: id,
  startDate: dateString,
  phone: optionalText(20),
  notes: optionalText(300),
});
export type WorkerCreateInput = z.input<typeof workerCreate>;

export const workerUpdate = z.object({
  fullName: name("Worker name"),
  phone: optionalText(20),
  notes: optionalText(300),
});

export const workerTransfer = z.object({
  projectId: id,
  contractorId: id,
  effectiveDate: dateString,
});

export const workerDeactivate = z.object({ lastWorkingDate: dateString });
export const workerReactivate = z.object({ projectId: id, startDate: dateString });

export const operatorCreate = z.object({
  fullName: name("Name"),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  // Required in live mode (checked by the service); not used in demo mode.
  password: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(8, "At least 8 characters").max(72).optional()),
});

const money = z.coerce.number().min(0, "Cannot be negative").max(1_000_000);
const hours = z.coerce.number().min(0.25, "Too small").max(24, "Must be 24 hours or less");
const optionalNumber = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" || v === undefined || v === null ? null : v), schema.nullable());

export const paymentRuleInput = z
  .object({
    contractorId: id,
    effectiveFrom: dateString,
    rateType: z.enum(["per_day", "per_hour"]),
    dayRate: optionalNumber(money),
    hourRate: optionalNumber(money),
    fullDayHours: optionalNumber(hours),
    halfDayHours: optionalNumber(hours),
    overtimeEnabled: z.boolean().default(false),
    overtimeAfterHours: optionalNumber(hours),
    overtimeHourRate: optionalNumber(money),
    unpaidBreakMinutes: z.coerce.number().int().min(0).max(240).default(0),
    notes: optionalText(300),
    allowBackdate: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.rateType === "per_day" && v.dayRate === null)
      ctx.addIssue({ code: "custom", path: ["dayRate"], message: "Enter the per-day rate" });
    if (v.rateType === "per_hour" && v.hourRate === null)
      ctx.addIssue({ code: "custom", path: ["hourRate"], message: "Enter the per-hour rate" });
    if (v.fullDayHours !== null && v.halfDayHours !== null && v.halfDayHours >= v.fullDayHours)
      ctx.addIssue({ code: "custom", path: ["halfDayHours"], message: "Half-day must be less than full-day" });
    if (v.halfDayHours !== null && v.fullDayHours === null && v.rateType === "per_day")
      ctx.addIssue({ code: "custom", path: ["fullDayHours"], message: "Set a full-day threshold too" });
    if (v.overtimeEnabled) {
      if (v.overtimeAfterHours === null)
        ctx.addIssue({ code: "custom", path: ["overtimeAfterHours"], message: "Enter when overtime starts" });
      if (v.overtimeHourRate === null)
        ctx.addIssue({ code: "custom", path: ["overtimeHourRate"], message: "Enter the overtime rate" });
    }
  });
export type PaymentRuleInput = z.input<typeof paymentRuleInput>;

export const attendanceItem = z.object({
  workerId: id,
  status: z.enum(["pending", "present", "absent"]),
  checkIn: timeString.nullable(),
  checkOut: timeString.nullable(),
  /** "suggested" only when the operator accepted the site's suggested IN unchanged */
  checkInSource: z.enum(["entered", "suggested"]).nullable().default(null),
  method: z.enum(["individual", "bulk"]),
  /** version of the record the client edited; null when no record existed */
  expectedVersion: z.number().int().nullable(),
});
export type AttendanceItemInput = z.infer<typeof attendanceItem>;

export const attendanceBatch = z.object({
  projectId: id,
  contractorId: id,
  workDate: dateString,
  items: z.array(attendanceItem).min(1).max(500),
  /** the register's policy token; a mismatch means the site's settings changed while editing */
  policyToken: z.string().max(400).optional(),
});
export type AttendanceBatchInput = z.infer<typeof attendanceBatch>;

export const reportFilter = z.object({
  from: dateString,
  to: dateString,
  projectId: z.string().optional().nullable(),
  contractorId: z.string().optional().nullable(),
});
