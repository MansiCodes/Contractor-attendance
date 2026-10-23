import { invalid, notFound } from "@/lib/errors";
import {
  companyDefaultTimezone,
  resolvePolicy,
  versionInForce,
  POLICY_FIELDS,
  type AttendancePolicyVersion,
  type EffectivePolicy,
  type PolicyField,
  type PolicyValues,
} from "@/lib/domain/policy";
import { attendancePolicyInput } from "@/lib/domain/schemas";
import { formatTime12, todayIn } from "@/lib/domain/time";
import type { Project } from "@/lib/domain/types";
import { assertAdmin, type ServiceContext } from "./context";

// Attendance settings: admin only. Raw versions (history, notes, authors) never
// leave this module for operators; they only ever see effective values through
// the register.

/** The settings a new version would start from, for each date from which they change. */
export interface PolicySnapshot {
  /** first date these values apply (a version's start, or today) */
  from: string;
  /** values in force for the scope on that date */
  values: PolicyValues;
  /** site: the fields its version in force overrides; company: every field */
  overridden: PolicyField[];
  /** company values in force on that date (what a site inherits) */
  company: PolicyValues;
  /** company timezone for new sites in force on that date */
  defaultTimezone: string;
}

export interface SiteSettings {
  project: Project;
  /** the site's local date now */
  today: string;
  /** values in force today, with where each came from */
  effective: EffectivePolicy;
  /** the site's own version in force today (null = everything inherited) */
  current: AttendancePolicyVersion | null;
  /** site versions that start after today */
  upcoming: AttendancePolicyVersion[];
  /** today's settings, then one per scheduled change (site or company) */
  snapshots: PolicySnapshot[];
  /** start dates of every version of this site */
  versionDates: string[];
  timezoneLocked: boolean;
  warnings: string[];
}

export interface SettingsView {
  /** the latest local date across sites: a company version starting before it relabels past days somewhere */
  companyToday: string;
  company: {
    effective: EffectivePolicy;
    current: AttendancePolicyVersion | null;
    upcoming: AttendancePolicyVersion[];
    snapshots: PolicySnapshot[];
    versionDates: string[];
    defaultTimezone: string;
  };
  sites: SiteSettings[];
  /** every version, newest first */
  history: AttendancePolicyVersion[];
  authors: Record<string, string>;
}

/** Configurations that are allowed but probably not what the admin wants. */
export function policyWarnings(p: PolicyValues): string[] {
  const w: string[] = [];
  if (p.allowOvernight && p.operatorBackdateDays === 0) {
    w.push("Overnight shifts are on, but operators can only edit today. An OUT after midnight will need head office. Allow at least 1 past day.");
  }
  if (p.operatorBackdateDays === 0 && p.editCutoffTime) {
    w.push(`Operators lose access to today's register at ${formatTime12(p.editCutoffTime)}, so they cannot record OUT times after that.`);
  }
  if (p.lateGraceMin !== null && !p.shiftStart) w.push("A late grace period is set, but there is no shift start, so nobody is labelled late.");
  return w;
}

function upcoming(versions: AttendancePolicyVersion[], projectId: string | null, today: string) {
  return versions.filter((v) => v.projectId === projectId && v.effectiveFrom > today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.version - b.version);
}

const values = (p: EffectivePolicy): PolicyValues => {
  const { source, companyPolicyId, sitePolicyId, ...v } = p;
  void source;
  void companyPolicyId;
  void sitePolicyId;
  return v;
};

/** One snapshot per date on which this scope's settings (or what it inherits) change, past and future, plus today. */
function snapshots(versions: AttendancePolicyVersion[], projectId: string | null, today: string): PolicySnapshot[] {
  const changes = versions.filter((v) => v.projectId === projectId || v.projectId === null).map((v) => v.effectiveFrom);
  return [...new Set([today, ...changes])].sort().map((from) => ({
    from,
    values: values(resolvePolicy(versions, projectId, from)),
    overridden: projectId ? versionInForce(versions, projectId, from)?.overridden ?? [] : [...POLICY_FIELDS],
    company: values(resolvePolicy(versions, null, from)),
    defaultTimezone: companyDefaultTimezone(versions, from),
  }));
}

const versionDates = (versions: AttendancePolicyVersion[], projectId: string | null) =>
  [...new Set(versions.filter((v) => v.projectId === projectId).map((v) => v.effectiveFrom))].sort();

function companyToday(ctx: ServiceContext, projects: Project[], versions: AttendancePolicyVersion[]): string {
  const fallback = todayIn(companyDefaultTimezone(versions, todayIn("UTC", ctx.now)), ctx.now);
  return projects.map((p) => todayIn(p.timezone, ctx.now)).reduce((a, b) => (b > a ? b : a), fallback);
}

export async function loadSettings(ctx: ServiceContext): Promise<SettingsView> {
  assertAdmin(ctx);
  const [projects, versions, locked, profiles] = await Promise.all([
    ctx.store.listProjects(),
    ctx.store.listAttendancePolicies(),
    ctx.store.listProjectsWithAttendance(),
    ctx.store.listProfiles(),
  ]);
  const cToday = companyToday(ctx, projects, versions);
  const sites = projects
    .map((project): SiteSettings => {
      const today = todayIn(project.timezone, ctx.now);
      const effective = resolvePolicy(versions, project.id, today);
      return {
        project,
        today,
        effective,
        current: versionInForce(versions, project.id, today),
        upcoming: upcoming(versions, project.id, today),
        snapshots: snapshots(versions, project.id, today),
        versionDates: versionDates(versions, project.id),
        timezoneLocked: locked.includes(project.id),
        warnings: policyWarnings(effective),
      };
    })
    .sort((a, b) => Number(b.project.isActive) - Number(a.project.isActive) || a.project.name.localeCompare(b.project.name));
  return {
    companyToday: cToday,
    company: {
      effective: resolvePolicy(versions, null, cToday),
      current: versionInForce(versions, null, cToday),
      upcoming: upcoming(versions, null, cToday),
      snapshots: snapshots(versions, null, cToday),
      versionDates: versionDates(versions, null),
      defaultTimezone: companyDefaultTimezone(versions, cToday),
    },
    sites,
    history: [...versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version),
    authors: Object.fromEntries(profiles.map((p) => [p.id, p.fullName])),
  };
}

/** Sites whose timezone can no longer change because attendance exists there. */
export async function lockedTimezones(ctx: ServiceContext): Promise<string[]> {
  assertAdmin(ctx);
  return ctx.store.listProjectsWithAttendance();
}

/** Timezone preselected when creating a site. */
export async function newSiteTimezone(ctx: ServiceContext): Promise<string> {
  assertAdmin(ctx);
  const [projects, versions] = await Promise.all([ctx.store.listProjects(), ctx.store.listAttendancePolicies()]);
  return companyDefaultTimezone(versions, companyToday(ctx, projects, versions));
}

/**
 * Appends a new company or site version. Versions are never edited: a change is a
 * new version from its effective date. A version starting before today relabels
 * days already recorded, so it needs explicit confirmation.
 */
export async function createPolicyVersion(ctx: ServiceContext, raw: unknown): Promise<AttendancePolicyVersion> {
  assertAdmin(ctx);
  const { allowBackdate, ...fields } = attendancePolicyInput.parse(raw);
  const [projects, versions] = await Promise.all([ctx.store.listProjects(), ctx.store.listAttendancePolicies()]);
  let today: string;
  if (fields.projectId) {
    const project = projects.find((p) => p.id === fields.projectId);
    if (!project) throw notFound("Plant");
    today = todayIn(project.timezone, ctx.now);
  } else {
    today = companyToday(ctx, projects, versions);
  }
  if (fields.effectiveFrom < today && !allowBackdate) {
    throw invalid(
      `This change starts before today (${today}). It would relabel attendance already recorded on those days. Tick "Apply to past dates" to confirm.`,
    );
  }
  return ctx.store.createAttendancePolicy(fields, ctx.actor);
}
