# Attendance settings — design

Status: implemented; revised after the Codex architecture/security review and the implementation review (2026-10-21). Adapted to manufacturing plants and given a plant break setting (migration `20261023000001_manufacturing_plants`). Nothing here is applied to any real database. Migrations run only in PGlite (`npm run test:db`) until the owner approves a live migration.

## Why

The 09:00 suggested IN time and the IN +60 min / OUT +5 min future-time limits were examples hardcoded in several places (schema default, Zod default, project dialog, register fallback, service constants, SQL RPC). They are not approved business rules. Admins need company-wide defaults with optional per-site overrides, enforced on the server and in the database.

## Owner decisions (2026-10-21)

1. Company fallback values: no suggested IN; shift start/end unset; new-site timezone Asia/Kolkata; IN tolerance 60 min; OUT tolerance 5 min; late grace, half-day, overtime unset (no labels); operator past days 0; cutoff = end of the last editable day; overnight off; auto-absent off.
2. An operator may accept a suggested IN time, but the record is flagged `check_in_source = 'suggested'` and this is shown in reports, export and the change log.
3. Half-day and overtime in attendance settings are **labels only**. Pay still comes from the versioned contractor payment rules (`calc.ts`), unchanged.
4. Late = IN after shift start + grace. Label only, no pay effect.
5. Cutoff: operators may edit work date D until `cutoff_time` (site-local) on day D + N, where N = operator past days. No cutoff = end of that day (current behaviour).
6. Auto-absent (off by default) is report-only: workers still pending after the operator window for D has closed are shown as "Absent – not marked". No records are written, no scheduled job.
7. Admins keep unlimited past-date corrections (≤ site today), all audited.

## Data model

### `attendance_policies` (new, append-only, versioned)

One company scope (`project_id is null`) and optional per-site scopes. Each row is a version with `effective_from`. Rows are never updated or deleted (trigger). `version` is assigned per scope by a trigger under a per-scope advisory lock (company key `attendance_policy:company`), with NULL-safe scope matching and a unique index on `(coalesce(project_id, zero-uuid), version)`. `created_by` is always `auth.uid()`; callers cannot supply it.

Columns: `suggested_check_in`, `shift_start`, `shift_end` (time); `allow_overnight`, `auto_absent_enabled` (boolean); `in_future_tolerance_min` (0–240), `out_future_tolerance_min` (0–60), `late_grace_min` (0–240), `overtime_min_minutes` (0–240), `operator_backdate_days` (0–7) (smallint); `half_day_below_hours`, `overtime_after_hours` (0.25–24); `edit_cutoff_time` (time); `default_timezone` (company only); `notes` (≤ 300); `overridden text[]` (site only).

- **Company rows** set every field (required ones non-null) and `default_timezone`; `overridden` is empty.
- **Site rows** list in `overridden` the fields they set. A listed field may be null, meaning "none" (e.g. company suggests a time, this site wants none). Unlisted fields must be null and inherit the company value. Shift start and end are one unit: overridden together, and both set or both null.
- `overridden` is NOT NULL, one-dimensional, contains no NULLs, and only known keys (CHECKs).
- Policy times are whole minutes (CHECK), matching the app's `HH:mm` entry; the seed copies existing suggested times to the minute.
- Each site version is a **complete override snapshot**, not a patch on the previous site version.

### Resolution

`resolvePolicy(versions, projectId, date)` (TypeScript) and the internal SQL `attendance_policy_resolve(project_id, date)` agree:

1. Company version in force on `date`: latest `effective_from ≤ date`, ties broken by highest `version`.
2. Site version in force on `date` (same rule), if any.
3. Each field: the site value if listed in the site row's `overridden`, else the company value, else the documented fallback.

The result carries the company and site version ids, so the register can detect a settings change between loading and saving.

### Which date's version applies

| Rule | Resolved for |
|---|---|
| Operator edit window (past days, cutoff), future-time tolerances, "window has closed" for auto-absent | the site's **today** (the authoritative window) |
| Suggested IN, shift, overnight, late, half-day, overtime, whether auto-absent is on | the **work date** |

**Retroactivity contract.** Labels are recomputed from the versions in force. A version takes effect from `effective_from`; a version that starts before the site's today (for company versions: before the latest local date of any site) relabels those past days, so the service refuses it unless the admin confirms (`allowBackdate`). Stored attendance (status, times, source) is never rewritten. `check_in_source = 'suggested'` records what was accepted at the time; it is not re-checked against later suggestions.

### Changes to existing tables

- `attendance_records.check_in_source` (`entered` | `suggested`, nullable). Null = absent/pending, or present and saved before this change; never backfilled, never invented. CHECK: non-null only when present. The trigger requires it on insert or when IN actually changes, and keeps the stored value when IN is unchanged (so legacy rows can still get an OUT). Included in audit `old_values`/`new_values`; older audit JSON lacks the key and maps to null.
- `projects.timezone`: validated against `pg_timezone_names`, and locked once the site has attendance. Attendance writes take `FOR SHARE` on the project row and timezone changes take the row lock, so the lock check and the first attendance insert serialize.
- `projects.default_check_in`, `allow_overnight`, `operator_backdate_days`: untouched, marked deprecated by column comment, no longer read.
- New sites get the company `default_timezone` as the preselected value in the create dialog; existing sites keep their own timezone.

### Seed (behaviour-preserving)

- Preflight: the migration fails with a clear message if any existing project has a timezone PostgreSQL does not recognise (no silent repair).
- Company v1, `effective_from 1900-01-01` (covers any historical date), with the fallback values above.
- Each existing project: site v1 from `1900-01-01`, overriding `suggested_check_in`, `allow_overnight`, `operator_backdate_days` with its current column values. Existing sites behave exactly as before; new sites inherit the company (no suggested time).

## Enforcement and read boundary

- **Raw policy rows** (history, notes, authors): admins only (RLS select and insert require `is_admin()`; no update/delete grants; trigger forbids both). The settings service calls `assertAdmin`.
- **Operators** get only the effective values for a site they can access: `attendance_policy_for(project, date)` is SECURITY DEFINER with a fixed search path, raises `forbidden` unless `is_admin()` or `can_access_project(project)` (active operator, active site, unrevoked access), and returns the resolved values plus version ids. In TypeScript the store exposes `getEffectivePolicy`; services check site access first.
- The internal resolver `attendance_policy_resolve` and `operator_edit_closes_at` have EXECUTE revoked from `public`, `anon` and `authenticated`; they are used only inside SECURITY DEFINER functions and triggers. Every new function and table has explicit revokes (new functions are executable by PUBLIC by default; Supabase also grants new tables broadly).
- `can_edit_attendance(project, date)`: `date ≤ site today` for everyone, then admins, or operators with site access and `now() < operator_edit_closes_at(project, date)`. `closes_at = ((date + N) + cutoff) at time zone tz`, or `(date + N + 1)::timestamp at time zone tz` without a cutoff, using today's policy. `now()` is the transaction start.
- `attendance_before_write` (SECURITY DEFINER; runs for the RPC **and** direct table writes) first refuses any signed-in caller for whom `can_edit_attendance` is false, with one uniform `forbidden` error, so it reveals nothing about another site's assignments or settings. Then, after the unchanged identity/assignment/version logic:
  - IN changed: local date in the site timezone = `work_date`; IN ≤ `now() + in tolerance`; source required; `suggested` only if IN's local time equals the work-date suggested IN.
  - OUT changed: local date = `work_date`, or `work_date + 1` only if the work-date policy allows overnight; OUT ≤ `now() + out tolerance`. Existing CHECKs (OUT > IN, ≤ 24 h) stay.
  - A changed IN or OUT whose local time occurs twice (DST fold) is refused (`local_time_is_ambiguous`), as in the app.
  - IN unchanged: source copied from the old row. Not present: source cleared.
- The settings version trigger likewise refuses signed-in non-admins before doing anything.
- `save_attendance` keeps its signature and row-lock-then-version-check order, passes `check_in_source`, and drops its hardcoded tolerances.

### Entry evaluation (one function for every path)

`evaluateEntry(context, proposed, previous)` is used by the P tap, the IN/OUT pickers, bulk present, bulk OUT, the server service and (mirrored) the trigger.

- Inputs are wall-clock `HH:mm` values. A time whose wall-clock value equals the stored one **keeps the stored instant exactly** (seconds, date and DST occurrence included). Only edited times are converted, and only they are re-checked. Editing IN never moves an untouched OUT to another day; if IN passes the stored OUT the entry is refused.
- A new OUT's day: OUT ≤ IN on the wall clock means next day (only if overnight is allowed), else the work date.
- DST: an edited IN or OUT that does not exist (spring-forward gap) or occurs twice (fall-back fold) on that date is rejected with a message. Policy times (cutoff, shift start) follow PostgreSQL's rule — gap: offset before the transition; fold: offset after it — implemented identically in TypeScript.

### Concurrency

- The register returns a policy token (version ids for the work date and for the site's today). The save service re-resolves and returns a "settings changed, reload" conflict if it differs; unsaved drafts stay on the device.
- Policy rows are read per statement inside a batch (READ COMMITTED). A policy committed in the middle of a batch can apply to later rows of that batch; the trigger still enforces whichever policy it reads, so no row is saved that breaks the policy it was checked against.
- PGlite is a single connection, so tests cannot demonstrate multi-session locking; that is reasoned about here, not tested.

## Labels (computed, never stored, never affect pay)

From the work-date policy, for present records, using worked minutes: IN→OUT less the plant's `break_minutes` (if set). Payable hours are separate: they still use each contractor's payment rule, including its own unpaid break.

- **Late**: shift start and late grace set; shift start is anchored to the work date first; late if IN − shift start > grace. Shown as minutes after shift start (including grace).
- **Half day**: complete and worked minutes < `half_day_below_hours × 60`.
- **Overtime**: complete, excess = worked − `overtime_after_hours × 60` > 0 and ≥ `overtime_min_minutes`. Shown as excess minutes.
- **Absent – not marked**: no record or pending, auto-absent on (work-date policy), and the authoritative operator window has closed. Counted separately from pending and from marked absences; not a stored status.
- **Shift end** is informational: shown with the shift and used to prefill OUT pickers. It does not drive overtime.

## Settings screen

- Admin only (layout guard, `assertAdmin` in every settings service, RLS and triggers).
- A version is a complete snapshot. The form asks for the start date first and loads the settings in force on that date (including scheduled versions), so saving never silently drops a scheduled override. It lists later versions that will still take over, and needs explicit confirmation for a start date in the past.
- "Company default" on a site field previews the company value in force on that date.
- Sites show warnings for allowed-but-risky combinations (overnight with today-only editing; a same-day cutoff; late grace without a shift start).

## Manufacturing plants (2026-10-23)

- The app serves contractor labour inside the company's manufacturing plants. "Projects" in the schema and code are plants; table, column and type names are unchanged, and every name users see says plant.
- `break_minutes` (0–240, null = none) is a company default with optional plant overrides, like every other field. It reduces the worked time shown on the register and used for half-day and overtime labels. It never changes payables.
- The migration also re-creates the functions whose user-visible messages mentioned "project" or "site", with only the wording changed. Existing policy, attendance and audit rows are untouched (staged upgrade test).

## Known limits (not changed here)

- Direct table updates by authenticated users still bypass the RPC's `expected_version` check (existing behaviour; the trigger now enforces the policy on them). Making the RPC the only write path is a separate change.
- Overnight shifts with operator past days = 0: operators cannot record an OUT after midnight (existing behaviour). The settings screen warns when a site is configured this way; it does not block it.

## Tests

- Unit (domain): resolution (company only, site override, override-to-none, effective dates, ties, fallback); edit window and cutoff edges; future tolerance edges; exact-instant preservation (seconds); overnight OUT; DST gap/fold rejection and PostgreSQL-compatible cutoff in America/New_York; midnight in Asia/Kolkata and Asia/Kathmandu (+05:45); labels.
- Services: global default applied; site override wins; operator refused on every settings call and on raw policy reads; bulk and individual give the same verdict for the same input; suggested flag stored; register load creates no records; auto-absent off by default and report-only when on; policy token conflict.
- DB (PGlite): staged upgrade (old migrations → legacy data → new migrations) proves existing rows/audit unchanged, seeded behaviour identical, legacy OUT-only update works; append-only + versioning for both scopes; RLS (operators cannot read raw rows; `attendance_policy_for` refuses other sites, inactive operators, anon); trigger enforces tolerances, IN date, overnight OUT, source rules, cutoff, future dates (present/absent via RPC and direct DML); timezone validity and lock; TS/SQL parity on shared fixtures including DST.
- E2E: admin changes a default and a site override; operator register reflects it; bulk present asks for a time when there is no suggestion.
