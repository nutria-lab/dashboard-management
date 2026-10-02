# Lab II · NutrIA dashboard

Teacher dashboard for Linear task deliveries and class attendance. React + Vite + TypeScript, a Node API, Prisma 7 and Neon PostgreSQL.

## Setup

Use Node 24 LTS and npm. The repository is local; no GitHub remote is configured.

    npm ci
    cp .env.example .env

Fill .env:

- LINEAR_API_KEY: a read-only Linear API key with access to the NutrIA team. Used only by the server.
- LINEAR_TEAM_ID and LINEAR_REVIEW_STATE_ID: prefilled IDs verified for NutrIA and its In Review state.
- LINEAR_STUDENT_IDS: comma-separated student user IDs, prefilled for Lara, Fer and Majo. Adjust the roster here; leave empty to include all human team members.
- DATABASE_URL: Neon pooled PostgreSQL URL with SSL parameters.
- DIRECT_URL: Neon direct PostgreSQL URL for migration commands.
- DASHBOARD_PASSWORD: the shared teacher password.
- SESSION_SECRET: at least 32 random characters. Generate with openssl rand -hex 32.

Then:

    npm run db:generate
    npm run db:migrate
    npm run dev

The UI runs on http://localhost:5173; /api is proxied to the local Node server on port 3001. Migrations are applied only when you run the migration command. The build generates Prisma and does not migrate any database.

## Delivery rules

The first historical transition to **In Review** is the delivery, regardless of subsequent rework or approval time. Days late are calendar days in America/Argentina/Buenos_Aires, relative to the due date at delivery. Due dates include the entire local calendar day.

Four mutually exclusive groups: 1 day, 2–3 days, 4–5 days, and more than 5 days. On-time tasks do not contribute. The first Review transition is counted once. The historical cycle and assignee determine the sprint and student. Current canceled/duplicate tasks are excluded.

All team issues and their histories are paginated, including archived issues. Missing dates, assignees, cycles or Review events are reported rather than inferred from Done. Tasks moved to a different team cannot be discovered by the original team's issue listing.

The student roster is explicitly configured through LINEAR_STUDENT_IDS because the NutrIA team also includes instructors. Students have zero counts where appropriate. When the allowlist is empty, all human team members and historical assignees are included; the application does not infer academic roles.

## Attendance

Record one category per student/class:

- Present
- Remote, justified
- Remote, unjustified
- Absent, justified
- Absent, unjustified

A class is identified by sprint, date and type. Saving the same student/class again updates the record rather than creating a duplicate. Editing preserves class identity; delete and recreate to correct the class date or type.

Optional notice time, justification and pre-class update provide the policy context. Planning, review and steering require presence; non-present records remain visibly flagged and keep the teacher-selected category. The app does not automatically judge explanations, infer two-hour notice compliance without class start times, or calculate grades.

Prisma stores Student, Sprint, ClassSession, Attendance and LoginAttempt in separate model files. The initial SQL migration and migration lock are committed. Runtime connections use the pooled URL; CLI migrations use the direct URL.

## Local demo

No external credentials are required for the explicit local demo:

    DEMO_MODE=true DASHBOARD_PASSWORD=demo-teacher SESSION_SECRET=local-demo-session-secret-at-least-32-characters npm run dev

Sign in with demo-teacher. Demo counts are illustrative and labeled. Attendance is stored in memory and resets on server restart. Demo mode is disabled when NODE_ENV=production.

## Vercel

1. Push this repository to your GitHub account and import it into Vercel.
2. Keep the root directory at the repository root. vercel.json configures Vite, the four Node API functions and the SPA fallback.
3. Set the same environment variables in Vercel. Keep DEMO_MODE=false.
4. From a trusted local environment with the target Neon credentials, run npm run db:migrate before the first deployment.
5. Deploy. Verify login, sprint selection, Linear delivery data, and an attendance save/reload against Neon.

No deploy or database migration was executed by the implementation workflow.

Authentication uses an eight-hour signed HttpOnly/SameSite=Strict cookie, Secure in production, and origin checks for writes. Password changes invalidate existing sessions. Login attempts are limited to five per IP per fifteen minutes. In production, atomic PostgreSQL counters enforce the limit across Vercel instances; successful sign-ins reset the counter. IP addresses are HMAC-hashed before storage. Local development uses an in-memory counter. Neon and the initial migration must be configured before production sign-in works.

## Commands

    npm run test
    npm run lint
    npm run build
    npm run db:validate
    npm run db:generate
    npm run db:migrate
    npm run db:migrate:dev

npm run preview serves only the static build. Use npm run dev for the complete local UI/API, or Vercel for the deployed application.

The Linear SDK's API types and Prisma Client are generated by their standard tooling. No manually maintained GraphQL schema or database client is needed.

## Verification status

Unit and integration tests cover historical delivery reconstruction, calendar/bucket boundaries, authentication and attendance validation/upserts. Browser checks use the explicit local demo. Live Linear API-key access and Neon persistence require your credentials and remain unverified until configured.
