# AWS architecture, compatibility audit and costs

Status (25 Oct 2026): everything below is prepared in code and tested locally. **No AWS resource has been created**, no migration has run against a real database, and WhatsApp live sending is off. Provisioning waits for the owner's approval.

## 1. Recommendation in one paragraph

Run the existing Next.js app as **one small container on Amazon ECS Express Mode** (Fargate behind an HTTPS load balancer with an AWS-managed certificate), with **Amazon RDS for PostgreSQL 18** in private subnets, contractor photos in a **private S3 bucket**, secrets in **Secrets Manager**, logs and alarms in **CloudWatch**, and the WhatsApp dispatch triggered every 10 minutes by **EventBridge Scheduler → a tiny Lambda** (created switched off). Region: **Asia Pacific (Mumbai), ap-south-1**. Expected cost: **about $68 a month before GST** (section 5). No NAT gateway, no RDS Proxy, no Cognito, no SQS: the app does not need them.

## 2. Compatibility audit (what the app needed, what changed)

| Area | Finding | Change for AWS |
|---|---|---|
| Framework | Next.js 16.4 (App Router, server actions, `proxy.ts`, Node-runtime route handlers), React 19, TypeScript 5.9. Needs a long-running Node.js server; nothing uses the Edge runtime. | `output: "standalone"` and a container image (`Dockerfile`). Pages that read the session or the app mode now run per request only (`connection()`), so `next build` works without run-time settings. |
| Database access | No ORM. V2 used `supabase-js` (PostgREST) for reads and RPC calls; all business rules live in SQL (RLS policies, triggers, `security definer` functions). | `PostgresStore` (`src/lib/server/store/postgres-store.ts`) issues the same SQL over node-postgres (`pg`) with a small connection pool. |
| PostgreSQL compatibility | Plain PostgreSQL apart from three things Supabase provided: the `auth` schema and `auth.uid()`, the roles `anon` / `authenticated` / `service_role`, and the `storage` schema. Uses `btree_gist` (available on RDS). Test suite runs on PostgreSQL 18.6 (PGlite). | `db/platform/bootstrap.sql` creates those objects on any PostgreSQL. RDS engine set to **PostgreSQL 18** to match what is tested. |
| Migrations | 12 files in `supabase/migrations/`, never applied anywhere (the five V2 files `20261023000001`–`05` plus earlier ones and the new `20261024000001_app_auth`). | `scripts/db/migrate.mjs`: bootstrap + migrations in order, SHA-256 ledger (`platform.schema_migrations`), refuses edited or missing files, shows a plan by default, applies only with `--confirm-target <host>/<db>`. The folder keeps its old name to avoid churn. |
| Authentication | Supabase Auth (GoTrue) is not available on RDS. | App-managed sign-in (migration `20261024000001_app_auth.sql`, `src/lib/server/auth/*`): scrypt password hashes, random session tokens stored only as SHA-256, 5 wrong passwords lock for 15 minutes, sessions end on sign-out / password change / deactivation, **accounts created by admins only**, temporary passwords must be changed at first sign-in. **Cognito was not adopted**: for a dozen staff accounts it adds a user pool to keep in sync with `profiles`, token verification and hosted-UI work, with no security gain over the existing design. |
| Authorisation | Every table has RLS keyed on `auth.uid()` and plant access in `site_operator_assignments`. | Kept unchanged. Each request runs in one transaction with `set local role authenticated` and the user's id, so the database enforces plant access even if server code were wrong. The app's own login (`nf_app`) is NOINHERIT and can do nothing except switch to `authenticated` or the sign-in-only role `app_auth`. Scheduled jobs act as a system admin profile **under RLS** (Supabase's service role used to bypass it). |
| Server API | Server actions (forms, saves, imports up to 4 MB), route handlers for Excel exports, health, WhatsApp dispatch and webhook. | `/api/health` checks one database round trip for the load balancer. |
| Background jobs | WhatsApp dispatch is an HTTP endpoint meant to be called by an external cron (documented for Vercel Cron / pg_cron). The queue is the `outbound_messages` table. | EventBridge Scheduler (every 10 min) → Lambda `infra/lambda/dispatch.cjs` → `POST /api/whatsapp/dispatch` with `CRON_SECRET`. The Lambda holds no state; the database queue keeps idempotency keys, retries and the provider status ledger. Schedule created **DISABLED**. |
| File storage | Supabase Storage for contractor photos only. Uploaded Excel masters are read in memory and never stored. | Private S3 bucket; the browser gets 5-minute signed URLs. Development mode stores photos under `.data/uploads` and serves them only to signed-in users. |
| Demo vs live | Demo data is in memory. | Three modes: `APP_MODE=demo`, `development` (local PostgreSQL), `production` (RDS + S3). Demo never switches on by itself: a configured database or a production build without `APP_MODE` is an error. |
| Remaining Supabase / Vercel couplings | `src/lib/server/store/supabase-store.ts`, `src/lib/supabase/server.ts` and the `@supabase/*` packages are no longer used by any running code path. `.env.example` still lists the Supabase variables. | **Awaiting the owner's decision** to delete the dead files and packages. `.env.example` is not edited (workspace rule); the current variables are in `deployment.md` §9. |

## 3. Architecture

```
 Browser (admins, plant operators)
        │  HTTPS (AWS-managed certificate, *.ecs.ap-south-1.on.aws)
        ▼
 ┌─ VPC 10.20.0.0/16, 2 availability zones ─────────────────────────────────────┐
 │  Public subnets                                                             │
 │   ALB (created and managed by ECS Express Mode)                             │
 │     └─► ECS Fargate task  0.5 vCPU / 1 GB  (min 1, max 2)                   │
 │          app security group: no inbound of its own; public IP for egress    │
 │                    │ TLS (verify-full, RDS CA) on 5432                      │
 │  Isolated subnets  ▼  (no route to the internet)                            │
 │   RDS PostgreSQL 18  db.t4g.micro, gp3 20→100 GB, encrypted, force_ssl     │
 │   security group: 5432 from the app security group only                     │
 │  S3 gateway endpoint (free)                                                 │
 └─────────────────────────────────────────────────────────────────────────────┘
   S3 (private photos) · Secrets Manager (3 secrets) · CloudWatch Logs/alarms
   ECR (images, immutable tags) · CodeBuild (builds the image; no Docker on the PC)
   EventBridge Scheduler ──► Lambda (outside the VPC) ──► HTTPS dispatch endpoint
   AWS Budgets + SNS email alerts
```

Infrastructure as code: AWS CDK in `infra/` (three stacks, synthesised and tested locally):

| Stack | Contents | When |
|---|---|---|
| `NfAttendance-Data` | VPC, security groups, RDS, the three secrets, photo bucket, ECR, CodeBuild + build-source bucket, budget, SNS alerts, database alarms | Once; rarely changes. Termination protection on. |
| `NfAttendance-Admin` | ECS cluster, admin task definition (migrations, first admin) | Each release, **before** migrations |
| `NfAttendance-App` | ECS Express Mode web service, roles, WhatsApp Lambda + schedule (disabled), dispatch alarm | Each release, **after** migrations |

### Options considered

| Option | Verdict |
|---|---|
| AWS Amplify Hosting (the brief's first preference) | **Rejected.** Its SSR compute cannot connect into a VPC, so the database would have to be publicly reachable; its documentation lists Next.js only up to 15. ([issue](https://github.com/aws-amplify/amplify-hosting/issues/3362), [docs](https://docs.aws.amazon.com/amplify/latest/userguide/update-app-nextjs-version.html)) |
| AWS App Runner | **Not available**: closed to new customers on 30 April 2026; AWS points to ECS Express Mode. ([docs](https://docs.aws.amazon.com/apprunner/latest/dg/what-is-apprunner.html)) |
| **ECS Express Mode** | **Chosen.** No extra charge beyond Fargate, the load balancer and logs; HTTPS address and certificate managed by AWS; runs inside our VPC. ([overview](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html), [resources created](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html)) |
| ECS Fargate with a self-defined load balancer | Fallback if Express Mode limits us (e.g. custom domain in code). Needs our own domain and ACM certificate from day one. |
| One EC2 instance (Docker + Caddy) + RDS | Cheapest (roughly $25–30 less per month), but operating-system patching, TLS renewal and restarts become our job, and a domain is needed for TLS. Not recommended for a small team without a server administrator. |
| Amazon Cognito | Not needed (§2, Authentication). |
| RDS Proxy | Not needed: one long-running server with a pool of 5 connections; the Lambda never touches the database. |
| NAT gateway | Avoided (≈ $33/month + data): tasks in public subnets with public IPs and a security group with no inbound rules; the database stays in isolated subnets. |
| SQS queue | Not needed: the `outbound_messages` table already is a durable queue with idempotency keys. |

## 4. Security and backup settings

- **Network**: database only in isolated subnets, `PubliclyAccessible=false`, reachable on 5432 only from the app security group. The app security group has no inbound rules of its own; Express Mode adds the load-balancer path.
- **Encryption**: RDS storage encrypted (AWS-managed key); TLS required by the database (`rds.force_ssl=1`) and verified by the app (`DATABASE_SSL=verify-full` with the RDS CA bundle baked into the image); S3 SSE-S3 with a policy that denies non-TLS requests; all public access blocked on both buckets.
- **Least privilege**: the running app may only get/put/delete objects under `contractor-photos/*`. The database owner password is used only by the admin task. The app's database login cannot read password hashes or session tokens. Passwords and keys reach containers only as Secrets Manager references, never as plain settings (tested in `infra/test`).
- **Accounts**: no self-registration; admins create operators with temporary passwords; lockout after 5 wrong passwords; sessions are server-side and revocable.
- **Backups**: automated RDS backups kept 7 days with point-in-time restore; deletion protection on; a final snapshot is kept if the database is ever removed; photo bucket versioned (old versions kept 90 days) and retained if the stack is deleted; ECR keeps the last 10 images (immutable tags) for rollback.
- **Monitoring**: application, admin-task, build, database and Lambda logs kept 1 month; alarms for database CPU, low database storage and repeated dispatch failures, plus the deployment alarm Express Mode creates; monthly budget alerts (80% actual, 100% forecast) by email.
- **Data handling**: worker master workbooks and scanned registers are git-ignored and never copied into images; the image is built from `git archive` (committed files only).

## 5. Monthly cost estimate (ap-south-1)

Unit prices are from AWS's official price-list files for Asia Pacific (Mumbai), read on 24 Oct 2026. 730 hours per month. USD, **before 18% GST** (AWS India invoices add GST).

| Service | Sizing | Unit price | Per month |
|---|---|---|---|
| ECS Fargate (web) | 1 task, 0.5 vCPU, 1 GB, all month | $0.04256 / vCPU-h, $0.004655 / GB-h | $18.93 |
| Application Load Balancer | 1 (Express Mode, shared up to 25 services) | $0.0239 / h + ~$0.6 LCU | ≈ $18.05 |
| Public IPv4 addresses | 2 for the load balancer + 1 for the task | $0.005 / h each | $10.95 |
| RDS PostgreSQL | db.t4g.micro Single-AZ | $0.021 / h | $15.33 |
| RDS storage | 20 GB gp3 (grows automatically to 100 GB) | $0.131 / GB-month | $2.62 |
| RDS backups | 7 days, up to 20 GB | free up to the storage size | $0.00 |
| Secrets Manager | 3 secrets | $0.40 / secret | $1.20 |
| CloudWatch Logs | ≈ 0.5 GB ingested, 1-month retention | $0.67 / GB, $0.03 / GB-month | ≈ $0.40 |
| ECR | up to 10 images ≈ 3 GB | $0.10 / GB-month | ≈ $0.30 |
| S3 photos | < 1 GB | $0.025 / GB-month | ≈ $0.03 |
| CodeBuild, Lambda, Scheduler, SNS, alarms, budget, data out | a few builds; schedule off | free tiers / pennies | ≈ $0.00–0.50 |
| **Total** | | | **≈ $68 / month** (≈ $80 with GST) |

- **One-time costs**: none from AWS. Optional: a custom domain name (registrar fee).
- **Free tier**: not assumed. A new account may have promotional credits; check *Billing → Credits / Free Tier*.
- **What drives the bill**: the always-on database instance and Fargate task, the load balancer hour charge, and public IPv4 addresses. A NAT gateway (avoided) would add ≈ $33/month. Log volume and photo storage are negligible at this size.
- **Changes the owner may choose**: Multi-AZ database (no downtime during maintenance) **+ ≈ $18/month**; a second web task during busy periods + ≈ $22/month while it runs; WhatsApp scheduling itself ≈ $0 (Meta charges per message separately).
- **Budget alert**: `MonthlyBudgetUsd` defaults to **$90** (above the $68 estimate, so it only fires on real overspend), with email alerts at 80% of actual and 100% of forecast.

## 6. Unavoidable risks and open items

1. **Express Mode is a young service** (late 2025). Its CloudFormation resource is low-level, and **custom domains are a manual step** outside the stacks; the AWS `*.on.aws` address works from day one. If that becomes a problem, switch the web stack to a standard Fargate service with our own load balancer.
2. **Single-AZ database**: a few minutes of downtime during weekly maintenance (window Monday 03:00–03:30 IST) or an AZ failure; restore is from automated backups.
3. **WhatsApp delivery cannot be exactly-once.** The queue guarantees no duplicate *logical* notification (idempotency keys), but if the network fails after Meta accepted a message and before we recorded it, the message is marked *failed – check before retrying* rather than resent. A person decides.
4. **Not yet verified on AWS** (needs real resources): CloudFormation deployment, Express Mode endpoint format, TLS from the task to RDS, S3 signed URLs, CodeBuild image build, Scheduler → Lambda → app, budget emails.
5. **Owner decisions pending**: delete the dead Supabase code and packages; update `.env.example` (workspace rule forbids editing it without permission); approve provisioning.
