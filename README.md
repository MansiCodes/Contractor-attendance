# NF Attendance Register

A simple, mobile-first digital replacement for the paper attendance registers kept for contractor labour working inside our manufacturing plants (Atlanta Tele Cables / Valuecon / Notofire). Head office sees every plant, and totals are calculated automatically.

Company → Manufacturing plant → Contractor → Workers → Daily attendance. A plant can have several contractors, and a contractor can supply workers to several plants. Each worker has one plant assignment at a time, with the history kept.

- **Plant attendance operator**: Attendance and History only. Opens their plant, picks a contractor, confirms who is present, edits IN times, records OUT, marks absent, and saves.
- **Head office admin**: Overview, Attendance (register, contractor-wise and plant-wise reports, Excel export, change log), Contractors (workers, payment rules), Plants (plants, contractor assignment, operators), Workers and Settings (attendance defaults).

Internally, plants are stored in the `projects` table (`project_id` columns, `Project` types). Only the names users see were changed, so nothing that already worked had to move.

Stack: Next.js 16 (App Router, TypeScript), Tailwind CSS 4, shadcn/ui, PostgreSQL with Row Level Security (node-postgres; Amazon RDS in production), app-managed sign-in, React Hook Form + Zod, date-fns, Lucide, ExcelJS. Hosting target: AWS (ECS Express Mode, RDS, S3), defined with AWS CDK in `infra/`. Vitest, PGlite and Playwright are used for tests.

The app runs in one of three modes, chosen by `APP_MODE`:

| Mode | Data | Used for |
|---|---|---|
| `demo` | fictional, in server memory | trying the app; never switches on by itself when a database is configured |
| `development` | a local PostgreSQL (built-in PGlite server or Docker) | developing with a real database |
| `production` | Amazon RDS PostgreSQL + private S3, TLS required | the live system on AWS |

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

**On your phone:** run `npm run dev -- -H 0.0.0.0` and open `http://<your-PC-LAN-IP>:3000` on a phone connected to the same Wi-Fi.

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

## 3. Development mode (a real database on your PC)

No installation needed: a local PostgreSQL 18 (PGlite) is served on 127.0.0.1 only, with its data in `.data/` (git-ignored).

```bash
npm run db:dev                          # terminal 1: the database (keep it open)
npm run db:dev:migrate                  # terminal 2: apply all migrations
npm run db:dev:admin -- you@example.com "Your Name"   # first admin (password typed at a hidden prompt)
npm run dev:pg                          # the app in development mode, photos under .data/uploads
```

Sign in with that email; later admins and all operators are created in the app with temporary passwords that must be changed at the first sign-in. There is no self-registration. A database closer to RDS: `docker-compose.yml` (PostgreSQL 18 on 127.0.0.1:54330, needs Docker or Podman).

If the database is configured but unreachable, the app shows an error. It never falls back to demo data.

## 4. Production on AWS

Everything is prepared as code but **nothing has been created on AWS yet**; provisioning waits for approval.

- [docs/aws/architecture-and-costs.md](docs/aws/architecture-and-costs.md): compatibility audit, architecture, options considered, security and backups, monthly cost (≈ $68 before GST).
- [docs/aws/deployment.md](docs/aws/deployment.md): step-by-step deployment, migrations, first admin, releases, rollback, backups, WhatsApp go-live.
- `infra/`: the CDK stacks (`NfAttendance-Data`, `NfAttendance-Admin`, `NfAttendance-App`) and their tests; `Dockerfile` for the image.

To try the production build locally: `npm run build`, then `node scripts/start-standalone.mjs` (the same server the container runs).

## 5. Tests

```bash
npm run check        # type-check + lint + all Vitest suites
npm run test:unit    # calculations, services/permissions, Excel reconciliation, demo/live isolation
npm run test:db      # runs the real SQL migrations in PGlite (Postgres 18) and tests RLS, RPCs, triggers
npm run test:e2e     # builds the app and runs Playwright against the standalone server: phone-sized operator flow + admin flow
npm run infra:test   # security and cost checks on the synthesised AWS CloudFormation (no AWS access)
npm run infra:synth  # writes the CloudFormation templates to infra/cdk.out
```

The infra commands need `npm ci` inside `infra/` once.

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
src/lib/server/store/       DataStore interface, demo store, PostgreSQL store
src/lib/server/auth/        sign-in, sessions, passwords
src/lib/server/db/          connection pool; every query runs as the signed-in user under RLS
src/lib/server/storage/     private photo storage (S3, or a local folder in development)
db/platform/bootstrap.sql   roles and auth objects the migrations rely on (plain PostgreSQL)
supabase/migrations/        schema, RLS, functions (folder name kept from V1)
scripts/                    migrations, first admin, password hash, local database, standalone server
infra/                      AWS CDK stacks, tests, scheduled-dispatch Lambda
tests/                      unit, db (PGlite) and e2e (Playwright)
```

## 7. Not yet verified, or needing your input

- **Not yet tested on AWS**: no AWS resource exists yet. Sign-in, the PostgreSQL store, migrations and the admin scripts are tested against PostgreSQL 18 (PGlite) locally, including the production build in development mode; TLS to RDS, S3 signed links, the image build and the scheduler are not.
- **Payment rates and thresholds**: none are assumed. Configure each contractor's real terms under Contractors → Payment rules.
- **Operator role**: the operator's job designation is still open. The app makes no assumption about whether the operator works for the contractor or for the company.
- **Timezone**: new plants start with the company default from Settings (`Asia/Kolkata` initially). Each plant keeps its own timezone, which locks once attendance has been recorded there.
- **Migrations**: none has been applied to a real database yet (all are tested in PGlite). On AWS they run through `scripts/db/migrate.mjs` (see the deployment guide).
- **`.env.example`** still shows the old Supabase variables (the Supabase code and packages themselves were removed on 26 Oct 2026). The current variables are in [docs/aws/deployment.md](docs/aws/deployment.md) §9.
- **Undecided pay settings**: overtime pay (rate or multiplier), rounding, commission base and treatment, Shukla's rate basis and days per month, short-day handling, and which Sumit workers get commission. See [docs/contractor-master-and-pay.md](docs/contractor-master-and-pay.md).
- **Contractor identity**: confirm whether the "Excellent" sheet is GAJENDRA RANA CONTRACTORS.
- **WhatsApp**: not connected to Meta; live sending is off and the AWS schedule is created disabled. See [docs/whatsapp.md](docs/whatsapp.md) and [docs/aws/deployment.md](docs/aws/deployment.md) §12.
- **Historical registers (PDF)**: the handwritten September register was not transcribed. Entering it needs a person to type it, or a reviewed CSV/XLSX import (not built yet).
- **Branding**: the app is still named "NF Attendance Register". Tell us if it should carry another name now that it covers Atlanta Tele Cables, Valuecon and Notofire plants.
