# tiqX — Ticket Booking System

Backend foundation: TypeScript + Express 5 + PostgreSQL.

This repository currently contains **only** the backend and database
foundation. Temporary seat holds exist as a data model
(`reservation_holds`); the reservation API, expiry sweeping and the
concurrency rules that go with it do not. Booking, waitlists, payments, email,
QR codes, Redis, WebSockets and background workers are intentionally not
implemented yet.

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
| `reservation_holds` | a customer's temporary claim on seats of one event |
| `reservation_hold_seats` | which show seats a hold covers                |

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
`show_seats`. Temporary holds are their own entities (see below); confirmed
purchases (`bookings`) follow in a later step.

Creating an event and creating its inventory happen in a single transaction, in
`src/modules/events/event.service.ts`, so an event can never be persisted
without its seat map.

### Reservation holds

A hold is one customer's temporary claim on seats of a single event. It is
modelled as a parent row plus a junction table, so a hold can cover any number
of seats:

```
reservation_holds  HOLD-123  (event_id, user_id, status, expires_at)
        │
        └── reservation_hold_seats
              ├── A12
              ├── A13
              └── A14
```

`reservation_hold_seats` carries no `user_id`, `event_id` or `expires_at`: all
three belong to the hold and are reached through `hold_id`. Copying them into
the junction table would create a second version of the truth that could drift.

Statuses (a `CHECK`, like every other enum-like column):

| Status      | Meaning                                                    |
| ----------- | ---------------------------------------------------------- |
| `active`    | currently claims the seats; `expires_at` says until when    |
| `expired`   | ran out before it was completed                             |
| `converted` | became a confirmed booking                                  |
| `cancelled` | released deliberately before expiring                       |

Nothing transitions these automatically yet — the reservation service will.

**`expires_at` is data, not a constraint.** There is deliberately no
`CHECK (expires_at > now())`: a `CHECK` is evaluated on write and never on
read, so it could not keep a row valid as time passes. It would only make an
untouched, naturally lapsed hold impossible to update. An `active` row whose
`expires_at` is in the past is a normal, expected state.

**`ON DELETE` behaviour.**

| Foreign key                            | Behaviour  | Why                                                                                      |
| -------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `reservation_holds.event_id`           | `CASCADE`  | holds describe one event's inventory and mean nothing once it is gone                     |
| `reservation_holds.user_id`            | `CASCADE`  | a hold is a transient claim, not a financial record; it leaves with its owner              |
| `reservation_hold_seats.hold_id`       | `CASCADE`  | the association is part of the hold                                                        |
| `reservation_hold_seats.show_seat_id`  | `CASCADE`  | see below — `RESTRICT` here would break event deletion                                     |

`reservation_holds.user_id` cascades where `events.organiser_id` restricts, and
the difference is intentional: an event is a durable record other people depend
on, a hold is ephemeral. The booking a hold converts into will make its own
choice.

`reservation_hold_seats.show_seat_id` is the one place the schema departs from
the `RESTRICT` used by `show_seats.venue_seat_id`, and it is forced rather than
casual. Deleting an event cascades down two paths at once — to its `show_seats`
and to its `reservation_holds`. Under `RESTRICT` (and equally under the default
`NO ACTION`) PostgreSQL checks the `show_seats` leg before the holds leg has
cleared the junction, and deleting an event fails outright:

```
ERROR: update or delete on table "show_seats" violates foreign key constraint
DETAIL: Key (id)=(…) is still referenced from table "reservation_hold_seats".
```

`CASCADE` keeps event deletion working, and the foreign key still does the job
the design asks of it: a hold-seat row can never point at a show seat that does
not exist.

**Indexes.**

| Index                                     | Serves                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| `reservation_holds_user_id_status_idx`    | "my active holds"; also the `user_id` delete cascade      |
| `reservation_holds_event_id_status_idx`   | "holds on this event"; also the `event_id` delete cascade |
| `reservation_holds_active_expires_at_idx` | the expiry sweep, partial on `status = 'active'`          |
| `reservation_hold_seats_show_seat_id_idx` | "is this seat in any hold?"; the show-seat delete cascade |

The expiry index is partial because holds are short-lived but their rows are
not: over time nearly every row is expired, converted or cancelled, and a plain
index on `expires_at` would keep growing with rows the sweep can never match.
The predicate cannot mention `now()` — an index predicate must be immutable —
so the time bound stays in the query, which the ordered `expires_at` column
answers as a range scan.

No index is added on `hold_id` alone: the `(hold_id, show_seat_id)` primary key
already answers "which seats does this hold cover?". `show_seat_id` needs its
own index because it is the trailing column of that key.

**Not here.** Deciding who wins a contested seat is not a storage problem, so
this schema has no `hold_id`/`user_id` column on `show_seats` and no partial
unique index forbidding two active holds on one seat. The latter would also
destroy history: past holds must keep their seat lists. Concurrency is the
reservation service's job.

Design rules applied throughout:

- UUID primary keys (`gen_random_uuid()`)
- `timestamptz` columns; every connection runs with `timezone=UTC`
- foreign keys with deliberate `ON DELETE` behaviour
- `CHECK` constraints for enum-like columns (`role`, `category`, `event_type`,
  `status`) instead of PostgreSQL enum types, so values can be added in a
  migration without an `ALTER TYPE`
- unique constraints: case-insensitive user email, one physical seat per
  `(venue_id, row_label, seat_number)`, and one seat per hold via the
  `(hold_id, show_seat_id)` primary key
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
