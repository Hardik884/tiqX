# tiqX — Ticket Booking System

Backend foundation: TypeScript + Express 5 + PostgreSQL.

This repository currently contains **only** the backend and database
foundation. Booking, seat holds, waitlists, payments, email, QR codes, Redis,
WebSockets and background workers are intentionally not implemented yet.

## Requirements

- Node.js >= 20
- PostgreSQL >= 13 (`gen_random_uuid()` is used without an extension)

## Getting started

```bash
# 1. install dependencies
npm install

# 2. create your local environment file and point DATABASE_URL at your database
cp .env.example .env

# 3. create the schema
npm run migrate:up

# 4. run the API in watch mode
npm run dev
```

Production build:

```bash
npm run build
npm start
```

## Scripts

| Script                   | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `npm run dev`            | Start the API with hot reload (`tsx watch`)          |
| `npm run build`          | Type-check and emit JavaScript to `dist/`            |
| `npm start`              | Run the compiled server (`dist/server.js`)           |
| `npm run typecheck`      | Type-check `src/` and `migrations/` without emitting |
| `npm run migrate:up`     | Apply pending migrations                             |
| `npm run migrate:down`   | Roll back the most recent migration                  |
| `npm run migrate:create` | Scaffold a new TypeScript migration                  |
| `npm test`               | Run the integration test suite (needs a migrated DB)  |

## Endpoints

| Method | Path            | Description                                        |
| ------ | --------------- | -------------------------------------------------- |
| `GET`  | `/health`       | Liveness. Confirms the process is serving requests. |
| `GET`  | `/health/ready` | Readiness. Also verifies PostgreSQL is reachable.   |
| `POST` | `/api/v1/events`| Create an event and its initial seat inventory.     |

Neither endpoint returns configuration, credentials or connection details.
`/health/ready` responds `503` with `{"dependencies":{"database":"down"}}` when
the database cannot be reached; the underlying error is logged, never returned.

## Project layout

```
src/
  app.ts                   Express app assembly (no side effects)
  server.ts                startup, listening, graceful shutdown
  config/index.ts          environment loading and validation
  db/pool.ts               the single PostgreSQL connection pool
  errors/app-error.ts      client-safe error types
  middleware/              request id, 404, centralized error handler
  modules/                 feature modules (see src/modules/README.md)
  routes/index.ts          root router
  utils/logger.ts          structured JSON logger
migrations/                versioned schema migrations (node-pg-migrate)
```

## Database schema

| Table         | Purpose                                              |
| ------------- | ---------------------------------------------------- |
| `users`       | customers, organisers and admins                     |
| `venues`      | physical venues                                      |
| `venue_seats` | the physical seat layout of a venue                  |
| `events`      | movies and concerts scheduled at a venue             |
| `show_seats`  | per-event inventory state of each physical seat      |

### Physical seats vs. show seats

`venue_seats` describes the seat that physically exists in a building.
`show_seats` describes what that seat is doing for **one** event, so the same
physical seat can be `booked` for one screening and `available` for the next:

```
venue A1 ──┬── event 1 / A1  available
           └── event 2 / A1  booked
```

`UNIQUE (event_id, venue_seat_id)` makes it impossible to list the same
physical seat twice in one event's inventory.

Who is holding or has bought a seat is deliberately *not* stored on
`show_seats`. Temporary holds and confirmed purchases become their own entities
(`reservation_holds`, `bookings` and their join tables) in a later step.

Creating an event and creating its inventory happen in a single transaction, in
`src/modules/events/event.service.ts`, so an event can never be persisted
without its seat map.

Design rules applied throughout:

- UUID primary keys (`gen_random_uuid()`)
- `timestamptz` columns; every connection runs with `timezone=UTC`
- foreign keys with deliberate `ON DELETE` behaviour
- `CHECK` constraints for enum-like columns (`role`, `category`, `event_type`,
  `status`) instead of PostgreSQL enum types, so values can be added in a
  migration without an `ALTER TYPE`
- unique constraints: case-insensitive user email, and one physical seat per
  `(venue_id, row_label, seat_number)`
- indexes on foreign keys and on the columns real queries filter by
- `updated_at` maintained by a database trigger, not by application code

## Tests

The suite is integration-level: it exercises the real schema, so it needs a
running PostgreSQL with migrations applied.

```bash
cp .env.example .env   # DATABASE_URL must point at a database you can write to
npm run migrate:up
npm test
```

Tests create their own venues and organisers and delete them afterwards.
