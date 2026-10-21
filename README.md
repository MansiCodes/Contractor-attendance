# NF Attendance Register

A simple, mobile-first digital replacement for the paper attendance registers used by labour contractors at NF (Valuecon / Notofire) government project sites. Head office sees every site, and totals are calculated automatically.

- **Site Operator**: Attendance and History only. Picks a site and contractor, confirms who is present, edits IN times, records OUT, marks absent, and saves.
- **NF Admin**: Overview, Attendance (register, report & Excel export, change log), Contractors (workers, payment rules) and Projects (sites, contractor assignment, operators).

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
| Demo Admin (NF Head Office) | Overview, reports, Excel export, workers, payment rules, sites, operators |
| Demo Operator – Jaipur | One site, where operators may also edit yesterday |
| Demo Operator – Pune & Lucknow | Two sites, with all of today still pending |
| Demo Operator – Guwahati & Bhubaneswar | Includes an overnight-shift site |

The demo has 4 contractors, 5 project sites, 54 workers, 24 days of attendance and illustrative payment rules. One contractor is deliberately left without a rule, so you can see how "Not configured" looks. Every name contains "(Demo)" and every rate is marked illustrative.

Demo data lives only in server memory. It never touches a database, and it resets when the server restarts or when you use **user menu → Reset demo data**.

**On your phone:** run `npm run dev -- -H 0.0.0.0` and open `http://<your-PC-LAN-IP>:3000` on a phone connected to the same Wi-Fi. You can also deploy the demo to Vercel (section 4).

## 2. How attendance works

- When the register opens, every assigned worker is **Pending**. If the site has a *suggested* IN time (Settings → Attendance; none by default), it is shown as a starting point. Pending workers are never counted as present or payable, and opening the register creates no records.
- Tapping **P** accepts the suggested time, and the record is flagged "IN as suggested" in reports, the export and the change log. With no suggestion, or one that is still ahead of the clock, **P** opens the time picker instead.
- Tap **P** (Present) to confirm, tap the IN time to change it (this also confirms the worker), or tap **A** (Absent).
- OUT is always recorded separately. The app never makes up a checkout: OUT cannot be earlier than IN, and it cannot be in the future. A worker with no OUT is counted as *present but incomplete* and is left out of hours and payables.
- Overnight shifts are allowed only when the admin turns them on for that site.
- How far ahead of the clock an IN or OUT may be recorded comes from the site's settings (company default: IN 60 min, OUT 5 min). The same check runs in the browser, on the server and in the database, for single and bulk entries alike.
- Bulk actions ("Mark all pending present" and "Record OUT for N workers") are labelled **Bulk confirmed** in the change log.
- Unsaved changes are highlighted, kept on the device if the page is reloaded, and saved together in one all-or-nothing transaction. If someone else edits the same entry first, the save is rejected with a version conflict instead of overwriting their change.
- By default, operators can only edit today. Settings can allow up to 7 past days and a cutoff time on the last day. Admins can correct any past date, and every change is logged with who made it, old → new values, and when.

**Attendance settings** (admin only, Settings in the menu): company-wide defaults with optional per-site overrides for the suggested IN time, shift, future-time limits, overnight shifts, operator edit window and cutoff, late / half-day / overtime *labels* (they never change pay) and an optional report-only "absent – not marked". Every change is a new version from a start date; earlier versions and recorded attendance are never rewritten. Design and decisions: [docs/attendance-settings.md](docs/attendance-settings.md).

**Payments** come from versioned contractor rules: per day or per hour, full-day and half-day thresholds, unpaid break, and optional overtime. Rule versions are append-only, so changing a rate creates a new version from a chosen date and never rewrites earlier totals. Amounts are *estimates*, not disbursements.

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
6. Run `npm run dev` and sign in with that email and password. Then add projects, contractors (assign them to projects), workers, payment rules, and operators (Projects → Attendance operators). Grant each operator access to their sites.

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
src/app/                    routes: /login, /attendance, /history, /admin/*, /api/export
src/components/attendance/  the register screen (rows, time picker sheet)
src/components/admin/       admin dialogs and forms
src/lib/domain/             pure logic: time maths, payment rules engine, register, report
src/lib/server/services/    authorization + business rules (used by both data stores)
src/lib/server/store/       DataStore interface, demo store, Supabase store
supabase/migrations/        schema, RLS, functions, storage
tests/                      unit, db (PGlite) and e2e (Playwright)
```

## 7. Not yet verified, or needing your input

- **Not yet tested against a real Supabase project**: live sign-in, the Supabase data store, photo upload and creating operator accounts. The SQL itself (schema, RLS, functions, triggers) is tested in PGlite, but PGlite is not PostgREST or GoTrue.
- **Payment rates and thresholds**: none are assumed. Configure each contractor's real terms under Contractors → Payment rules.
- **Operator role**: the operator's job designation is still open. The app makes no assumption about whether the operator works for the contractor or for NF.
- **Timezone**: new sites start with the company default from Settings (`Asia/Kolkata` initially). Each site keeps its own timezone, which locks once attendance has been recorded there.
- **Attendance settings migrations** (`20261022000001`, `20261022000002`) are tested only in PGlite so far. They have not been applied to any Supabase project.
