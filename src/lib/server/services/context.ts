import { forbidden, notFound } from "@/lib/errors";
import { companyDefaultTimezone, operatorEditClosesAt, policyToken, type ResolvedPolicy } from "@/lib/domain/policy";
import { todayIn } from "@/lib/domain/time";
import type { Actor, Project } from "@/lib/domain/types";
import type { DataStore } from "../store/types";

// Services are plain functions of (context, input). They never trust the UI:
// every call re-checks role and project access before touching the store.

export interface ServiceContext {
  actor: Actor;
  store: DataStore;
  now: Date;
}

export function assertAdmin(ctx: ServiceContext) {
  if (ctx.actor.role !== "admin") throw forbidden("Only NF admins can do this");
}

/** Project ids the actor may see. `null` means every project (admin). */
export async function accessibleProjectIds(ctx: ServiceContext): Promise<string[] | null> {
  if (ctx.actor.role === "admin") return null;
  const access = await ctx.store.listOperatorAccess();
  return [...new Set(access.filter((a) => a.operatorId === ctx.actor.id && !a.revokedAt).map((a) => a.projectId))];
}

export async function accessibleProjects(ctx: ServiceContext): Promise<Project[]> {
  const [ids, projects] = await Promise.all([accessibleProjectIds(ctx), ctx.store.listProjects()]);
  const visible = ids === null ? projects : projects.filter((p) => ids.includes(p.id) && p.isActive);
  return visible.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Head office's timezone (the company default from attendance settings), for
 * company-wide dates such as payment rule start dates and report defaults.
 */
export async function headOfficeTimezone(ctx: ServiceContext): Promise<string> {
  const versions = ctx.actor.role === "admin" ? await ctx.store.listAttendancePolicies() : [];
  return companyDefaultTimezone(versions, todayIn("UTC", ctx.now));
}

export async function headOfficeToday(ctx: ServiceContext): Promise<string> {
  return todayIn(await headOfficeTimezone(ctx), ctx.now);
}

export interface SitePolicies {
  /** the site's local date now */
  today: string;
  /** in force on the work date: suggested IN, shift, overnight, labels */
  day: ResolvedPolicy;
  /** in force on the site's today: edit window and future-time limits */
  capture: ResolvedPolicy;
  /** changes whenever either set of versions changes */
  token: string;
}

/** The attendance policy for a site and work date. Callers must have checked access to `project`. */
export async function sitePolicies(ctx: ServiceContext, project: Project, workDate: string): Promise<SitePolicies> {
  const today = todayIn(project.timezone, ctx.now);
  const [day, capture] = await Promise.all([
    ctx.store.getEffectivePolicy(project.id, workDate),
    workDate === today ? null : ctx.store.getEffectivePolicy(project.id, today),
  ]);
  return { today, day, capture: capture ?? day, token: policyToken(day, capture ?? day) };
}

/** Whether the actor may change attendance for `workDate` (admins: any date up to today). */
export function canEditDate(ctx: ServiceContext, project: Project, workDate: string, p: Pick<SitePolicies, "today" | "capture">): boolean {
  if (workDate > p.today) return false;
  if (ctx.actor.role === "admin") return true;
  return ctx.now.getTime() < operatorEditClosesAt(p.capture, workDate, project.timezone).getTime();
}

export async function assertProjectAccess(ctx: ServiceContext, projectId: string): Promise<Project> {
  const projects = await accessibleProjects(ctx);
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    if (ctx.actor.role === "admin") throw notFound("Plant");
    throw forbidden("You are not authorised for this plant");
  }
  return project;
}
