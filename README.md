# NF Attendance Register

A simple, mobile-first digital replacement for the paper attendance registers kept for contractor labour working inside our manufacturing plants (Atlanta Tele Cables / Valuecon / Notofire). Head office sees every plant, and totals are calculated automatically.

Company → Manufacturing plant → Contractor → Workers → Daily attendance. A plant can have several contractors, and a contractor can supply workers to several plants. Each worker has one plant assignment at a time, with the history kept.

- **Plant attendance operator**: Attendance and History only. Opens their plant, picks a contractor, confirms who is present, edits IN times, records OUT, marks absent, and saves.
- **Head office admin**: Overview, Attendance (register, contractor-wise and plant-wise reports, Excel export, change log), Contractors (workers, payment rules), Plants (plants, contractor assignment, operators), Workers and Settings (attendance defaults).

Internally, plants are stored in the `projects` table (`project_id` columns, `Project` types). Only the names users see were changed, so nothing that already worked had to move.

Stack: Next.js 16 (App Router, TypeScript), Tailwind CSS 4, shadcn/ui, Supabase (Postgres, Auth, Storage, RLS), React Hook Form + Zod, date-fns, Lucide, ExcelJS. Vitest, PGlite and Playwright are used for tests.

---

## 1. Run the demo (no setup needed)

```bash
npm install
npm run dev
```

Open http://localhost:3000. A yellow **DEMO MODE** banner shows on every page. Choose a demo user on the sign-in screen:

| Demo user | What you can try |
|---|---|
| Demo Admin (Head Office) | Overview, reports, Excel export, workers, payment rules, plants, operators, settings |
| Demo Operator – PVC Plant | One plant with an illustrative shift, break and late/half-day/overtime labels; operators may also edit yesterday |
| Demo Operator – LED & Upcast | Two plants, with all of today still pending; the Upcast Plant has an overnight shift |
| Demo Operator – Quad & Signalling | One plant with no suggested IN time, so every IN is entered |

The demo has 4 manufacturing plants (PVC, LED Rope Light, Upcast, Quad & Signalling), 4 labour contractors, 54 workers, 24 days of attendance and illustrative payment rules. One contractor is deliberately left without a rule, so you can see how "Not configured" looks. Every plant and contractor name contains "(Demo)", worker names are random combinations, and every rate and shift setting is marked illustrative. These plants are examples only: admins add, edit and deactivate plants under **Plants**.

Demo data lives only in server memory. It never touches a database, and it resets when the server restarts or when you use **user menu → Reset demo data**.

**On your phone:** run `npm run dev -- -H 0.0.0.0` and open `http://<your-PC-LAN-IP>:3000` on a phone connected to the same Wi-Fi. You can also deploy the demo to Vercel (section 4).

## 2. How attendance works

- When the register opens, every worker assigned to that plant and contractor is **Pending**. If the plant has a *suggested* IN time (Settings; none by default), it is shown as a starting point. Pending workers are never counted as present or payable, and opening the register creates no records.
- Tapping **P** accepts the suggested time, and the record is flagged "IN as suggested" in reports, the export and the change log. With no suggestion, or one that is still ahead of the clock, **P** opens the time picker instead.
- Tap **P** (Present) to confirm, tap the IN time to change it (this also confirms the worker), or tap **A** (Absent).
- OUT is always recorded separately. The app never makes up a checkout: OUT cannot be earlier than IN, and it cannot be in the future. A worker with no OUT is counted as *present but incomplete* and is left out of hours and payables.
- Overnight shifts are allowed only when the admin turns them on for that plant.
- How far ahead of the clock an IN or OUT may be recorded comes from the plant's settings (company default: IN 60 min, OUT 5 min). The same check runs in the browser, on the server and in the database, for single and bulk entries alike.
- Bulk actions ("Mark all pending present" and "Record OUT for N workers") are labelled **Bulk confirmed** in the change log.
- Unsaved changes are highlighted, kept on the device if the page is reloaded, and saved together in one all-or-nothing transaction. If someone else edits the same entry first, the save is rejected with a version conflict instead of overwriting their change.
- By default, operators can only edit today. Settings can allow up to 7 past days and a cutoff time on the last day. Admins can correct any past date, and every change is logged with who made it, old → new values, and when.

**Attendance settings** (admin only, Settings in the menu): company-wide defaults with optional per-plant overrides for the suggested IN time, shift start and end, break (not counted as worked time; pay still follows each contractor's payment rule), future-time limits, overnight shifts, operator edit window and cutoff, late / half-day / overtime *labels* (they never change pay) and an optional report-only "absent – not marked". Every change is a new version from a start date; earlier versions and recorded attendance are never rewritten. Design and decisions: [docs/attendance-settings.md](docs/attendance-settings.md).

**Payments** come from versioned contractor rules: one contractor rate or each worker's own rate (monthly / daily / hourly, kept from the master), standard hours and short days, day and night overtime thresholds, overtime pay, rounding, and contractor commission (all or selected workers). Rule versions are append-only, so changing a rate creates a new version from a chosen date and never rewrites earlier totals. A setting that is not decided yet shows **Needs configuration** instead of an amount. Amounts are *estimates*, not disbursements.

**Contractor master import, shifts and payroll**: Workers → Import from Excel (preview first, exact employee IDs, imported workers stay Unassigned); a Day / Night switch on the register; Attendance → Payroll with a drill-down and Excel export. See [docs/contractor-master-and-pay.md](docs/contractor-master-and-pay.md).

**WhatsApp messages** (Settings → WhatsApp): a short Hindi message to each consenting worker after a confirmed day, never with wages. **Live sending is off**: messages go to a mock transport. See [docs/whatsapp.md](docs/whatsapp.md).

## 3. Connect Supabase (live mode)

1. Create a Supabase project (choose the Mumbai region for India).
2. Apply the migrations **in order** from `supabase/migrations/`, either through the SQL Editor (paste each file in turn) or with the Supabase CLI:
   ```bash
   npx supabase link --project-ref <your-ref>
   npx supabase db push
   ```
   These create the tables, constraints, RLS policies, RPC functions, audit triggers and the private `contractor-photos` storage bucket.
3. In **Authentication → Sign In / Providers**, turn **off** "Allow new users to sign up". Accounts are created by admins only.
4. Copy `.env.example` to `.env.local` and fill in:
   - `APP_MODE=live`
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (from Project Settings → API)
   - `SUPABASE_SERVICE_ROLE_KEY` (server-only; used just to create operator accounts)
5. Create the first admin:
   ```bash
   npm run create-admin -- admin@yourcompany.in "Admin Name" "a-strong-temp-password"
   ```
6. Run `npm run dev` and sign in with that email and password. Then add plants, contractors (assign them to plants), workers, payment rules, attendance settings, and operators (Plants → Plant attendance operators). Grant each operator access to their plants.

In live mode, the demo sign-in and demo data are switched off completely. If a database call fails, the error is shown and demo data is never used in its place.

## 4. Deploy to Vercel

1. Push this folder to a Git repository and import it in Vercel (framework preset: Next.js; no build settings needed).
2. Add the environment variables from step 3.4 for **Production** (and Preview, if you want a live preview). Leave them out entirely for a public demo deployment.
3. Deploy. To install the app on a phone, open the URL in Chrome or Safari and choose "Add to Home screen".

Note: in demo mode on Vercel, the in-memory data may reset when the server instance is recycled. That is fine for demos. Use live mode for real data.

## 5. Tests

```bash
npm run check        # type-check + lint + all Vitest suites
npm run test:unit    # calculations, services/permissions, Excel reconciliation, demo/live isolation
npm run test:db      # runs the real SQL migrations in PGlite (Postgres 18) and tests RLS, RPCs, triggers
npm run test:e2e     # builds the app and runs Playwright: phone-sized operator flow + admin flow
```

The first `test:e2e` run needs a Playwright browser: `npx playwright install chromium`. Set `PW_CHANNEL=msedge` to use an installed Edge instead.

## 6. Project layout

```
src/app/                    routes: /login, /attendance, /history, /admin/*, /api/export, /api/whatsapp/*
src/components/attendance/  the register screen (rows, time picker sheet)
src/components/admin/       admin dialogs and forms
src/lib/domain/             pure logic: time maths, payment rules engine, register, report, payroll, master import, messaging
src/lib/import/             reads uploaded .xlsx files into plain grids
src/lib/server/messaging/   WhatsApp transports (mock / Cloud API), webhook checks, dispatcher
src/lib/server/services/    authorization + business rules (used by both data stores)
src/lib/server/store/       DataStore interface, demo store, Supabase store
supabase/migrations/        schema, RLS, functions, storage
tests/                      unit, db (PGlite) and e2e (Playwright)
```

## 7. Not yet verified, or needing your input

- **Not yet tested against a real Supabase project**: live sign-in, the Supabase data store, photo upload and creating operator accounts. The SQL itself (schema, RLS, functions, triggers) is tested in PGlite, but PGlite is not PostgREST or GoTrue.
- **Payment rates and thresholds**: none are assumed. Configure each contractor's real terms under Contractors → Payment rules.
- **Operator role**: the operator's job designation is still open. The app makes no assumption about whether the operator works for the contractor or for the company.
- **Timezone**: new plants start with the company default from Settings (`Asia/Kolkata` initially). Each plant keeps its own timezone, which locks once attendance has been recorded there.
- **Migrations since the baseline** (`20261022000001`, `20261022000002`, `20261023000001_manufacturing_plants`, `20261023000002_worker_master`, `20261023000003_payment_rules_v2`, `20261023000004_shifts`, `20261023000005_whatsapp`) are tested only in PGlite so far. They have not been applied to any Supabase project.
- **Undecided pay settings**: overtime pay (rate or multiplier), rounding, commission base and treatment, Shukla's rate basis and days per month, short-day handling, and which Sumit workers get commission. See [docs/contractor-master-and-pay.md](docs/contractor-master-and-pay.md).
- **Contractor identity**: confirm whether the "Excellent" sheet is GAJENDRA RANA CONTRACTORS.
- **WhatsApp**: not connected to Meta; live sending is off. See [docs/whatsapp.md](docs/whatsapp.md) for the go-live checklist and the variables to add to `.env.example`.
- **Historical registers (PDF)**: the handwritten September register was not transcribed. Entering it needs a person to type it, or a reviewed CSV/XLSX import (not built yet).
- **Branding**: the app is still named "NF Attendance Register". Tell us if it should carry another name now that it covers Atlanta Tele Cables, Valuecon and Notofire plants.
