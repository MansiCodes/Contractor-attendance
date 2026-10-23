import ExcelJS from "exceljs";

// A synthetic workbook shaped like the real contractor master: a heading, a month
// line, a header merged over two rows, workers on every other row with cells
// merged over the blank row below, a repeated "Department" heading, formula
// totals, and a Rules sheet. All names and IDs are fictional.

export type Row = [number | string | null, string | null, string | null, string | null, string | null, number | string | null];

export async function workbook(sheets: { name: string; heading: string; month: string; rateHeader: string; rows: Row[]; secondDept?: boolean }[], rules?: string[]) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.getCell("A1").value = s.heading;
    ws.getCell("F1").value = { formula: 'COUNTIF(F6:F99,"P")', result: 0 };
    ws.getCell("A2").value = s.month;
    ws.getCell("F2").value = { formula: "SUM(F6:F99)", result: 1234 };
    ["S.No", "Emp id", "Employee Name", "Department ", s.secondDept ? "Department " : "Designation", s.rateHeader].forEach((h, i) => {
      ws.getCell(3, i + 1).value = h;
    });
    ws.mergeCells("F3:F4");
    let r = 6;
    for (const row of s.rows) {
      row.forEach((v, i) => {
        if (v !== null) ws.getCell(r, i + 1).value = v;
      });
      ws.mergeCells(r, 3, r + 1, 3); // name merged over the blank row below
      r += 2;
    }
    ws.getCell(r + 1, 6).value = { formula: `SUM(F6:F${r})`, result: 999 };
  }
  if (rules) {
    const ws = wb.addWorksheet("Rules");
    rules.forEach((line, i) => (ws.getCell(i + 1, 1).value = line));
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export const RULES = [
  "Alpha Contractor",
  "Working hours- 8 ",
  "OT- according to 8 hours for both day & night",
  "Commission applicability- Yes, 8% for each employee",
  "Rate of wages- differ according to position ",
  "",
  "Beta Contractor",
  "Working hours- 8 ",
  "OT- according to 8.5 hours for day & 8 hours for night",
  "Commission applicability- Yes only for some employees, 7.5%",
  "Rate of wages per day- 480/-",
  "",
  "Gamma Contractor",
  "Working hours- 8",
  "OT- according to 8.5 hours for day & 8 hours for night",
  "Commission applicability- No",
  "Rate of wages per day- 480/-",
];

/** The synthetic master used by the import tests. */
export function buildMasterWorkbook(): Promise<Uint8Array> {
  return workbook(
    [
      {
        name: "Alpha",
        heading: "ALPHA KUMAR LABOUR SUPPLY",
        month: "WAGES SHEET  FOR THE MONTH OF SEP-2026",
        rateHeader: "Gross \nSalary",
        rows: [
          [1, "AL1001", "TEST WORKER ONE", "PRODUCTION", "OPERATOR", 21000],
          [2, "AL1002", "TEST WORKER TWO ", "PRODUCTION", "HELPER ", 12500],
          [4, "AL1004", "TEST WORKER FOUR", "MAINTENANCE", "FITTER", 23800],
        ],
      },
      {
        name: "Beta",
        heading: "BETA MANPOWER SEVVICES",
        month: "WAGES SHEET  FOR THE MONTH 0F SEP-2026",
        rateHeader: "Gross \nSalary",
        secondDept: true,
        rows: [
          [1, "0F 8003", "BETA ONE", "PRODUCTION", "HELPER", 480],
          [2, "0F8008", "BETA TWO", "PRODUCTION", "HELPER", 480],
          [3, "OF8032", "BETA THREE", "PRODUCTION", "HELPER", 480],
          [4, "OF8033", "BETA FOUR", "PRODUCTION", "HELPER", 480],
          [5, "OF8033", "BETA FOUR AGAIN", "PRODUCTION", "HELPER", 480],
          [6, null, "BETA NO CODE", "PRODUCTION", "HELPER", 480],
        ],
      },
      {
        name: "Gamma",
        heading: "DELTA SINGH CONTRACTORS",
        month: "WAGES SHEET  FOR THE MONTH OF SEP-2026",
        rateHeader: "Day Rate",
        secondDept: true,
        rows: [
          [1, "GM3001", "GAMMA ONE", "PRODUCTION", "HELPER", 480],
          [2, "GM3002", "GAMMA TWO", "PRODUCTION", "HELPER", 520],
          [3, "AL1004", "GAMMA SAME ID AS ALPHA", "PRODUCTION", "HELPER", 480],
        ],
      },
    ],
    RULES,
  );
}

