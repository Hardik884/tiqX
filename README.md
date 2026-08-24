# tiqX

A ticket booking platform for movies and concerts: event discovery, a live
visual seat map, seat holds with a countdown, booking confirmation with
QR-coded tickets emailed automatically, cancellation, and a FIFO waitlist
with time-limited offers when a seat frees up. Backend in TypeScript/Express
on PostgreSQL and Redis; two separate React frontends for customers and for
organisers/admins.

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
- **Organiser/admin dashboard** — event management, per-event booking
  summaries, and account-wide totals.

Not implemented: payments (confirming a hold does not charge anything —
see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)), venue/seat-map creation
through the product (venues are currently provisioned directly in the
database), and password reset.

## Architecture overview

```
                     ┌─────────────────┐        ┌──────────────────────┐
customer-frontend ─▶ │                 │        │                      │
 (React/Vite)        │   Express API   │◀──────▶│      PostgreSQL      │
                     │  (+ /ws server) │        │  (source of truth)   │
frontend ──────────▶ │                 │        │                      │
 (organiser/admin)   └────────┬────────┘        └──────────┬───────────┘
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
| Organiser/admin frontend | React 18, Vite, TypeScript, plain CSS |

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
tests/                     integration tests (real PostgreSQL + Redis)
customer-frontend/         customer-facing booking app (React/Vite/Tailwind)
frontend/                  organiser/admin dashboard (React/Vite)
docs/                      API.md, DATABASE.md, ARCHITECTURE.md, SYSTEM_DESIGN.md
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
cd frontend && npm install && cd ..
```

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

## Starting the organiser/admin frontend

```bash
cd frontend
npm run dev
```

Also defaults to port `5173` — Vite will pick the next free port
automatically if the customer frontend is already running. Proxies `/api`
to `http://localhost:4000` by default, overridable with `VITE_BACKEND_URL`.

## Running tests / typecheck / build

```bash
# backend
npm run typecheck     # tsc, no emit
npm test              # integration suite — needs a migrated PostgreSQL and a running Redis
npm run build          # emits to dist/

# each frontend (from customer-frontend/ or frontend/)
npm run build          # type-checks and produces a production build in dist/
```

The backend test suite is integration-level against real PostgreSQL and
Redis on purpose — see the suite's own notes in `tests/` for why (an
in-memory stand-in would prove nothing about the row-locking and
atomicity this system depends on).

## Production deployment overview

There is no Dockerfile or CI pipeline in this repository yet — deploying
today means provisioning the pieces below directly:

1. Managed PostgreSQL and Redis (set `DATABASE_SSL=true` and a `rediss://`
   URL if your providers require TLS).
2. Run `npm run migrate:up` against production `DATABASE_URL` before first
   deploy and on every schema change.
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
6. Build each frontend (`npm run build` in `customer-frontend/` and
   `frontend/`) and serve the resulting `dist/` as static files, pointed at
   the deployed API's real origin.
7. Point `/health` and `/health/ready` at your load balancer's liveness and
   readiness checks respectively.

## Further reading

- [docs/API.md](docs/API.md) — full endpoint reference
- [docs/DATABASE.md](docs/DATABASE.md) — schema, constraints, ER diagram
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — seat holds and the waitlist, explained in depth
- [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md) — condensed system-design write-up
- [src/modules/README.md](src/modules/README.md) — backend module conventions
