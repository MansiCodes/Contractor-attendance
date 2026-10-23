import { FALLBACK_POLICY, FALLBACK_TIMEZONE, POLICY_EPOCH, POLICY_FIELDS, type AttendancePolicyVersion, type PolicyField, type PolicyRowValues } from "@/lib/domain/policy";
import { addDays, dayOfWeek, localToInstant, nowTimeIn, todayIn } from "@/lib/domain/time";
import { DEFAULT_MESSAGING_SETTINGS, type ConsentEvent, type MessagingSettings, type OutboundMessage, type WorkerContact } from "@/lib/domain/messaging";
import type {
  AttendanceRecord,
  AuditLog,
  Contractor,
  ContractorProjectAssignment,
  ImportBatch,
  OperatorAccess,
  PaymentRule,
  Profile,
  Project,
  Worker,
  WorkerAssignment,
  WorkerPayTerms,
} from "@/lib/domain/types";

// Obviously fictional demo data for contractor labour at manufacturing plants.
// Every contractor and plant name carries "(Demo)", every rate and shift setting
// is marked illustrative, and worker names are random combinations. This module is only ever
// imported by the demo store.

export interface DemoState {
  profiles: Profile[];
  contractors: Contractor[];
  photos: Record<string, string>;
  projects: Project[];
  contractorProjects: ContractorProjectAssignment[];
  workers: Worker[];
  assignments: WorkerAssignment[];
  operatorAccess: OperatorAccess[];
  attendance: AttendanceRecord[];
  rules: PaymentRule[];
  payTerms: WorkerPayTerms[];
  importBatches: ImportBatch[];
  contacts: WorkerContact[];
  consentEvents: ConsentEvent[];
  messaging: MessagingSettings | null;
  messages: OutboundMessage[];
  /** provider statuses that arrived before their message's send result */
  earlyStatuses: { providerMessageId: string; status: "sent" | "delivered" | "read" | "failed"; at: string; error: string | null }[];
  policies: AttendancePolicyVersion[];
  audit: AuditLog[];
  seq: { worker: number; audit: number; id: number };
}

export const DEMO_USERS = {
  admin: "demo-admin",
  pvc: "demo-op-pvc",
  ledUpcast: "demo-op-led-upcast",
  quad: "demo-op-quad",
} as const;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  "Ramesh", "Suresh", "Mahesh", "Sunita", "Anil", "Kavita", "Rajesh", "Pooja", "Deepak", "Manoj",
  "Geeta", "Vikram", "Arjun", "Lakshmi", "Bhupen", "Pranab", "Dipika", "Sanjay", "Ravi", "Meena",
  "Tapan", "Bijay", "Sarita", "Mukesh", "Asha", "Gopal", "Hemant", "Nirmala", "Kishore", "Rekha",
];
const LAST = [
  "Kumar", "Yadav", "Meena", "Gurjar", "Patil", "Jadhav", "Shinde", "Verma", "Mishra", "Pandey",
  "Bora", "Das", "Kalita", "Gogoi", "Nayak", "Sahoo", "Behera", "Mohanty", "Singh", "Chauhan",
];
// A few names in Devanagari to exercise Unicode rendering.
const DEVANAGARI = ["रामेश्वर यादव", "सुनीता देवी", "मोहन लाल", "गीता कुमारी", "हरि प्रसाद"];

const iso = (d: Date) => d.toISOString();

export function createDemoState(now: Date = new Date()): DemoState {
  const rand = mulberry32(20261020);
  const tz = FALLBACK_TIMEZONE; // every demo plant is in India
  const today = todayIn(tz, now);
  const createdAt = iso(localToInstant(addDays(today, -90), "10:00", tz));

  const profiles: Profile[] = [
    { id: DEMO_USERS.admin, fullName: "Demo Admin (Head Office)", email: "admin@demo.invalid", role: "admin", isActive: true, createdAt },
    { id: DEMO_USERS.pvc, fullName: "Demo Operator – PVC Plant", email: "pvc.operator@demo.invalid", role: "operator", isActive: true, createdAt },
    { id: DEMO_USERS.ledUpcast, fullName: "Demo Operator – LED & Upcast", email: "led.operator@demo.invalid", role: "operator", isActive: true, createdAt },
    { id: DEMO_USERS.quad, fullName: "Demo Operator – Quad & Signalling", email: "quad.operator@demo.invalid", role: "operator", isActive: true, createdAt },
  ];

  const contractor = (id: string, name: string, location: string): Contractor => ({
    id, name, location, legalName: null, identityStatus: "confirmed", identityNote: null,
    photoPath: null, photoUrl: null, isActive: true, createdAt, updatedAt: createdAt,
  });
  const contractors = [
    contractor("c1", "Shakti Labour Services (Demo)", "Industrial Estate (Demo)"),
    contractor("c2", "Pragati Manpower (Demo)", "Station Road (Demo)"),
    contractor("c3", "Sahyog Contract Services (Demo)", "Old Town (Demo)"),
    contractor("c4", "Udyam Workforce (Demo)", "Highway Road (Demo)"),
  ];

  const project = (id: string, name: string, location: string): Project => ({
    id, name, location, isActive: true, timezone: tz, createdAt, updatedAt: createdAt,
  });
  // Manufacturing plants (stored as "projects"). Illustrative names, not a fixed list.
  const projects = [
    project("p1", "PVC Plant (Demo)", "Unit 1 (Demo)"),
    project("p2", "LED Rope Light Plant (Demo)", "Unit 2 (Demo)"),
    project("p3", "Upcast Plant (Demo)", "Unit 3 (Demo)"),
    project("p4", "Quad & Signalling Plant (Demo)", "Unit 4 (Demo)"),
  ];

  // Attendance policies: the real company fallback, plus illustrative plant settings
  // (not real shifts or policies). Quad & Signalling (p4) keeps the company defaults,
  // so it shows the "no suggested time" flow.
  const blank = Object.fromEntries(POLICY_FIELDS.map((f) => [f, null])) as Record<PolicyField, null>;
  const sitePolicy = (id: string, projectId: string, values: Partial<PolicyRowValues>): AttendancePolicyVersion => ({
    ...blank, ...values, id, projectId, version: 1, effectiveFrom: POLICY_EPOCH, overridden: Object.keys(values) as PolicyField[],
    defaultTimezone: null, notes: "Illustrative demo settings", createdAt, createdBy: DEMO_USERS.admin,
  });
  const policies: AttendancePolicyVersion[] = [
    {
      ...FALLBACK_POLICY, id: "pol1", projectId: null, version: 1, effectiveFrom: POLICY_EPOCH, overridden: [...POLICY_FIELDS],
      defaultTimezone: tz, notes: "Initial company defaults", createdAt, createdBy: null,
    },
    sitePolicy("pol2", "p1", {
      suggestedCheckIn: "09:00", shiftStart: "09:00", shiftEnd: "17:30", breakMinutes: 30, lateGraceMin: 15,
      halfDayBelowHours: 4, overtimeAfterHours: 9, overtimeMinMinutes: 30, operatorBackdateDays: 1,
    }),
    sitePolicy("pol3", "p2", { suggestedCheckIn: "09:00" }),
    // Overnight plant: operators also get the next day, so they can record OUT after midnight.
    sitePolicy("pol4", "p3", { suggestedCheckIn: "09:00", nightSuggestedCheckIn: "21:00", allowOvernight: true, operatorBackdateDays: 1 }),
  ];
  const suggestionFor: Record<string, string | null> = { p1: "09:00", p2: "09:00", p3: "09:00", p4: null };

  // Each plant has several contractors; each contractor works in several plants.
  const deployments: [string, string, number][] = [
    ["c1", "p1", 9], ["c1", "p3", 5],
    ["c2", "p2", 7], ["c2", "p1", 5],
    ["c3", "p4", 8], ["c3", "p3", 4],
    ["c4", "p2", 5], ["c4", "p4", 4], ["c4", "p3", 5],
  ];

  const startDate = addDays(today, -60);
  const contractorProjects: ContractorProjectAssignment[] = deployments.map(([c, p], i) => ({
    id: `cp${i + 1}`, contractorId: c, projectId: p, startDate, endDate: null,
  }));

  const workers: Worker[] = [];
  const assignments: WorkerAssignment[] = [];
  let workerSeq = 0;
  let devIdx = 0;
  // Fictional contractor employee IDs, one series per demo contractor.
  const CODE_PREFIX: Record<string, string> = { c1: "DSK", c2: "DPM", c3: "DSC", c4: "DUW" };
  const codeSeq: Record<string, number> = {};
  const usedNames = new Set<string>();
  const nextName = () => {
    if (workerSeq % 11 === 3 && devIdx < DEVANAGARI.length) return DEVANAGARI[devIdx++];
    for (;;) {
      const n = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;
      if (!usedNames.has(n)) {
        usedNames.add(n);
        return n;
      }
    }
  };
  const addWorker = (contractorId: string, projectId: string, start = startDate, end: string | null = null, active = true) => {
    workerSeq++;
    const id = `w${workerSeq}`;
    const n = (codeSeq[contractorId] = (codeSeq[contractorId] ?? 1000) + 1);
    workers.push({
      id, code: `W-${String(workerSeq).padStart(5, "0")}`, employeeCode: `${CODE_PREFIX[contractorId]}${n}`, fullName: nextName(), contractorId,
      department: "Production (Demo)", designation: workerSeq % 3 === 0 ? "Operator (Demo)" : "Helper (Demo)", // no rand(): keeps the seeded sequence
      isActive: active, phone: null, notes: null, source: "Demo data", createdAt, updatedAt: createdAt,
    });
    assignments.push({ id: `wa${assignments.length + 1}`, workerId: id, projectId, contractorId, startDate: start, endDate: end, createdAt });
    return id;
  };

  for (const [c, p, n] of deployments) for (let i = 0; i < n; i++) addWorker(c, p);

  // A worker transferred from the Upcast Plant (p3) to the PVC Plant (p1) ten days ago; history stays at p3.
  const transferDate = addDays(today, -10);
  const transferred = addWorker("c1", "p3", startDate, addDays(transferDate, -1));
  assignments.push({ id: `wa${assignments.length + 1}`, workerId: transferred, projectId: "p1", contractorId: "c1", startDate: transferDate, endDate: null, createdAt });
  // A worker deactivated five days ago.
  addWorker("c2", "p2", startDate, addDays(today, -5), false);

  const operatorAccess: OperatorAccess[] = [
    { id: "oa1", operatorId: DEMO_USERS.pvc, projectId: "p1", grantedAt: createdAt, revokedAt: null },
    { id: "oa2", operatorId: DEMO_USERS.ledUpcast, projectId: "p2", grantedAt: createdAt, revokedAt: null },
    { id: "oa3", operatorId: DEMO_USERS.ledUpcast, projectId: "p3", grantedAt: createdAt, revokedAt: null },
    { id: "oa4", operatorId: DEMO_USERS.quad, projectId: "p4", grantedAt: createdAt, revokedAt: null },
  ];
  const operatorFor: Record<string, string> = { p1: DEMO_USERS.pvc, p2: DEMO_USERS.ledUpcast, p3: DEMO_USERS.ledUpcast, p4: DEMO_USERS.quad };

  const rule = (id: string, contractorId: string, version: number, effectiveFrom: string, r: Partial<PaymentRule>): PaymentRule => ({
    id, contractorId, version, effectiveFrom, rateSource: "contractor", rateType: "per_day", dayRate: null, hourRate: null, fullDayHours: null,
    halfDayHours: null, shortDayPolicy: null, monthlyDivisorDays: null, overtimeEnabled: false, overtimeAfterHours: null,
    overtimeAfterNightHours: null, overtimeRateMode: null, overtimeHourRate: null, overtimeMultiplier: null, overtimeRounding: null,
    overtimeMinMinutes: 0, unpaidBreakMinutes: 0, commissionEnabled: false, commissionPercent: null, commissionScope: null,
    commissionBase: null, commissionTreatment: null,
    notes: "Illustrative demo rate — not a real agreed rate", createdAt, createdBy: DEMO_USERS.admin, ...r,
  });
  const rateChange = addDays(today, -7);
  const rules: PaymentRule[] = [
    rule("r1", "c1", 1, addDays(today, -90), { dayRate: 650, fullDayHours: 8, halfDayHours: 4, shortDayPolicy: "half_day", unpaidBreakMinutes: 30, overtimeEnabled: true, overtimeAfterHours: 9, overtimeRateMode: "per_hour", overtimeHourRate: 90, overtimeRounding: "exact" }),
    // Commission on every worker, fully configured.
    rule("r2", "c1", 2, rateChange, {
      dayRate: 700, fullDayHours: 8, halfDayHours: 4, shortDayPolicy: "half_day", unpaidBreakMinutes: 30, overtimeEnabled: true, overtimeAfterHours: 9,
      overtimeRateMode: "per_hour", overtimeHourRate: 95, overtimeRounding: "exact",
      commissionEnabled: true, commissionPercent: 8, commissionScope: "all", commissionBase: "base_wages", commissionTreatment: "added_to_contractor_payable",
      createdAt: iso(localToInstant(rateChange, "11:00", tz)),
    }),
    // Commission for selected workers only; what it is calculated on is not decided yet.
    rule("r3", "c2", 1, addDays(today, -90), {
      rateType: "per_hour", hourRate: 85, fullDayHours: 8, shortDayPolicy: "pro_rata", unpaidBreakMinutes: 30,
      commissionEnabled: true, commissionPercent: 7.5, commissionScope: "selected",
    }),
    rule("r4", "c3", 1, addDays(today, -90), { dayRate: 600, shortDayPolicy: "full_day" }),
    // c4 intentionally has no rule: payable shows "Not configured".
  ];

  const attendance: AttendanceRecord[] = [];
  const audit: AuditLog[] = [];
  let auditSeq = 0;
  const pushRecord = (workerId: string, projectId: string, contractorId: string, workDate: string, status: "present" | "absent", inT: string | null, outT: string | null, outNextDay: boolean, method: "individual" | "bulk") => {
    const by = operatorFor[projectId];
    const checkInAt = inT ? iso(localToInstant(workDate, inT, tz)) : null;
    const checkOutAt = outT ? iso(localToInstant(outNextDay ? addDays(workDate, 1) : workDate, outT, tz)) : null;
    const stamp = checkOutAt ?? checkInAt ?? iso(localToInstant(workDate, "10:00", tz));
    // A bulk confirmation at the site's suggested time accepted the suggestion; anything else was entered.
    const checkInSource = status !== "present" ? null : method === "bulk" && inT === suggestionFor[projectId] ? "suggested" : "entered";
    const rec: AttendanceRecord = {
      id: `a${attendance.length + 1}`, workerId, projectId, contractorId, workDate, status, checkInAt, checkOutAt, checkInSource,
      shift: projectId === "p3" && contractorId === "c3" ? "night" : "day", // the Upcast night crew
      method, version: 1, createdAt: stamp, updatedAt: stamp, createdBy: by, updatedBy: by,
    };
    attendance.push(rec);
    audit.push({
      id: String(++auditSeq), attendanceId: rec.id, workerId, projectId, contractorId, workDate, action: "create", method,
      changedBy: by, changedByRole: "operator", changedAt: stamp, oldValues: null,
      newValues: { status, checkInAt, checkOutAt, checkInSource, shift: rec.shift },
    });
  };

  const pad = (n: number) => String(n).padStart(2, "0");
  const time = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

  for (let back = 24; back >= 1; back--) {
    const date = addDays(today, -back);
    if (dayOfWeek(date) === 0) continue; // Sunday off at the demo plants
    for (const a of assignments) {
      if (a.startDate > date || (a.endDate !== null && a.endDate < date)) continue;
      const r = rand();
      if (back <= 2 && r < 0.06) continue; // a few still unconfirmed → pending
      if (r < 0.1) {
        pushRecord(a.workerId, a.projectId, a.contractorId, date, "absent", null, null, false, "individual");
        continue;
      }
      const night = a.projectId === "p3" && a.contractorId === "c3"; // night shift at the Upcast Plant
      if (night) {
        const out = rand() < 0.1 ? null : time(5 * 60 + 15 + Math.floor(rand() * 4) * 15);
        pushRecord(a.workerId, a.projectId, a.contractorId, date, "present", "21:00", out, true, "individual");
        continue;
      }
      const lateRoll = rand();
      const inMin = lateRoll < 0.6 ? 540 : lateRoll < 0.75 ? 525 : 545 + Math.floor(rand() * 10) * 10;
      const outRoll = rand();
      const outMin = outRoll < 0.05 ? null : outRoll < 0.12 ? 13 * 60 + 30 : outRoll < 0.25 ? 19 * 60 + 15 : 17 * 60 + 30 + Math.floor(rand() * 5) * 10;
      pushRecord(a.workerId, a.projectId, a.contractorId, date, "present", time(inMin), outMin === null ? null : time(outMin), false, inMin === 540 ? "bulk" : "individual");
    }
  }

  // Today: the PVC Plant (p1, Shakti) is partly marked once the morning has started; everything else is pending.
  if (nowTimeIn(tz, now) >= "10:00") {
    for (const a of assignments) {
      if (a.projectId !== "p1" || a.contractorId !== "c1" || a.endDate !== null) continue;
      const r = rand();
      if (r < 0.15) continue;
      if (r < 0.25) pushRecord(a.workerId, a.projectId, a.contractorId, today, "absent", null, null, false, "individual");
      else pushRecord(a.workerId, a.projectId, a.contractorId, today, "present", r < 0.7 ? "09:00" : "09:20", null, false, r < 0.7 ? "bulk" : "individual");
    }
  }

  // Pragati (c2) pays commission to selected workers only: every third of its workers is selected.
  const payTerms: WorkerPayTerms[] = workers
    .filter((w) => w.contractorId === "c2")
    .filter((_, i) => i % 3 === 0)
    .map((w, i) => ({
      id: `pt${i + 1}`, workerId: w.id, version: 1, effectiveFrom: addDays(today, -90), rateAmount: null, rateBasis: "unconfirmed",
      commissionEligible: true, source: "Demo data", notes: "Illustrative: commission eligibility only", createdAt, createdBy: DEMO_USERS.admin,
    }));

  // WhatsApp contacts for some Shakti (c1) workers, with FICTIONAL numbers: "+999" is not
  // a real country code, so nothing here can ever reach a real phone. Mixed on purpose:
  // consent given, withdrawn, unknown, messages off, and one the mock treats as unreachable.
  const shakti = workers.filter((w) => w.contractorId === "c1" && w.isActive);
  const contacts: WorkerContact[] = shakti.slice(0, 8).map((w, i) => ({
    workerId: w.id, countryCode: "+999", whatsappNumber: i === 7 ? "5550000" : `55501${String(i).padStart(2, "0")}`,
    enabled: i !== 5, consentStatus: i === 3 ? "withdrawn" : i === 4 ? "unknown" : "granted", consentAt: i === 4 ? null : createdAt,
    consentSource: i === 4 ? null : "Demo: consent form (fictional)", preferredLanguage: i === 2 ? "en" : i === 1 ? "hi_latn" : "hi",
    updatedAt: createdAt, updatedBy: DEMO_USERS.admin,
  }));
  const consentEvents: ConsentEvent[] = contacts
    .filter((c) => c.consentStatus !== "unknown")
    .map((c, i) => ({ id: String(i + 1), workerId: c.workerId, consentStatus: c.consentStatus, source: c.consentSource, at: createdAt, by: DEMO_USERS.admin }));
  // Messaging starts off; from today only, so older demo records never get messages.
  const messaging: MessagingSettings = { ...DEFAULT_MESSAGING_SETTINGS, startDate: today };

  return {
    profiles, contractors, photos: {}, projects, contractorProjects, workers, assignments, operatorAccess,
    attendance, rules, payTerms, importBatches: [], contacts, consentEvents, messaging, messages: [], earlyStatuses: [], policies, audit, seq: { worker: workerSeq, audit: auditSeq, id: 1000 },
  };
}
