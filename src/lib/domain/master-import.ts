import type { Contractor, ContractorIdentityStatus, RateBasis, Worker, WorkerPayTerms } from "./types";

// Contractor worker master import (e.g. "Contractors Details.xlsx").
//
// Pure functions only: the server reads the workbook into SheetGrids (merge
// "slave" cells removed), then parseMaster() finds each sheet's header, worker
// rows and problems, and planMasterImport() compares that with what is already
// stored. Nothing is written until an admin has seen the preview and applied it.
//
// Rules the import never breaks:
// - employee IDs are kept exactly as written (inner spaces, leading zeros, O vs 0);
// - no plant assignment is inferred: imported workers start Unassigned;
// - a row is never merged with a different ID, and existing workers are only
//   changed when the admin approves that change;
// - rate amounts are kept as written; their basis (monthly/daily/hourly) is
//   chosen by the admin and stays "unconfirmed" until then.

export type CellValue = string | number | boolean | null;

export interface GridCell {
  row: number;
  col: number;
  value: CellValue;
  /** the cell holds a formula; `value` is its last calculated result */
  formula?: boolean;
}

export interface SheetGrid {
  name: string;
  cells: GridCell[];
}

export type IssueLevel = "error" | "warning" | "info";

export interface ImportIssue {
  sheet: string;
  row: number | null;
  level: IssueLevel;
  code:
    | "no_header"
    | "missing_code"
    | "missing_name"
    | "duplicate_in_sheet"
    | "duplicate_across_sheets"
    | "code_prefix_mixed"
    | "code_has_space"
    | "serial_gap"
    | "rate_missing"
    | "rate_not_number"
    | "header_repeated"
    | "identity_mismatch"
    | "rate_basis_unconfirmed"
    | "no_rules"
    | "summary_ignored";
  message: string;
}

export interface MasterRow {
  sheet: string;
  /** spreadsheet row number (1-based), for pointing the admin at the cell */
  row: number;
  serial: number | null;
  employeeCode: string | null;
  fullName: string | null;
  department: string | null;
  designation: string | null;
  rateAmount: number | null;
}

export interface ContractorRulesText {
  /** e.g. "Shukla Contractor" */
  label: string;
  /** the sheet this block refers to, matched by name */
  sheet: string | null;
  lines: string[];
  standardHours: number | null;
  overtimeDayHours: number | null;
  overtimeNightHours: number | null;
  commissionEnabled: boolean | null;
  commissionPercent: number | null;
  commissionScope: "all" | "selected" | null;
  /** "daily" when the text says "per day"; null when it does not say */
  rateBasis: "daily" | null;
  rateAmount: number | null;
  rateVaries: boolean;
}

export interface MasterSheet {
  name: string;
  /** first heading line, normally the contractor's own name */
  heading: string | null;
  /** e.g. "SEP-2026" */
  period: string | null;
  /** first day of that month, "2026-09-01" */
  periodStart: string | null;
  headerRow: number;
  rateHeader: string | null;
  rows: MasterRow[];
  /** rows with an employee ID and a name */
  validRows: number;
  rules: ContractorRulesText | null;
  suggestedBasis: RateBasis;
  basisReasons: string[];
  identityMismatch: boolean;
}

export interface ParsedMaster {
  sheets: MasterSheet[];
  rules: ContractorRulesText[];
  /** sheets that are neither worker lists nor the Rules sheet */
  ignoredSheets: string[];
  issues: ImportIssue[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const text = (v: CellValue | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.trim() === "" ? null : s;
};
/** Single-line label for matching headers: "Gross \nSalary" → "gross salary". */
const label = (v: CellValue | undefined) => (text(v) ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const clean = (v: CellValue | undefined) => {
  const s = text(v);
  return s === null ? null : s.replace(/\s+/g, " ").trim();
};

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/** "WAGES SHEET FOR THE MONTH OF SEP-2026" (also "0F" typed with a zero) → SEP-2026 / 2026-09-01 */
export function parsePeriod(line: string | null): { period: string; start: string } | null {
  if (!line) return null;
  const m = /MONTH\s+[O0]F\s+([A-Z]{3})[A-Z]*[\s\-/]*(\d{4})/i.exec(line);
  if (!m) return null;
  const month = MONTHS[m[1].toUpperCase()];
  if (!month) return null;
  return { period: `${m[1].toUpperCase()}-${m[2]}`, start: `${m[2]}-${String(month).padStart(2, "0")}-01` };
}

type Column = "serial" | "code" | "name" | "department" | "designation" | "rate";

function classifyHeader(h: string): Column | null {
  if (/^s\.?\s*no\.?$|^sr\.?\s*no\.?$|^serial/.test(h)) return "serial";
  if (/(emp|employee)\.?\s*(id|code|no)/.test(h)) return "code";
  if (/(employee|worker)?\s*name$/.test(h)) return "name";
  if (/^department$|^dept\.?$/.test(h)) return "department";
  if (/designation|position|post$/.test(h)) return "designation";
  if (/salary|rate|wage/.test(h)) return "rate";
  return null;
}

/** Splits an ID into its letter prefix and number, e.g. "0F 8003" → ["0F ", "8003"]. */
const codePrefix = (code: string) => /^(.*?)(\d{3,})$/.exec(code)?.[1] ?? null;

/**
 * IDs that differ only by case, spaces/dashes, or letter O vs digit 0 compare
 * equal here. Used to warn about likely typos — never to merge records.
 */
export const looseCode = (code: string) => code.toUpperCase().replace(/[\s\-_.]/g, "").replace(/O/g, "0");

export function parseRulesSheet(grid: SheetGrid, sheetNames: string[]): ContractorRulesText[] {
  const lines = [...grid.cells].sort((a, b) => a.row - b.row || a.col - b.col).map((c) => clean(c.value)).filter((s): s is string => !!s);
  const blocks: ContractorRulesText[] = [];
  let cur: ContractorRulesText | null = null;
  for (const line of lines) {
    if (/contractor\s*$/i.test(line) && !/[-:]/.test(line)) {
      const word = line.replace(/contractor\s*$/i, "").trim().toLowerCase();
      cur = {
        label: line,
        sheet: sheetNames.find((s) => s.trim().toLowerCase() === word) ?? null,
        lines: [],
        standardHours: null,
        overtimeDayHours: null,
        overtimeNightHours: null,
        commissionEnabled: null,
        commissionPercent: null,
        commissionScope: null,
        rateBasis: null,
        rateAmount: null,
        rateVaries: false,
      };
      blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.lines.push(line);
    const l = line.toLowerCase();
    const num = (s: string) => Number(s);
    if (/^working hours/.test(l)) {
      const m = /(\d+(?:\.\d+)?)/.exec(l);
      if (m) cur.standardHours = num(m[1]);
    } else if (/^ot\b/.test(l)) {
      const both = /(\d+(?:\.\d+)?)\s*hours?\s*for\s*both/.exec(l);
      const day = /(\d+(?:\.\d+)?)\s*hours?\s*for\s*day/.exec(l);
      const night = /(\d+(?:\.\d+)?)\s*hours?\s*for\s*night/.exec(l);
      if (both) cur.overtimeDayHours = cur.overtimeNightHours = num(both[1]);
      if (day) cur.overtimeDayHours = num(day[1]);
      if (night) cur.overtimeNightHours = num(night[1]);
    } else if (/^commission/.test(l)) {
      const after = l.replace(/^commission[^-:]*[-:]\s*/, "");
      cur.commissionEnabled = /^yes/.test(after) ? true : /^no\b/.test(after) ? false : null;
      const pct = /(\d+(?:\.\d+)?)\s*%/.exec(after);
      cur.commissionPercent = pct ? num(pct[1]) : null;
      cur.commissionScope = !cur.commissionEnabled ? null : /some|selected|few|only/.test(after) ? "selected" : /each|all|every/.test(after) ? "all" : null;
    } else if (/^rate of wages/.test(l)) {
      if (/per\s*day/.test(l)) cur.rateBasis = "daily";
      const amount = /(\d[\d,]*(?:\.\d+)?)\s*\/?-?\s*$/.exec(l);
      if (amount) cur.rateAmount = num(amount[1].replace(/,/g, ""));
      cur.rateVaries = /differ|vary|varies|according to/.test(l);
    }
  }
  return blocks;
}

function findHeaderRow(byRow: Map<number, Map<number, CellValue>>): number | null {
  for (const [row, cols] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const kinds = new Set([...cols.values()].map((v) => classifyHeader(label(v))));
    if (kinds.has("code") && kinds.has("name")) return row;
    if (row > 30) break;
  }
  return null;
}

export function parseWorkerSheet(grid: SheetGrid, rules: ContractorRulesText | null, issues: ImportIssue[]): MasterSheet | null {
  const byRow = new Map<number, Map<number, CellValue>>();
  const formulaCells = new Set<string>();
  for (const c of grid.cells) {
    if (!byRow.has(c.row)) byRow.set(c.row, new Map());
    byRow.get(c.row)!.set(c.col, c.value);
    if (c.formula) formulaCells.add(`${c.row}:${c.col}`);
  }
  const headerRow = findHeaderRow(byRow);
  if (headerRow === null) return null;
  const sheet = grid.name;
  const issue = (row: number | null, level: IssueLevel, code: ImportIssue["code"], message: string) => issues.push({ sheet, row, level, code, message });

  // Column map. A second "Department" heading is the designation column (the
  // Optimum, Sumit and Excellent sheets head both D and E "Department").
  const cols: Partial<Record<Column, number>> = {};
  let rateHeader: string | null = null;
  for (const [col, v] of [...byRow.get(headerRow)!.entries()].sort((a, b) => a[0] - b[0])) {
    let kind = classifyHeader(label(v));
    if (kind === "department" && cols.department !== undefined && cols.designation === undefined) {
      kind = "designation";
      issue(headerRow, "info", "header_repeated", `Two columns are headed "Department"; the second (column ${String.fromCharCode(64 + col)}) is read as Designation.`);
    }
    if (kind && cols[kind] === undefined) {
      cols[kind] = col;
      if (kind === "rate") rateHeader = clean(v);
    }
  }

  // Heading lines above the header: contractor name first, then the month line.
  const above = [...byRow.entries()]
    .filter(([r]) => r < headerRow)
    .sort((a, b) => a[0] - b[0])
    .map(([r, c]) => ({ r, first: clean(c.get(Math.min(...c.keys()))) }));
  const heading = above.find((a) => a.first && !parsePeriod(a.first))?.first ?? null;
  const periodLine = above.map((a) => a.first).find((f) => !!parsePeriod(f)) ?? null;
  const period = parsePeriod(periodLine);

  const rows: MasterRow[] = [];
  for (const [r, c] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    if (r <= headerRow) continue;
    const get = (k: Column) => (cols[k] === undefined ? undefined : c.get(cols[k]!));
    const rawCode = get("code");
    const employeeCode = rawCode === null || rawCode === undefined ? null : typeof rawCode === "number" ? String(rawCode) : text(rawCode)?.trim() ?? null;
    const fullName = clean(get("name"));
    if (!employeeCode && !fullName) {
      // Totals and other summary cells below the list.
      if ([...c.keys()].some((k) => formulaCells.has(`${r}:${k}`))) issue(r, "info", "summary_ignored", `Row ${r} holds only a total or formula and is ignored.`);
      continue;
    }
    const serialRaw = get("serial");
    const serial = typeof serialRaw === "number" ? serialRaw : serialRaw && /^\d+$/.test(String(serialRaw).trim()) ? Number(String(serialRaw).trim()) : null;
    const rateRaw = get("rate");
    let rateAmount: number | null = null;
    if (typeof rateRaw === "number") rateAmount = rateRaw;
    else if (rateRaw !== null && rateRaw !== undefined && text(rateRaw)) {
      const n = Number(String(rateRaw).replace(/[,₹\s]/g, ""));
      if (Number.isFinite(n)) rateAmount = n;
      else issue(r, "warning", "rate_not_number", `Row ${r}: the ${rateHeader ?? "rate"} "${String(rateRaw)}" is not a number; imported without a rate.`);
    }
    rows.push({ sheet, row: r, serial, employeeCode, fullName, department: clean(get("department")), designation: clean(get("designation")), rateAmount });
  }

  // Row-level checks.
  const seen = new Map<string, MasterRow[]>();
  for (const row of rows) {
    if (!row.employeeCode) issue(row.row, "error", "missing_code", `Row ${row.row}: ${row.fullName ?? "this worker"} has no employee ID. Not imported — add the ID in the sheet and import again.`);
    else if (!row.fullName) issue(row.row, "error", "missing_name", `Row ${row.row}: employee ID ${row.employeeCode} has no name. Not imported.`);
    if (row.employeeCode && row.fullName && row.rateAmount === null && !issues.some((i) => i.sheet === sheet && i.row === row.row && i.code === "rate_not_number"))
      issue(row.row, "warning", "rate_missing", `Row ${row.row}: ${row.fullName} (${row.employeeCode}) has no ${rateHeader ?? "rate"}.`);
    if (row.employeeCode) seen.set(row.employeeCode, [...(seen.get(row.employeeCode) ?? []), row]);
    if (row.employeeCode && /\s/.test(row.employeeCode))
      issue(row.row, "info", "code_has_space", `Row ${row.row}: employee ID "${row.employeeCode}" contains a space. Kept exactly as written.`);
  }
  for (const [code, list] of seen) {
    if (list.length < 2) continue;
    for (const row of list)
      issue(row.row, "error", "duplicate_in_sheet", `Employee ID ${code} appears ${list.length} times in this sheet (rows ${list.map((x) => x.row).join(", ")}). None of these rows is imported until it is fixed.`);
  }

  // The same series written with different prefixes ("0F 8003", "0F8008", "OF8032").
  const prefixes = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const p = row.employeeCode ? codePrefix(row.employeeCode) : null;
    if (p === null) continue;
    const key = looseCode(p);
    if (!prefixes.has(key)) prefixes.set(key, new Map());
    prefixes.get(key)!.set(p, (prefixes.get(key)!.get(p) ?? 0) + 1);
  }
  for (const variants of prefixes.values()) {
    if (variants.size < 2) continue;
    const list = [...variants.entries()].map(([p, n]) => `"${p}" ×${n}`).join(", ");
    issue(null, "warning", "code_prefix_mixed", `Employee IDs here start with ${list} (digit 0, letter O and spaces differ). They are kept exactly as written; check them against the contractor's ID cards.`);
  }

  // S.No gaps can mean a deleted row.
  const serials = rows.map((r) => r.serial).filter((s): s is number => s !== null).sort((a, b) => a - b);
  for (let i = 1; i < serials.length; i++) {
    for (let missing = serials[i - 1] + 1; missing < serials[i]; missing++)
      issue(null, "info", "serial_gap", `S.No ${missing} is missing (the list goes from ${serials[i - 1]} to ${serials[i]}).`);
  }

  // Rate basis evidence. Never "monthly" on a guess: that needs an admin.
  const reasons: string[] = [];
  let suggestedBasis: RateBasis = "unconfirmed";
  const amounts = rows.map((r) => r.rateAmount).filter((n): n is number => n !== null);
  if (rateHeader && /day\s*rate|per\s*day|daily/i.test(rateHeader)) {
    suggestedBasis = "daily";
    reasons.push(`The amount column is headed "${rateHeader}".`);
  }
  if (rules?.rateBasis === "daily") {
    suggestedBasis = "daily";
    reasons.push(`The Rules sheet says: "${rules.lines.find((l) => /^rate of wages/i.test(l)) ?? "per day"}".`);
    if (rateHeader && /salary/i.test(rateHeader)) reasons.push(`The column itself is headed "${rateHeader}", but the Rules sheet is more specific.`);
  }
  if (amounts.length > 0) {
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    const range = min === max ? `₹${min.toLocaleString("en-IN")}` : `₹${min.toLocaleString("en-IN")}–₹${max.toLocaleString("en-IN")}`;
    if (suggestedBasis === "unconfirmed") {
      reasons.push(
        `The column is headed "${rateHeader ?? "rate"}" with amounts of ${range}${min >= 5000 ? ", which look like monthly salaries" : ""}, but nothing in the workbook states the basis.`,
      );
      if (rules && rules.rateBasis === null) reasons.push(`The Rules sheet only says: "${rules.lines.find((l) => /^rate of wages/i.test(l)) ?? "—"}".`);
    } else if (min >= 5000) {
      reasons.push(`Amounts of ${range} look high for a daily rate. Check before confirming.`);
    }
  }
  if (suggestedBasis === "unconfirmed")
    issue(null, "warning", "rate_basis_unconfirmed", `The rate basis (monthly, daily or hourly) is not stated. Rates are imported as recorded and marked "Requires verification" until an admin confirms the basis.`);
  if (!rules) issue(null, "info", "no_rules", `No block for this contractor was found on the Rules sheet.`);

  // Contractor identity: the sheet name should appear in its heading.
  const words = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const identityMismatch = !!heading && !words(sheet).some((w) => words(heading).includes(w));
  if (identityMismatch)
    issue(
      null,
      "warning",
      "identity_mismatch",
      `The sheet is named "${sheet}" but its heading says "${heading}". Confirm they are the same contractor; until then it is marked "Needs review". Nothing is merged automatically.`,
    );

  return {
    name: sheet,
    heading,
    period: period?.period ?? null,
    periodStart: period?.start ?? null,
    headerRow,
    rateHeader,
    rows,
    validRows: rows.filter((r) => r.employeeCode && r.fullName).length,
    rules,
    suggestedBasis,
    basisReasons: reasons,
    identityMismatch,
  };
}

export function parseMaster(grids: SheetGrid[]): ParsedMaster {
  const issues: ImportIssue[] = [];
  const names = grids.map((g) => g.name);
  const rulesGrid = grids.find((g) => /^rules?$/i.test(g.name.trim()));
  const rules = rulesGrid ? parseRulesSheet(rulesGrid, names) : [];
  const sheets: MasterSheet[] = [];
  const ignoredSheets: string[] = [];
  for (const g of grids) {
    if (g === rulesGrid) continue;
    const parsed = parseWorkerSheet(g, rules.find((r) => r.sheet === g.name) ?? null, issues);
    if (parsed) sheets.push(parsed);
    else if (g.cells.length > 0) {
      ignoredSheets.push(g.name);
      issues.push({ sheet: g.name, row: null, level: "info", code: "no_header", message: `No "Emp ID" and "Employee Name" header found; this sheet is not imported.` });
    } else ignoredSheets.push(g.name);
  }

  // The same ID in two sheets cannot be resolved automatically.
  const owner = new Map<string, MasterRow[]>();
  for (const s of sheets) for (const r of s.rows) if (r.employeeCode) owner.set(r.employeeCode, [...(owner.get(r.employeeCode) ?? []), r]);
  for (const [code, list] of owner) {
    const sheetsWith = new Set(list.map((r) => r.sheet));
    if (sheetsWith.size < 2) continue;
    for (const r of list)
      issues.push({
        sheet: r.sheet,
        row: r.row,
        level: "error",
        code: "duplicate_across_sheets",
        message: `Employee ID ${code} is also in ${[...sheetsWith].filter((s) => s !== r.sheet).join(", ")}. Not imported until it is fixed.`,
      });
  }
  return { sheets, rules, ignoredSheets, issues };
}

// ---------------------------------------------------------------------------
// Planning against what is already stored
// ---------------------------------------------------------------------------

export interface SheetChoice {
  sheet: string;
  include: boolean;
  /** an existing contractor, or null to create one */
  contractorId: string | null;
  /** name for a new contractor */
  newContractorName: string;
  /** the admin confirmed the contractor identity (needed when the heading does not match) */
  identityConfirmed: boolean;
  rateBasis: RateBasis;
  /** pay terms for this import apply from this date */
  effectiveFrom: string;
}

export interface FieldChange {
  field: "fullName" | "department" | "designation" | "rateAmount" | "rateBasis";
  from: string | number | null;
  to: string | number | null;
}

export type RowPlan =
  | { kind: "create" }
  | {
      kind: "update";
      workerId: string;
      workerCode: string;
      changes: FieldChange[];
      approved: boolean;
      newPayTerms: boolean;
      /** what the worker looked like when planned: the apply refuses if it changed since */
      expected: WorkerSnapshot;
    }
  | { kind: "unchanged"; workerId: string; workerCode: string }
  | { kind: "skip"; reason: string };

/** A stored worker's current values, checked again when an import is applied. */
export interface WorkerSnapshot {
  fullName: string;
  department: string | null;
  designation: string | null;
  /** latest pay terms version (0 = none) */
  termsVersion: number;
}

export interface PlannedRow extends MasterRow {
  key: string;
  plan: RowPlan;
}

export interface PlannedSheet {
  sheet: string;
  include: boolean;
  contractor: {
    id: string | null;
    name: string;
    legalName: string | null;
    create: boolean;
    identityStatus: ContractorIdentityStatus;
    identityNote: string | null;
  };
  rateBasis: RateBasis;
  effectiveFrom: string;
  counts: { rows: number; create: number; update: number; updateApproved: number; unchanged: number; skip: number };
}

export interface MasterImportPlan {
  sheets: PlannedSheet[];
  rows: PlannedRow[];
  /** stored workers of the mapped contractors that are not in the file (shown, never changed) */
  notInFile: { workerId: string; workerCode: string; employeeCode: string | null; fullName: string; contractorName: string }[];
  totals: { rows: number; create: number; update: number; updateApproved: number; unchanged: number; skip: number };
  /** changes whenever anything the apply step would write changes */
  fingerprint: string;
}

export interface ExistingMaster {
  contractors: Contractor[];
  workers: Worker[];
  payTerms: WorkerPayTerms[];
}

export const rowKey = (r: { sheet: string; row: number }) => `${r.sheet}!${r.row}`;

export function latestPayTerms(terms: WorkerPayTerms[], workerId: string, onDate?: string): WorkerPayTerms | null {
  let best: WorkerPayTerms | null = null;
  for (const t of terms) {
    if (t.workerId !== workerId || (onDate && t.effectiveFrom > onDate)) continue;
    if (!best || t.effectiveFrom > best.effectiveFrom || (t.effectiveFrom === best.effectiveFrom && t.version > best.version)) best = t;
  }
  return best;
}

/** Suggests the stored contractor a sheet belongs to: an earlier import of the same heading or name. */
export function suggestContractor(sheet: MasterSheet, contractors: Contractor[]): Contractor | null {
  const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return (
    (sheet.heading ? contractors.find((c) => norm(c.legalName) === norm(sheet.heading)) : undefined) ??
    contractors.find((c) => norm(c.name) === norm(sheet.name)) ??
    null
  );
}

export function defaultChoices(parsed: ParsedMaster, contractors: Contractor[], today: string): SheetChoice[] {
  return parsed.sheets.map((s) => {
    const existing = suggestContractor(s, contractors);
    return {
      sheet: s.name,
      include: s.validRows > 0,
      contractorId: existing?.id ?? null,
      newContractorName: s.name,
      identityConfirmed: false,
      rateBasis: s.suggestedBasis,
      effectiveFrom: s.periodStart ?? today,
    };
  });
}

/** 32-bit FNV-1a, hex. Only used to notice that a plan changed between preview and apply. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function planMasterImport(
  parsed: ParsedMaster,
  existing: ExistingMaster,
  choices: SheetChoice[],
  approvedChanges: ReadonlySet<string> | "all",
): MasterImportPlan {
  const contractorsById = new Map(existing.contractors.map((c) => [c.id, c]));
  const errorRows = new Set(parsed.issues.filter((i) => i.level === "error" && i.row !== null).map((i) => `${i.sheet}!${i.row}`));
  const plannedSheets: PlannedSheet[] = [];
  const rows: PlannedRow[] = [];
  const notInFile: MasterImportPlan["notInFile"] = [];

  for (const sheet of parsed.sheets) {
    const choice = choices.find((c) => c.sheet === sheet.name);
    const include = !!choice?.include;
    const target = choice?.contractorId ? contractorsById.get(choice.contractorId) ?? null : null;
    // An existing contractor is never changed by an import; a new one records the
    // sheet heading as its legal name and stays "Needs review" when they disagree.
    const contractor: PlannedSheet["contractor"] = target
      ? { id: target.id, name: target.name, legalName: target.legalName, create: false, identityStatus: target.identityStatus, identityNote: target.identityNote }
      : {
          id: null,
          name: choice?.newContractorName.trim() || sheet.name,
          legalName: sheet.heading,
          create: true,
          identityStatus: sheet.identityMismatch && !choice?.identityConfirmed ? "needs_review" : "confirmed",
          identityNote: sheet.identityMismatch
            ? `Wage sheet "${sheet.name}" is headed "${sheet.heading}".${choice?.identityConfirmed ? " Confirmed as the same contractor by the admin at import." : " Confirm this is the same contractor."}`
            : null,
        };
    const rateBasis = choice?.rateBasis ?? sheet.suggestedBasis;
    const effectiveFrom = choice?.effectiveFrom ?? sheet.periodStart ?? "";
    const counts = { rows: sheet.rows.length, create: 0, update: 0, updateApproved: 0, unchanged: 0, skip: 0 };

    const stored = target ? existing.workers.filter((w) => w.contractorId === target.id) : [];
    const byCode = new Map(stored.filter((w) => w.employeeCode).map((w) => [w.employeeCode!, w]));
    const byLoose = new Map(stored.filter((w) => w.employeeCode).map((w) => [looseCode(w.employeeCode!), w]));
    const elsewhere = new Map(existing.workers.filter((w) => w.employeeCode && w.contractorId !== target?.id).map((w) => [w.employeeCode!, w]));

    for (const r of sheet.rows) {
      const key = rowKey(r);
      let plan: RowPlan;
      if (!include) plan = { kind: "skip", reason: "Sheet not included" };
      else if (!r.employeeCode || !r.fullName || errorRows.has(key)) {
        plan = { kind: "skip", reason: !r.employeeCode ? "No employee ID" : !r.fullName ? "No name" : "Duplicate employee ID" };
      } else if (elsewhere.has(r.employeeCode)) {
        const w = elsewhere.get(r.employeeCode)!;
        plan = { kind: "skip", reason: `ID already belongs to ${w.fullName} (${w.code}) at ${contractorsById.get(w.contractorId)?.name ?? "another contractor"}` };
      } else if (byCode.has(r.employeeCode)) {
        const w = byCode.get(r.employeeCode)!;
        const terms = latestPayTerms(existing.payTerms, w.id);
        const changes: FieldChange[] = [];
        if (w.fullName !== r.fullName) changes.push({ field: "fullName", from: w.fullName, to: r.fullName });
        if ((w.department ?? null) !== r.department) changes.push({ field: "department", from: w.department, to: r.department });
        if ((w.designation ?? null) !== r.designation) changes.push({ field: "designation", from: w.designation, to: r.designation });
        if ((terms?.rateAmount ?? null) !== r.rateAmount) changes.push({ field: "rateAmount", from: terms?.rateAmount ?? null, to: r.rateAmount });
        if ((terms?.rateBasis ?? null) !== rateBasis) changes.push({ field: "rateBasis", from: terms?.rateBasis ?? null, to: rateBasis });
        const newPayTerms = changes.some((c) => c.field === "rateAmount" || c.field === "rateBasis");
        if (changes.length === 0) plan = { kind: "unchanged", workerId: w.id, workerCode: w.code };
        else if (newPayTerms && terms && effectiveFrom < terms.effectiveFrom)
          plan = { kind: "skip", reason: `Pay terms from ${terms.effectiveFrom} already exist; choose an effective date on or after it` };
        else {
          const approved = approvedChanges === "all" || approvedChanges.has(key);
          plan = {
            kind: "update", workerId: w.id, workerCode: w.code, changes, approved, newPayTerms,
            expected: { fullName: w.fullName, department: w.department ?? null, designation: w.designation ?? null, termsVersion: terms?.version ?? 0 },
          };
        }
      } else if (byLoose.has(looseCode(r.employeeCode))) {
        const w = byLoose.get(looseCode(r.employeeCode))!;
        plan = { kind: "skip", reason: `Looks like existing ID "${w.employeeCode}" (${w.fullName}); IDs differ only by spaces or O/0. Fix one of them first` };
      } else plan = { kind: "create" };

      if (plan.kind === "create") counts.create++;
      else if (plan.kind === "update") {
        counts.update++;
        if (plan.approved) counts.updateApproved++;
      } else if (plan.kind === "unchanged") counts.unchanged++;
      else counts.skip++;
      rows.push({ ...r, key, plan });
    }

    if (include && target) {
      const inFile = new Set(sheet.rows.map((r) => r.employeeCode).filter(Boolean));
      for (const w of stored) {
        if (w.isActive && (!w.employeeCode || !inFile.has(w.employeeCode)))
          notInFile.push({ workerId: w.id, workerCode: w.code, employeeCode: w.employeeCode, fullName: w.fullName, contractorName: target.name });
      }
    }
    plannedSheets.push({ sheet: sheet.name, include, contractor, rateBasis, effectiveFrom, counts });
  }

  const totals = { rows: 0, create: 0, update: 0, updateApproved: 0, unchanged: 0, skip: 0 };
  for (const s of plannedSheets) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += s.counts[k];

  const writes = {
    sheets: plannedSheets.filter((s) => s.include).map((s) => [s.sheet, s.contractor, s.rateBasis, s.effectiveFrom]),
    rows: rows
      .filter((r) => r.plan.kind === "create" || (r.plan.kind === "update" && r.plan.approved))
      .map((r) => [r.key, r.employeeCode, r.fullName, r.department, r.designation, r.rateAmount, r.plan.kind === "update" ? [r.plan.changes, r.plan.expected] : null]),
  };
  return { sheets: plannedSheets, rows, notInFile, totals, fingerprint: fnv1a(JSON.stringify(writes)) };
}

// ---------------------------------------------------------------------------
// What the store writes (one atomic call)
// ---------------------------------------------------------------------------

export interface MasterImportWrite {
  batch: {
    fileName: string;
    fileHash: string;
    summary: Record<string, unknown>;
    /** the newest worker-master import when this was planned; the apply refuses if another came since */
    expectedLastBatchId: string | null;
  };
  contractors: { ref: string; name: string; legalName: string | null; identityStatus: ContractorIdentityStatus; identityNote: string | null }[];
  creates: {
    /** a stored contractor id, or the ref of a contractor created in this call */
    contractor: { id: string } | { ref: string };
    employeeCode: string;
    fullName: string;
    department: string | null;
    designation: string | null;
    source: string;
    payTerms: { effectiveFrom: string; rateAmount: number | null; rateBasis: RateBasis; source: string };
  }[];
  updates: {
    workerId: string;
    expected: WorkerSnapshot;
    fields: { fullName: string; department: string | null; designation: string | null } | null;
    payTerms: { effectiveFrom: string; rateAmount: number | null; rateBasis: RateBasis; commissionEligible: boolean | null; source: string } | null;
  }[];
}

export function toImportWrite(
  plan: MasterImportPlan,
  existing: ExistingMaster,
  file: { name: string; hash: string; expectedLastBatchId: string | null },
  summary: Record<string, unknown>,
): MasterImportWrite {
  const sheets = new Map(plan.sheets.filter((s) => s.include).map((s) => [s.sheet, s]));
  const contractors: MasterImportWrite["contractors"] = [];
  for (const s of sheets.values()) {
    if (s.contractor.create)
      contractors.push({ ref: s.sheet, name: s.contractor.name, legalName: s.contractor.legalName, identityStatus: s.contractor.identityStatus, identityNote: s.contractor.identityNote });
  }
  const source = (r: PlannedRow) => `${file.name} · ${r.sheet} · row ${r.row}`;
  const creates: MasterImportWrite["creates"] = [];
  const updates: MasterImportWrite["updates"] = [];
  for (const r of plan.rows) {
    const s = sheets.get(r.sheet);
    if (!s) continue;
    if (r.plan.kind === "create") {
      creates.push({
        contractor: s.contractor.id ? { id: s.contractor.id } : { ref: s.sheet },
        employeeCode: r.employeeCode!,
        fullName: r.fullName!,
        department: r.department,
        designation: r.designation,
        source: source(r),
        payTerms: { effectiveFrom: s.effectiveFrom, rateAmount: r.rateAmount, rateBasis: s.rateBasis, source: source(r) },
      });
    } else if (r.plan.kind === "update" && r.plan.approved) {
      const fieldChange = r.plan.changes.some((c) => c.field === "fullName" || c.field === "department" || c.field === "designation");
      const prev = latestPayTerms(existing.payTerms, r.plan.workerId);
      updates.push({
        workerId: r.plan.workerId,
        expected: r.plan.expected,
        fields: fieldChange ? { fullName: r.fullName!, department: r.department, designation: r.designation } : null,
        payTerms: r.plan.newPayTerms
          ? { effectiveFrom: s.effectiveFrom, rateAmount: r.rateAmount, rateBasis: s.rateBasis, commissionEligible: prev?.commissionEligible ?? null, source: source(r) }
          : null,
      });
    }
  }
  return { batch: { fileName: file.name, fileHash: file.hash, summary, expectedLastBatchId: file.expectedLastBatchId }, contractors, creates, updates };
}

export const RATE_BASIS_LABEL: Record<RateBasis, string> = {
  monthly: "Monthly",
  daily: "Daily",
  hourly: "Hourly",
  unconfirmed: "Requires verification",
};
