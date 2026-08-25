# tiqX

A ticket booking platform for movies and concerts: event discovery, a live
visual seat map, seat holds with a countdown, booking confirmation with
QR-coded tickets emailed automatically, cancellation, and a FIFO waitlist
with time-limited offers when a seat frees up. Backend in TypeScript/Express
on PostgreSQL and Redis; one React frontend serving customers, organisers and
admins from a single deployment.

## Reviewing this project

**Live app: https://tiq-x.vercel.app** — customer, organiser and admin are all
one deployment, so every role signs in at the same `/login`:

| Role | Email | Where it takes you |
| --- | --- | --- |
| Admin | `admin@tiqx.demo` | **Admin** in the header, or `/admin` |
| Organiser | `organiser@tiqx.demo` | **Organiser** in the header, or `/organiser` |
| Customer | `customer@tiqx.demo` | browse and book from `/` |

<!-- Shared sign-in secret for the three accounts above: SEE SUBMISSION NOTES.
     Deliberately not committed - it is a live credential, and anything written
     here is public forever, including in the history after it is rotated. -->

The header only shows a workspace to a role that has it, and typing `/admin`
as a customer redirects home — the API answers `403` to the same request
regardless, which is the check that actually matters.

Worth trying, in about five minutes:

1. **Customer** — pick an event from the home page, select seats, and watch the
   hold countdown start. Confirm, and the booking comes back with QR tickets;
   cancel it and the seats go straight back into the map. Open the same event
   in a second window to see a seat flip to *held* in real time.
2. **Organiser** — the dashboard totals come from the API, not the browser.
   **Create event** takes a venue, a date/time and a price per seat category;
   save it as a draft, publish it from the event page, then check
   **Bookings & revenue** for anything a customer just booked.
3. **Admin** — **Venues** builds a seat layout a row at a time and switches any
   seat between premium and standard; **People** promotes an account to
   organiser (registration never accepts a role from the client, so this is how
   organisers come to exist); **Events** lists every organiser's events.

Anyone can register at `/register` — new accounts are always customers, and the
sign-up page links through to both workspaces.

### Running it yourself

Follow [Installation](#installation) through [Running migrations](#running-migrations),
then create the same three accounts, a venue with a premium/standard seat
layout, and some events to book:

```bash
DEMO_PASSWORD='pick-something-12-chars-or-more' npm run seed:demo
```

Omit `DEMO_PASSWORD` and one is generated and printed once — nothing is stored
in the repository either way. The seed is safe to re-run: each step creates
what is missing and leaves everything else alone, and it will not touch a
`NODE_ENV=production` database without `--force`.

Then start the API (`npm run dev`), the workers, and the frontend
(`cd customer-frontend && npm run dev`), and sign in with any of the three
accounts above.

## Main features

- **Auth** — registration, login, short-lived access tokens + rotating
  revocable refresh tokens, role-based access (`customer`/`organiser`/`admin`).
- **Event discovery** — full-text search, category/city/date filters,
  sorting, cursor-based pagination.
- **Live seat map** — available/held/booked seats, pushed in real time over
  WebSocket as other customers hold, release, or book seats.
- **Seat holds** — a short-lived, row-locked claim on 1-10 seats with a TTL
  countdown, safe under concurrent requests for the same seat.
- **Booking + cancellation** — idempotent confirmation and cancellation,
  with seats released back to inventory (and the waitlist notified) on
  cancellation.
- **Tickets & QR** — one ticket per seat, issued automatically at
  confirmation and emailed via a durable outbox (Resend or a mock provider).
- **Waitlist** — join a sold-out event/category, FIFO time-limited offers
  when a seat opens up, accept-to-book in one step.
- **Organiser workspace** — create and publish events, pick a venue, set the
  date/time and per-category seat pricing, and read per-event booking,
  revenue and seat-map figures alongside account-wide totals.
- **Admin workspace** — platform-wide totals, venue creation and seat-layout
  management (premium/standard categories), every organiser's events, and
  account role management.

Not implemented: payments (confirming a hold does not charge anything —
see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)) and password reset.

## Architecture overview

```
                     ┌─────────────────┐        ┌──────────────────────┐
customer-frontend ─▶ │                 │        │                      │
 (React/Vite —       │   Express API   │◀──────▶│      PostgreSQL      │
  customer +         │  (+ /ws server) │        │  (source of truth)   │
  organiser +        │                 │        │                      │
  admin)             └────────┬────────┘        └──────────┬───────────┘
                              │                             │
                              ▼                             │
                     ┌─────────────────┐                    │
                     │      Redis      │                    │
                     │ rate limits,    │                    │
                     │ pub/sub, expiry │                    │
                     │ signal keys     │                    │
                     └────────▲────────┘                    │
                              │                              │
              ┌───────────────┼──────────────┐               │
              │               │              │               │
     hold-expiration   waitlist-allocation  realtime-seat-status
        worker              worker              worker
              └───────────────┴──────────────┴───────────────┘
                    all three read/write PostgreSQL directly
```

PostgreSQL is authoritative for every fact — seat status, hold/booking/
waitlist state, idempotency, sessions. Redis never decides anything; it
carries derived signals (rate-limit counters, expiry-timer keys, pub/sub for
the WebSocket feed) that could be deleted entirely without corrupting a
booking. Every cross-system effect (a Redis key, an email, a WebSocket
broadcast) is queued as a durable outbox row in the same transaction as the
domain change, then delivered by a background worker with retry/backoff. See
[docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md) for the full mechanism.

## Tech stack

| Layer | Stack |
| --- | --- |
| API | Node.js 20+, TypeScript, Express 5, `pg`, `ioredis`, `ws`, `jose` (JWT), `zod`, `@node-rs/argon2` |
| Database | PostgreSQL 13+ (migrations via `node-pg-migrate`) |
| Cache / signals | Redis 6+ |
| Email | Resend (or a `mock` provider for local dev — no API key needed) |
| Customer frontend | React 18, Vite, TypeScript, Tailwind CSS, Zustand, `qrcode` |

## Repository structure

```
src/
  app.ts                 Express app assembly (no side effects)
  server.ts              startup, HTTP + WebSocket listening, graceful shutdown
  config/index.ts         environment loading and validation (fails fast on bad config)
  db/pool.ts               the single PostgreSQL connection pool
  redis/                   Redis client and key helpers
  realtime/                WebSocket server, auth, subscriptions
  errors/app-error.ts      client-safe error types
  middleware/              request id, auth, rate limiting, error handling
  modules/                 feature modules — see src/modules/README.md
  routes/index.ts          root router (mounts every module)
  workers/                 the three background worker entry points
  utils/logger.ts          structured JSON logger
migrations/                versioned schema migrations (node-pg-migrate)
scripts/                   seed-demo.ts — the reviewer/demo data seed
tests/                     integration tests (real PostgreSQL + Redis)
customer-frontend/         the tiqX web app — customer, organiser and admin
                           (React/Vite/Tailwind, one deployment)
frontend/                  superseded standalone organiser/admin dashboard;
                           kept for reference, not deployed or built
docs/                      API.md, DATABASE.md, ARCHITECTURE.md, SYSTEM_DESIGN.md
.github/workflows/         CI — see CI/CD below
```

## Prerequisites

- Node.js >= 20
- PostgreSQL >= 13 (`gen_random_uuid()` is used without an extension)
- Redis >= 6 — the API refuses to start without a reachable `REDIS_URL`
- A [Resend](https://resend.com) API key, only if you want real ticket
  emails instead of the mock provider

## Installation

```bash
git clone https://github.com/Hardik884/tiqX.git
cd tiqX
npm install                       # backend
cd customer-frontend && npm install && cd ..
```

(`frontend/` is the superseded standalone dashboard — see
[Repository structure](#repository-structure) — and does not need installing
to run tiqX.)

## Environment setup

```bash
cp .env.example .env
```

Then edit `.env` and set at minimum: `DATABASE_URL`, `REDIS_URL`, and a real
`JWT_SECRET` (32+ random characters — the placeholder value is rejected on
purpose so an unedited copy fails fast instead of signing tokens insecurely).
Every environment variable the backend reads is listed in
[.env.example](.env.example) with a comment explaining what it does, grouped
by: application, PostgreSQL, authentication, Redis, rate limiting, ticket
email, hold-expiration worker, waitlist allocation worker, and real-time
(WebSocket) tuning. Nothing outside that file is required.

## PostgreSQL setup

Any reachable PostgreSQL 13+ instance works. Locally:

```bash
docker run -d --name tiqx-postgres -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=tiqx postgres:16-alpine
```

Point `DATABASE_URL` at it (the `.env.example` default already matches the
command above), then run migrations (below).

## Redis setup

```bash
docker run -d --name tiqx-redis -p 6379:6379 redis:7-alpine
redis-cli ping   # -> PONG
```

## Running migrations

```bash
npm run migrate:up      # apply every pending migration
npm run migrate:down    # roll back the most recent one
```

See [docs/DATABASE.md](docs/DATABASE.md) for the resulting schema.

## Starting the API

```bash
npm run dev     # tsx watch, hot reload
# or, for a production-style run:
npm run build && npm start
```

Listens on `PORT` (default `4000`). The WebSocket server for real-time seat
status is attached to the same HTTP server, at `/ws`.

## Starting the workers

Three independent, long-running processes, each with a `:dev` (hot-reload)
variant. All three read and write PostgreSQL directly and only ever *signal*
through Redis — the API stays fully correct if any of them is temporarily
down (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

```bash
npm run worker            # hold expiration sweep + Redis publish + ticket-email delivery
npm run worker:waitlist   # waitlist allocation: pairs freed seats with queued candidates
npm run worker:realtime   # publishes seat status changes to Redis for the WebSocket layer to fan out
```

All three (plus the API) need to be running for the product to behave as
designed — a customer-visible symptom of a stopped worker is a hold that
never releases its seat back to `available` on screen, or a waitlist offer
that never arrives.

## Starting the customer frontend

```bash
cd customer-frontend
npm run dev
```

Runs on `http://localhost:5173` and proxies `/api` and `/ws` to
`http://localhost:4000` (see `customer-frontend/vite.config.ts`) — no
additional configuration needed against a locally running API.

The organiser workspace lives at `/organiser` and the admin workspace at
`/admin` inside the same app — there is no second frontend to start. The
older standalone dashboard in `frontend/` has been superseded by these
routes and is no longer built or deployed.

Everyone registers as a customer; an admin promotes an account to
`organiser` (or `admin`) from **Admin → People**. The first admin cannot come
from there - there is no account to promote them from - so `npm run seed:demo`
creates one (see [Reviewing this project](#reviewing-this-project)). To make an
existing account an admin instead:

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
```

## Running tests / typecheck / build

```bash
# backend
npm run typecheck     # tsc, no emit
npm test              # integration suite — needs a migrated PostgreSQL and a running Redis
npm run build          # emits to dist/

# frontend (from customer-frontend/)
npm run build          # type-checks and produces a production build in dist/
```

The backend test suite is integration-level against real PostgreSQL and
Redis on purpose — see the suite's own notes in `tests/` for why (an
in-memory stand-in would prove nothing about the row-locking and
atomicity this system depends on).

## Production deployment overview

The unified frontend (`customer-frontend/` — customer booking plus the
`/organiser` and `/admin` workspaces) is deployed on **Vercel**; the API and
workers (`src/`) are deployed on **Render**; PostgreSQL and Redis are
managed production services. See [CI/CD](#cicd) below for how a change gets
from a pull request to production. Provisioning notes:

1. Managed PostgreSQL and Redis (set `DATABASE_SSL=true` and a `rediss://`
   URL if your providers require TLS).
2. Run `npm run migrate:up` against production `DATABASE_URL` before first
   deploy and on every schema change (see [Production migrations](#production-migrations)
   below for how this runs automatically on Render).
3. Build and run the API (`npm run build && npm start`) with `NODE_ENV=production`,
   a real random `JWT_SECRET`, `CORS_ORIGIN` restricted to your actual
   frontend origins, and `TRUST_PROXY=true` only if you're behind a reverse
   proxy that sets `X-Forwarded-For` itself.
4. Run all three workers (`npm run worker`, `worker:waitlist`,
   `worker:realtime`) as their own long-lived processes — a process manager
   or container per worker, not a thread inside the API process.
5. Set `EMAIL_PROVIDER=resend` with a real `RESEND_API_KEY` and a verified
   sending domain for `EMAIL_FROM` (a Resend *sandbox* address only
   delivers to the account owner, not real customers).
6. Build the frontend (`npm run build` in `customer-frontend/`) and serve
   the resulting `dist/` as static files, with a single-page-app fallback so
   `/organiser/*` and `/admin/*` resolve on a direct hit. The deployed setup
   is a Vercel project rooted at `customer-frontend/`, whose `vercel.json`
   rewrites `/api/*` to the API's origin and everything else to
   `index.html`; the real-time client connects straight to the API's own
   `wss://.../ws` rather than through that rewrite (a WebSocket upgrade does
   not survive an HTTP-layer proxy — see `src/lib/seatSocket.ts`).
7. Point `/health` and `/health/ready` at your load balancer's liveness and
   readiness checks respectively.

## CI/CD

```
PR  →  GitHub Actions CI  →  merge to main  →  Vercel/Render deployment  →  production migrations  →  production
```

**On every pull request and every push to `main`**, [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
runs two jobs in parallel — see that file for the exact commands:

| Job | What it runs | Against |
| --- | --- | --- |
| `backend` | `npm ci`, `npm run migrate:up`, `npm run typecheck`, `npm run build`, `npm test` | disposable PostgreSQL 16 + Redis 7 [GitHub Actions services](https://docs.github.com/en/actions/using-containerized-services/about-service-containers), created fresh per run |
| `frontend` (`customer-frontend/`) | `npm ci`, `npm run build` (type-checks via `tsc --noEmit`, then `vite build`) | — |

`frontend/`, the superseded standalone dashboard (see `frontend/README.md`),
is not built in CI for the same reason it is not deployed: nothing runs it
any more. Any job failing fails the whole workflow. The backend suite is
integration-level by design (see [Running tests / typecheck / build](#running-tests--typecheck--build)),
so CI gives it a real, ephemeral PostgreSQL/Redis rather than mocking either
— never a production database or a production Redis instance. `JWT_SECRET`
and the CI `DATABASE_URL`/`REDIS_URL` in the workflow are throwaway values
scoped to that one run, not secrets, and are not accepted as valid
production values (`src/config/index.ts` rejects placeholder secrets).

**Merging to `main` is the actual gate.** The pull-request run is what
keeps broken code out — configure `backend` and `frontend` as required
status checks under the repository's branch protection settings for `main`
so a PR cannot merge while either is red. Once on `main`:

- **Frontend deployment** — Vercel's own Git integration builds and
  deploys `customer-frontend/` (the unified frontend) whenever `main`
  updates; there is no separate Vercel step in this workflow, so the same
  app is never deployed twice. If that Git integration is ever
  disconnected, the fallback is the [Vercel CLI](https://vercel.com/docs/cli)
  run manually or from a new job using `VERCEL_TOKEN`/`VERCEL_ORG_ID`/`VERCEL_PROJECT_ID`
  secrets — not needed today.
- **Backend deployment** — Render's own Git integration builds and deploys
  `src/` whenever `main` updates, the same way. If that is ever
  disconnected, the fallback is a `RENDER_DEPLOY_HOOK_URL` GitHub secret
  and a minimal `curl` step; again, not needed today.

### Production migrations

`npm run migrate:up` must only ever run against the production
`DATABASE_URL`, and never as part of the PR/main CI run above (CI only
migrates its own disposable database). Point Render's **Pre-Deploy
Command** for the backend service at:

```
npm run migrate:up
```

Render runs this before each deploy, using the `DATABASE_URL` already
configured in that service's own environment — the production connection
string never appears in a workflow file or a GitHub secret. If a
Render plan doesn't support a pre-deploy command, run
`npm run migrate:up` manually against production `DATABASE_URL` (e.g. from
a trusted machine or Render's shell) before triggering that deploy — the
one thing to avoid is a service starting against a schema its code
doesn't match yet.

### Secrets

Nothing in `.github/workflows/ci.yml` needs a GitHub secret — every value
it uses is a disposable CI-only credential for services it creates itself.
Secrets only enter the picture if a fallback above is ever needed:

| Secret | Where it lives | Needed for |
| --- | --- | --- |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | GitHub repo secrets | only if Vercel's Git integration is disconnected and a manual CLI deploy step is added |
| `RENDER_DEPLOY_HOOK_URL` | GitHub repo secrets | only if Render's Git integration is disconnected and a manual deploy-hook step is added |
| `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, `RESEND_API_KEY`/`BREVO_API_KEY` | Render service environment (and Vercel, where relevant) | production runtime only — never set these in a GitHub Actions workflow or secret |

### Investigating a failed deployment

1. **PR/main CI red** — open the failing job in the Actions tab; it names
   which of typecheck/build/test/migrate failed and why. Nothing here talks
   to production, so a CI failure never risks it.
2. **Vercel build failed** — check the deployment's build log in the Vercel
   dashboard; it only affects `customer-frontend/`.
3. **Render deploy failed** — check the service's deploy log in the Render
   dashboard. A pre-deploy command failure (e.g. a broken migration) blocks
   that deploy, which is the point — the running production instance keeps
   serving the previous, working release until a fix lands.
4. **Migration failed on Render** — read the pre-deploy log for the failing
   migration, fix it in a new PR (through CI as usual — see
   [Running migrations](#running-migrations) for `migrate:down`
   semantics), and let the corrected deploy retry the pre-deploy command.

## Further reading

- [docs/API.md](docs/API.md) — full endpoint reference
- [docs/DATABASE.md](docs/DATABASE.md) — schema, constraints, ER diagram
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — seat holds and the waitlist, explained in depth
- [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md) — condensed system-design write-up
- [src/modules/README.md](src/modules/README.md) — backend module conventions
