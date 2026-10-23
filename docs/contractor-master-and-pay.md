# Contractor master data, payment rules, shifts and payroll

## Worker master import (Workers → Import from Excel)

Upload the contractor master workbook (`.xlsx`, one sheet per contractor). The app reads it, shows a preview, and saves nothing until **Import** is pressed.

- **Layout handled**: a heading line (the contractor's own name), a "WAGES SHEET FOR THE MONTH OF …" line (also typed "0F"), a header merged over two rows, workers on every other row with cells merged over the blank row below, a second column headed "Department" (read as Designation), and formula totals (ignored).
- **Employee IDs are kept exactly**, including inner spaces, leading zeros, and letter O vs digit 0 (`0F 8003`, `0F8008`, `OF8032`). Mixed prefixes are flagged for checking, never "fixed".
- **Not imported, and listed**: rows without an employee ID or a name, IDs repeated in a sheet or across sheets, IDs that already belong to another contractor, and IDs that differ from an existing one only by spaces or O/0.
- **No plant is inferred.** Imported workers are *Unassigned*. Use Workers → Unassigned → Assign to plant, which can also add the contractor to that plant.
- **Re-import is safe**: the same file is recognised (SHA-256). Existing workers are matched by contractor and employee ID. Changes (name, department, rate…) apply only when ticked, and a changed rate becomes a new pay version. Workers missing from the file are listed, never deactivated.
- **Contractor identity**: a sheet whose heading names someone else is flagged. *Excellent* is headed *GAJENDRA RANA CONTRACTORS*, so it is created as **Needs review** unless the admin ticks the confirmation. Nothing is merged. Confirm later on the contractor page.
- **Rates**: the amount is stored as written. The basis (monthly / daily / hourly) is chosen by the admin and stays **Requires verification** without evidence. The Rules sheet says "per day" for Sumit, Excellent and Optimum, and Excellent's column is headed "Day Rate". *Shukla* has no such statement and salary-like amounts, so it stays unconfirmed.
- The **Rules sheet** text is saved with the import and offered on the contractor's payment rule form ("Fill in what this states"). It is never applied automatically.
- Applying is one atomic database call (`admin_import_worker_master`). If the data changed since the preview, nothing is written.
- Real worker data is never committed: tests use a synthetic workbook, and the real-file check only runs when `MASTER_XLSX` points at a local copy.

## Payment rules (Contractors → contractor → Payment rules)

Each version may set:

- the rate source: one contractor rate, or each worker's own rate from their pay terms;
- standard hours, unpaid break, and how short days are paid (pro rata, half day above a minimum, or full day);
- days per month for monthly salaries;
- overtime thresholds for the day shift and the night shift; overtime pay as a fixed ₹/hour or a multiplier; rounding; a minimum;
- commission: percentage, all or selected workers, what it is calculated on (base wages, or base plus overtime), and whether it is added on top of wages or taken from them.

Anything left empty means "not decided". Days that need it show **Needs configuration** with the missing settings named, and totals that depend on them are not shown. Rules saved before these settings existed keep their original meaning (`rule_format = 1`).

The business rules as given, and what is still open:

| Contractor | Standard | OT after (day / night) | Commission | Still to decide |
| --- | --- | --- | --- | --- |
| Shukla | 8 h | 8 / 8 h | 8 %, all | rate basis (salary?), days per month, OT pay, rounding, commission base and treatment, short days |
| Sumit | 8 h | 8 / 8 h | 7.5 %, selected workers | which workers, OT pay, rounding, commission base and treatment, short days |
| Excellent | 8 h | 8.5 / 8 h | none | identity confirmation, OT pay, rounding, short days |
| Optimum | 8 h | 8.5 / 8 h | 7.5 %, all | OT pay, rounding, commission base and treatment, short days |

Worker rates and commission eligibility are in the **Worker rates** table under each contractor's payment rules. Every change is a dated version.

## Day and night shifts

The register has a Day / Night switch. A worker has one record per plant and day, and the record carries its shift. A night shift uses the plant's night suggested IN (Settings → plant → "Suggested IN time (night shift)"), and its OUT may always be the next morning. Overtime uses the shift's threshold. To record a night shift's OUT the next morning, operators need one past day of editing (Settings → "Operators may edit").

## Payroll (Attendance → Payroll)

Contractor-wise for a month: workers, confirmed hours, standard units, OT hours, base wages, OT wages, commission, and estimated total, with a drill-down to each worker (rate, rule versions, flags) and an Excel export. Pending days are never counted. Days without an OUT time are excluded and flagged. A total is shown as complete only when nothing is missing.
