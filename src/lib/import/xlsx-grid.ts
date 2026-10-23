import ExcelJS from "exceljs";
import type { CellValue, GridCell, SheetGrid } from "@/lib/domain/master-import";

// Reads an uploaded .xlsx into plain grids for the pure import parsers.
// - Merged ranges keep their value in the top-left cell only; the other cells of
//   the range ("slaves") are dropped so a merged value is never read twice.
// - Formula cells give their last calculated result and are marked as formulas.
// - Text is returned as typed: nothing is trimmed or re-cased here.

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** A whole number shown with a zero-padded format (e.g. 000123) keeps its zeros. */
const padded = (v: unknown, numFmt: string | undefined): CellValue =>
  typeof v === "number" && Number.isInteger(v) && /^0+$/.test(numFmt ?? "") ? String(v).padStart(numFmt!.length, "0") : (v as CellValue);

function plainValue(cell: ExcelJS.Cell): { value: CellValue; formula: boolean } {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return { value: null, formula: false };
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return { value: padded(v, cell.numFmt), formula: false };
  if (v instanceof Date) return { value: v.toISOString().slice(0, 10), formula: false };
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("formula" in o || "sharedFormula" in o) {
      const r = o.result as unknown;
      const value = r === null || r === undefined || typeof r === "object" ? null : padded(r, cell.numFmt);
      return { value, formula: true };
    }
    if (Array.isArray(o.richText)) return { value: (o.richText as { text: string }[]).map((t) => t.text).join(""), formula: false };
    if (typeof o.text === "string") return { value: o.text, formula: false };
    if ("error" in o) return { value: null, formula: false };
  }
  return { value: String(v), formula: false };
}

export async function readWorkbookGrids(bytes: Uint8Array): Promise<SheetGrid[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new Error("This file could not be read as an Excel workbook (.xlsx).");
  }
  const grids: SheetGrid[] = [];
  wb.eachSheet((ws) => {
    const cells: GridCell[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (cell.isMerged && cell.master && cell.master.address !== cell.address) return;
        const { value, formula } = plainValue(cell);
        if (value === null && !formula) return;
        cells.push({ row: rowNumber, col: colNumber, value, ...(formula ? { formula } : {}) });
      });
    });
    grids.push({ name: ws.name, cells });
  });
  return grids;
}
