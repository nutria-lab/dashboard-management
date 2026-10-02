# dashboard-management

Teacher dashboard for Linear task deliveries and class attendance. React + Vite + TypeScript, a Node API, Prisma 7 and Neon PostgreSQL.

## Setup

Use Node 24 LTS and npm. The repository is local; no GitHub remote is configured.

    npm ci
    cp .env.example .env

Fill .env:

- LINEAR_API_KEY: a read-only Linear API key with access to the NutrIA team. Used only by the server.
- LINEAR_TEAM_ID and LINEAR_REVIEW_STATE_ID: prefilled IDs verified for NutrIA and its In Review state.
- LINEAR_WEBHOOK_SECRET: the signing secret shown by Linear for your webhook. Optional for local periodic sync; required to receive webhook events. Server-only.
- LINEAR_STUDENT_IDS: comma-separated student user IDs, prefilled for Lara, Fer and Majo. Adjust the roster here; leave empty to include all human team members.
- DATABASE_URL: Neon pooled PostgreSQL URL with SSL parameters.
- DIRECT_URL: Neon direct PostgreSQL URL for migration commands.
- DASHBOARD_PASSWORD: the shared teacher password.
- SESSION_SECRET: at least 32 random characters. Generate with openssl rand -hex 32.

Then:

    npm run db:generate
    npm run db:migrate
    npm run linear:import
    npm run dev

The UI runs on http://localhost:5173; /api is proxied to the local Node server on port 3001. Migrations are applied only when you run the migration command. The build generates Prisma and does not migrate any database.

## Delivery rules

The initial import includes all team workflow columns, including archived issues. Pending tasks use their stored due date, assignee and sprint and accrue lateness through today. When an issue reaches In Review or Done, its delivery is reconstructed from the first historical transition to **In Review**, or its completion timestamp if it went directly to Done. The historical due date, sprint and assignee are captured at delivery. The delivery and task snapshot then freeze permanently, including later rework, reassignment and sprint changes; the displayed status is the recorded status at that freeze.

Days late are calendar days in America/Argentina/Buenos_Aires. Due dates include the entire local calendar day. Four mutually exclusive groups: 1 day, 2–3 days, 4–5 days, and more than 5 days. On-time and not-yet-due tasks do not contribute. Each issue is counted once. Canceled/duplicate pending tasks are excluded. Missing dates, assignees, cycles or verified delivery timestamps are reported instead of inferred.

The student roster is explicitly configured through LINEAR_STUDENT_IDS because the NutrIA team also includes instructors. Students have zero counts where appropriate. When the allowlist is empty, all human team members and historical assignees are included; the application does not infer academic roles.

## Hybrid synchronization

Reads of sprints, graphs, attendance and justifications use Neon exclusively. Saving, editing or removing a justification refreshes the graphs without synchronizing Linear.

Run `npm run linear:import` once to bootstrap all team issues. The importer paginates and checkpoints only after a complete page is persisted. Interrupted imports resume from that checkpoint; replaying a partial page skips already frozen records. After completion, rerunning the command does not request task histories again. Metadata is cached for 24 hours.

Opening a sprint requests an authenticated `POST /api/sync?sprintId=<UUID>`. While visible, the dashboard requests periodic sync every five minutes and reads Neon every thirty seconds. Sync queries **only To Do and In Progress** in that sprint with full pagination and minimal fields. It updates new or changed issues. Known open issues missing from the complete listing are fetched individually to distinguish review/completion from moves to Backlog, another sprint, cancellation or removal. Only review/completion produces a frozen delivery. Frozen issues are never fetched individually again.

`POST /api/webhooks/linear` verifies the HMAC-SHA256 signature over the original request bytes and timestamp freshness, filters Issue events to the configured team, and deduplicates by `Linear-Delivery`. It persists each event before acknowledging HTTP 200. Processing runs through Vercel `waitUntil`; failures or unfinished events remain in Neon for the next webhook worker or periodic sprint sync. Workers process multiple batches within their execution budget; an individual failed event remains pending without starving the rest of the inbox. This endpoint uses webhook authentication instead of the teacher session and origin checks.

Database leases serialize imports, webhook workers and periodic sync across tabs and server instances. Sprint sync has a shared five-minute cooldown. Linear rate limits persist a team-wide pause until the reported reset, or fifteen minutes if no reset is supplied. A retry button respects that pause. Cached data remains readable. Other sync failures retain partial progress and allow retry after one minute.

No cron is required. When the dashboard is closed, webhooks provide updates; pending events also recover when a sprint is opened. There is no incremental scan of Backlog, Review or Done. An issue never observed in To Do/In Progress whose webhook is lost may be missed after the initial import; this is the accepted coverage limit. Pending issues imported in other columns are refreshed by webhooks. Freezing deliberately preserves original delivery accountability rather than tracking later edits.

## Configure the Linear webhook

After deploying to a public HTTPS URL:

1. In Linear workspace settings, create a webhook for **Issues** in the configured NutrIA team.
2. Set its URL to `https://<your-deployment>/api/webhooks/linear`.
3. Copy its signing secret into `LINEAR_WEBHOOK_SECRET` in Vercel for the relevant environment and redeploy.
4. Trigger a task update and verify the dashboard's pending-event count returns to zero.

Local periodic sync works without a webhook. Receiving Linear webhooks locally requires a public HTTPS tunnel. The status panel's “Configured” indicator checks the signing-secret configuration; it is not proof of a successful public delivery.

## Late task justifications

Select a student from the counts table or a chart bar, then choose **Justify** beside a late task. Select Linear error, dependency on another person's task, or another justified exception, and provide an explanation. Justifications are stored in Neon by Linear issue ID and apply across sprints, independently of the task's pending/delivered status. They do not edit the task in Linear.

Justified tasks are removed from chart counts and accountability totals by the server. They remain in the **Justified tasks** list with their reason and explanation. Edit the justification or remove it to restore the task to the counts. Pending tasks continue accruing lateness, which is used if the justification is removed. Apply migrations before using this feature (`npm run db:migrate`); no additional environment variables are needed.

## Attendance register

Record one category per student/class:

- Present
- Remote, justified
- Remote, unjustified
- Absent, justified
- Absent, unjustified

A class is identified by sprint, date and type. Saving the same student/class again updates the record rather than creating a duplicate. Editing preserves class identity; delete and recreate to correct the class date or type.

Optional notice time, justification and pre-class update provide the policy context. Planning, review and steering require presence; non-present records remain visibly flagged and keep the teacher-selected category. The app does not automatically judge explanations, infer two-hour notice compliance without class start times, or calculate grades.

Prisma models are split by table under `prisma/models`, including attendance, justifications, LinearTask, DeliveryRecord, LinearSyncState, SprintSync and WebhookEvent. SQL migrations are additive and preserve attendance and justifications. Runtime connections use the pooled URL; CLI migrations use the direct URL.

## Local demo

No external credentials are required for the explicit local demo:

    DEMO_MODE=true DASHBOARD_PASSWORD=demo-teacher SESSION_SECRET=local-demo-session-secret-at-least-32-characters npm run dev

Sign in with demo-teacher. Demo counts are illustrative and labeled. Attendance is stored in memory and resets on server restart. Demo mode is disabled when NODE_ENV=production.

## Vercel

1. Push this repository to your GitHub account and import it into Vercel.
2. Keep the root directory at the repository root. vercel.json configures Vite, the Node API functions and the SPA fallback.
3. Set the same environment variables in Vercel. Keep DEMO_MODE=false.
4. From a trusted local environment with the target Neon credentials, run `npm run db:migrate` and `npm run linear:import` before using the deployment.
5. Deploy. Verify login, sprint selection, Linear delivery data, and an attendance save/reload against Neon.

The configured Neon migrations and the initial 79-issue import were applied locally during implementation. A public Vercel deployment and its Linear webhook must still be connected by the repository owner.

Authentication uses an eight-hour signed HttpOnly/SameSite=Strict cookie, Secure in production, and origin checks for writes. Password changes invalidate existing sessions. Login attempts are limited to five per IP per fifteen minutes. In production, atomic PostgreSQL counters enforce the limit across Vercel instances; successful sign-ins reset the counter. IP addresses are HMAC-hashed before storage. Local development uses an in-memory counter. Neon and the initial migration must be configured before production sign-in works.

## Commands

    npm run test
    npm run lint
    npm run build
    npm run db:validate
    npm run db:generate
    npm run db:migrate
    npm run db:migrate:dev
    npm run linear:import

npm run preview serves only the static build. Use npm run dev for the complete local UI/API, or Vercel for the deployed application.

Prisma Client is generated by the standard Prisma CLI. Linear uses small paginated GraphQL requests; no broad SDK issue/history loader is used.

## Verification status

Unit and integration tests cover historical delivery reconstruction, calendar/bucket boundaries, authentication, attendance and justification persistence, database-only reads, resumable import, immutable deliveries, pagination failure, shared leases, webhook signature/deduplication/order handling, multiple inbox batches and durable rate-limit pauses. The real Neon migration and Linear historical import succeeded. Public webhook delivery requires the deployment configuration described above.
