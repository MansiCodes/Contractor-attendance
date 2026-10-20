import { addDays, dayOfWeek, DEFAULT_TIMEZONE, localToInstant, nowTimeIn, todayIn } from "@/lib/domain/time";
import type {
  AttendanceRecord,
  AuditLog,
  Contractor,
  ContractorProjectAssignment,
  OperatorAccess,
  PaymentRule,
  Profile,
  Project,
  Worker,
  WorkerAssignment,
} from "@/lib/domain/types";

// Obviously fictional demo data. Every contractor and project name carries
// "(Demo)" and every rate is marked illustrative. This module is only ever
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
  audit: AuditLog[];
  seq: { worker: number; audit: number; id: number };
}

export const DEMO_USERS = {
  admin: "demo-admin",
  jaipur: "demo-op-jaipur",
  puneLucknow: "demo-op-pune-lucknow",
  east: "demo-op-east",
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
  const tz = DEFAULT_TIMEZONE;
  const today = todayIn(tz, now);
  const createdAt = iso(localToInstant(addDays(today, -90), "10:00", tz));

  const profiles: Profile[] = [
    { id: DEMO_USERS.admin, fullName: "Demo Admin (NF Head Office)", email: "admin@demo.invalid", role: "admin", isActive: true, createdAt },
    { id: DEMO_USERS.jaipur, fullName: "Demo Operator – Jaipur", email: "jaipur.operator@demo.invalid", role: "operator", isActive: true, createdAt },
    { id: DEMO_USERS.puneLucknow, fullName: "Demo Operator – Pune & Lucknow", email: "pune.operator@demo.invalid", role: "operator", isActive: true, createdAt },
    { id: DEMO_USERS.east, fullName: "Demo Operator – Guwahati & Bhubaneswar", email: "east.operator@demo.invalid", role: "operator", isActive: true, createdAt },
  ];

  const contractor = (id: string, name: string, location: string): Contractor => ({
    id, name, location, photoPath: null, photoUrl: null, isActive: true, createdAt, updatedAt: createdAt,
  });
  const contractors = [
    contractor("c1", "Shakti Labour Services (Demo)", "Jaipur, Rajasthan"),
    contractor("c2", "Pragati Manpower (Demo)", "Pune, Maharashtra"),
    contractor("c3", "Brahmaputra Contractors (Demo)", "Guwahati, Assam"),
    contractor("c4", "Kalinga Workforce (Demo)", "Bhubaneswar, Odisha"),
  ];

  const project = (id: string, name: string, location: string, extra: Partial<Project> = {}): Project => ({
    id, name, location, isActive: true, timezone: tz, defaultCheckIn: "09:00", allowOvernight: false,
    operatorBackdateDays: 0, createdAt, updatedAt: createdAt, ...extra,
  });
  const projects = [
    project("p1", "Railway Signalling Installation (Demo)", "Jaipur, Rajasthan", { operatorBackdateDays: 1 }),
    project("p2", "District Hospital Fire Safety Retrofit (Demo)", "Pune, Maharashtra"),
    project("p3", "Smart Street Lighting Works (Demo)", "Lucknow, Uttar Pradesh"),
    project("p4", "Water Treatment Plant Fire Systems (Demo)", "Guwahati, Assam"),
    project("p5", "Metro Depot Fire Protection (Demo)", "Bhubaneswar, Odisha", { allowOvernight: true }),
  ];

  const deployments: [string, string, number][] = [
    ["c1", "p1", 9], ["c1", "p3", 5],
    ["c2", "p2", 7], ["c2", "p1", 5],
    ["c3", "p4", 8], ["c3", "p5", 4],
    ["c4", "p2", 5], ["c4", "p3", 4], ["c4", "p5", 5],
  ];

  const startDate = addDays(today, -60);
  const contractorProjects: ContractorProjectAssignment[] = deployments.map(([c, p], i) => ({
    id: `cp${i + 1}`, contractorId: c, projectId: p, startDate, endDate: null,
  }));

  const workers: Worker[] = [];
  const assignments: WorkerAssignment[] = [];
  let workerSeq = 0;
  let devIdx = 0;
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
    workers.push({
      id, code: `W-${String(workerSeq).padStart(5, "0")}`, fullName: nextName(), contractorId,
      isActive: active, phone: null, notes: null, createdAt, updatedAt: createdAt,
    });
    assignments.push({ id: `wa${assignments.length + 1}`, workerId: id, projectId, contractorId, startDate: start, endDate: end, createdAt });
    return id;
  };

  for (const [c, p, n] of deployments) for (let i = 0; i < n; i++) addWorker(c, p);

  // A worker transferred from Lucknow (p3) to Jaipur (p1) ten days ago — history stays at p3.
  const transferDate = addDays(today, -10);
  const transferred = addWorker("c1", "p3", startDate, addDays(transferDate, -1));
  assignments.push({ id: `wa${assignments.length + 1}`, workerId: transferred, projectId: "p1", contractorId: "c1", startDate: transferDate, endDate: null, createdAt });
  // A worker deactivated five days ago.
  addWorker("c2", "p2", startDate, addDays(today, -5), false);

  const operatorAccess: OperatorAccess[] = [
    { id: "oa1", operatorId: DEMO_USERS.jaipur, projectId: "p1", grantedAt: createdAt, revokedAt: null },
    { id: "oa2", operatorId: DEMO_USERS.puneLucknow, projectId: "p2", grantedAt: createdAt, revokedAt: null },
    { id: "oa3", operatorId: DEMO_USERS.puneLucknow, projectId: "p3", grantedAt: createdAt, revokedAt: null },
    { id: "oa4", operatorId: DEMO_USERS.east, projectId: "p4", grantedAt: createdAt, revokedAt: null },
    { id: "oa5", operatorId: DEMO_USERS.east, projectId: "p5", grantedAt: createdAt, revokedAt: null },
  ];
  const operatorFor: Record<string, string> = { p1: DEMO_USERS.jaipur, p2: DEMO_USERS.puneLucknow, p3: DEMO_USERS.puneLucknow, p4: DEMO_USERS.east, p5: DEMO_USERS.east };

  const rule = (id: string, contractorId: string, version: number, effectiveFrom: string, r: Partial<PaymentRule>): PaymentRule => ({
    id, contractorId, version, effectiveFrom, rateType: "per_day", dayRate: null, hourRate: null, fullDayHours: null,
    halfDayHours: null, overtimeEnabled: false, overtimeAfterHours: null, overtimeHourRate: null, unpaidBreakMinutes: 0,
    notes: "Illustrative demo rate — not a real agreed rate", createdAt, createdBy: DEMO_USERS.admin, ...r,
  });
  const rateChange = addDays(today, -7);
  const rules: PaymentRule[] = [
    rule("r1", "c1", 1, addDays(today, -90), { dayRate: 650, fullDayHours: 8, halfDayHours: 4, unpaidBreakMinutes: 30, overtimeEnabled: true, overtimeAfterHours: 9, overtimeHourRate: 90 }),
    rule("r2", "c1", 2, rateChange, { dayRate: 700, fullDayHours: 8, halfDayHours: 4, unpaidBreakMinutes: 30, overtimeEnabled: true, overtimeAfterHours: 9, overtimeHourRate: 95, createdAt: iso(localToInstant(rateChange, "11:00", tz)) }),
    rule("r3", "c2", 1, addDays(today, -90), { rateType: "per_hour", hourRate: 85, unpaidBreakMinutes: 30 }),
    rule("r4", "c3", 1, addDays(today, -90), { dayRate: 600 }),
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
    const rec: AttendanceRecord = {
      id: `a${attendance.length + 1}`, workerId, projectId, contractorId, workDate, status, checkInAt, checkOutAt,
      method, version: 1, createdAt: stamp, updatedAt: stamp, createdBy: by, updatedBy: by,
    };
    attendance.push(rec);
    audit.push({
      id: String(++auditSeq), attendanceId: rec.id, workerId, projectId, contractorId, workDate, action: "create", method,
      changedBy: by, changedByRole: "operator", changedAt: stamp, oldValues: null,
      newValues: { status, checkInAt, checkOutAt },
    });
  };

  const pad = (n: number) => String(n).padStart(2, "0");
  const time = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

  for (let back = 24; back >= 1; back--) {
    const date = addDays(today, -back);
    if (dayOfWeek(date) === 0) continue; // Sunday off on demo sites
    for (const a of assignments) {
      if (a.startDate > date || (a.endDate !== null && a.endDate < date)) continue;
      const r = rand();
      if (back <= 2 && r < 0.06) continue; // a few still unconfirmed → pending
      if (r < 0.1) {
        pushRecord(a.workerId, a.projectId, a.contractorId, date, "absent", null, null, false, "individual");
        continue;
      }
      const night = a.projectId === "p5" && a.contractorId === "c3";
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

  // Today: Jaipur (p1, Shakti) is partly marked once the morning has started; everything else is pending.
  if (nowTimeIn(tz, now) >= "10:00") {
    for (const a of assignments) {
      if (a.projectId !== "p1" || a.contractorId !== "c1" || a.endDate !== null) continue;
      const r = rand();
      if (r < 0.15) continue;
      if (r < 0.25) pushRecord(a.workerId, a.projectId, a.contractorId, today, "absent", null, null, false, "individual");
      else pushRecord(a.workerId, a.projectId, a.contractorId, today, "present", r < 0.7 ? "09:00" : "09:20", null, false, r < 0.7 ? "bulk" : "individual");
    }
  }

  return {
    profiles, contractors, photos: {}, projects, contractorProjects, workers, assignments, operatorAccess,
    attendance, rules, audit, seq: { worker: workerSeq, audit: auditSeq, id: 1000 },
  };
}
