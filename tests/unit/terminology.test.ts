import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoState } from "@/lib/server/store/demo-seed";
import { NOW } from "./helpers";

// The app is for contractor labour inside manufacturing plants. Internally plants are
// still stored as "projects", but nothing a user reads may say project, site or
// government. This guards the source text users can see.

const SRC = join(process.cwd(), "src");
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|sql)$/.test(name) ? [p] : [];
  });
}

/** String literals and JSX text only (comments, identifiers and import paths are internal). */
function userFacingText(source: string): string[] {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const strings = [...noComments.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  const jsxText = [...noComments.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]);
  return [...strings, ...jsxText].filter((t) => !t.startsWith("@/") && !t.startsWith("./") && !t.startsWith("../"));
}

// Lower-case "project" / "projects" on their own are internal keys (query parameters,
// table names, nav keys), so only the capitalised label form is banned.
const BANNED = [/govern/i, /\bproject sites?\b/i, /\bsite operators?\b/i, /^Projects?$/, /\badd project\b/i, /\bthis site\b/i, /\ball projects\b/i];

describe("plant terminology", () => {
  it("no user-facing text in the app says government, project or site", () => {
    const hits: string[] = [];
    for (const file of files(SRC)) {
      for (const text of userFacingText(readFileSync(file, "utf8"))) {
        if (BANNED.some((re) => re.test(text.trim()))) hits.push(`${file.slice(SRC.length + 1)}: ${text.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("database messages users can see say plant (latest definition of each function)", () => {
    // The body each function has after all migrations: the last definition wins.
    const latest = new Map<string, string>();
    for (const f of files(MIGRATIONS).map((x) => x.slice(MIGRATIONS.length + 1)).sort()) {
      const sql = readFileSync(join(MIGRATIONS, f), "utf8");
      for (const m of sql.matchAll(/create (?:or replace )?function public\.(\w+)\(.*?\n\$\$;/gs)) latest.set(m[1], m[0]);
    }
    const messages = [...latest.values()].flatMap((body) => [...body.matchAll(/raise exception '([^']*(?:''[^']*)*)'/g)].map((m) => m[1]));
    expect(messages.length).toBeGreaterThan(5);
    expect(messages.filter((m) => /\b(project|site|deployed)\b/i.test(m))).toEqual([]);
  });

  it("demo data is manufacturing plants with fictional names", () => {
    const state = createDemoState(NOW);
    expect(state.projects.map((p) => p.name)).toEqual([
      "PVC Plant (Demo)",
      "LED Rope Light Plant (Demo)",
      "Upcast Plant (Demo)",
      "Quad & Signalling Plant (Demo)",
    ]);
    expect(state.contractors).toHaveLength(4);
    for (const c of [...state.projects, ...state.contractors]) expect(c.name).toMatch(/\(Demo\)$/);
    const text = JSON.stringify([state.projects, state.contractors, state.profiles]);
    expect(text).not.toMatch(/govern|hospital|metro|railway|street lighting|water treatment/i);
  });
});
