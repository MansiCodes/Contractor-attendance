import { forbidden, notFound } from "@/lib/errors";
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

export async function assertProjectAccess(ctx: ServiceContext, projectId: string): Promise<Project> {
  const projects = await accessibleProjects(ctx);
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    if (ctx.actor.role === "admin") throw notFound("Project");
    throw forbidden("You are not authorised for this project site");
  }
  return project;
}
