import { z } from "zod";
import { isValidDate, isValidTime } from "./time";

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

export const projectInput = z.object({
  name: name("Project name"),
  location: name("Location"),
  isActive: z.boolean().default(true),
  timezone: z.string().min(1).default("Asia/Kolkata"),
  defaultCheckIn: timeString.default("09:00"),
  allowOvernight: z.boolean().default(false),
  operatorBackdateDays: z.coerce.number().int().min(0).max(7).default(0),
});
export type ProjectInput = z.input<typeof projectInput>;

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
});
export type AttendanceBatchInput = z.infer<typeof attendanceBatch>;

export const reportFilter = z.object({
  from: dateString,
  to: dateString,
  projectId: z.string().optional().nullable(),
  contractorId: z.string().optional().nullable(),
});
