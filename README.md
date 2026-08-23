# tiqX — Ticket Booking System

Backend foundation: TypeScript + Express 5 + PostgreSQL.

This repository currently contains the backend foundation, the database
schema, and the transactional reservation primitive that hands out temporary
seat holds. Booking, payments, waitlists, hold-expiry sweeping, email, QR
codes, Redis, WebSockets, background workers and authentication are
intentionally not implemented yet.

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
| `POST` | `/api/v1/auth/register` | Create a customer account.                  |
| `POST` | `/api/v1/auth/login`    | Exchange credentials for a token pair.      |
| `POST` | `/api/v1/auth/refresh`  | Rotate a refresh token for a new pair.      |
| `POST` | `/api/v1/auth/logout`   | Revoke a refresh token.                     |
| `GET`  | `/api/v1/auth/me`       | The authenticated principal. **Auth.**      |
| `POST` | `/api/v1/events`| Create an event and its inventory. **Organiser/admin.** |
| `POST` | `/api/v1/events/:eventId/holds` | Temporarily hold seats. **Auth.**   |

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
| `idempotency_keys` | stored responses that make a retried write safe to repeat |
| `refresh_tokens` | server-side session state; stores digests, never tokens |

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

## Placing a hold

`POST /api/v1/events/:eventId/holds` holds a seat selection for one customer.

```jsonc
// request
{ "userId": "<uuid>", "showSeatIds": ["<uuid>", "<uuid>"], "ttlSeconds": 600 }

// 201 response
{ "holdId": "<uuid>", "eventId": "<uuid>", "showSeatIds": ["<uuid>", "<uuid>"],
  "status": "active", "expiresAt": "2026-08-23T11:40:00.000Z" }
```

`Idempotency-Key` is **required** — see [Idempotency](#idempotency) below.
So is `Authorization: Bearer <access-token>` — see [Authentication](#authentication).

The hold's owner is the authenticated principal. There is **no `userId` field**:
the schema is strict, so a client still sending one gets a `400` rather than
having it silently ignored.

Bounds: 1–10 seats, no duplicates, `ttlSeconds` 60–900 (default 600). The client
supplies a *duration*; `expires_at` is computed by PostgreSQL from its own clock,
so a wrong app-server clock cannot mint a long-lived hold.

| Status | When                                                          |
| ------ | ------------------------------------------------------------- |
| `201`  | every requested seat was held                                  |
| `400`  | invalid payload, or a seat belonging to a different event      |
| `404`  | event, user, or seat does not exist                            |
| `409`  | a requested seat is booked or under a live hold                |
| `500`  | unexpected failure; the client sees no PostgreSQL detail       |

### All or nothing

If any one seat is unavailable, the whole request fails and *nothing* changes —
no hold row, no links, no seat flipped. That is not compensating logic, it is
the transaction: every rejection throws, `withTransaction` rolls back, and the
database discards the attempt.

```
request A12, A13, A14 with A13 taken  ->  409, and A12/A14 stay available
```

### How concurrency is handled

One transaction, and PostgreSQL row locks as the only arbiter — no application
mutex, no Redis, no advisory locks:

```
BEGIN
  event exists?  user exists?
  SELECT ... FROM show_seats
   WHERE id = ANY($1) AND event_id = $2
   ORDER BY id
   FOR UPDATE                  <- competing requests serialise here
  every requested seat came back? (else 404 / 400)
  expire lapsed holds on these seats, and free their seats
  re-read availability; any seat still taken -> 409
  INSERT reservation_holds (expires_at = now() + ttl)
  INSERT reservation_hold_seats
  UPDATE show_seats SET status = 'held'
COMMIT
```

Three things make this safe:

- **`FOR UPDATE`** blocks every other transaction that wants the same seat until
  this one ends. A blocked transaction re-reads the row *after* the lock is
  granted, so it observes the winner's result rather than the stale value it
  would have read before waiting.
- **`ORDER BY id`** fixes the order locks are taken in, so overlapping requests
  queue in the same direction and cannot form a lock cycle. `EXPLAIN` confirms
  the plan places `LockRows` above `Sort` — rows are locked in sorted order, not
  locked and then sorted. The expiry step locks its hold rows through an ordered
  `SELECT ... FOR UPDATE` sub-select for the same reason, since `UPDATE` cannot
  take an `ORDER BY`.
- **`event_id` in the locking query** is the ownership check, so a client cannot
  reach a seat belonging to another event.

### Reclaiming a lapsed hold

Nothing rewrites a hold when its `expires_at` passes, so a lapsed hold still
reads `active`. Whoever next wants the seat performs the transition, inside the
same transaction and under the same seat locks:

```
mark the old hold expired  ->  free the seat  ->  acquire it for the new hold
```

Correctness therefore does not depend on a background worker; the future worker
is only a tidy-up for rows nobody asked for. A hold that is still alive by the
database's clock is never touched.

## Idempotency

Every hold request must carry a header:

```
Idempotency-Key: <printable ASCII, 1-255 chars>
```

Missing, empty, oversized, repeated or malformed keys are rejected with `400`.
The server never invents a key: one it generated would differ on every retry,
defeating the point.

Retrying the same logical request with the same key returns the **stored
response** — same status, same body, same `holdId`, same `expiresAt` — and runs
no reservation logic at all.

### What makes two requests "the same"

Not the bytes. A SHA-256 digest is taken over a canonical form of the fields
that change what the operation does:

```
sha256({ v:1, userId, eventId, showSeatIds sorted, ttlSeconds })
```

Key order, whitespace and seat order are presentation, so `["A13","A12"]` and
`["A12","A13"]` are the same request and replay correctly. A key reused with a
different selection, ttl or event is refused with `409` and
`details.reason = "idempotency_key_reuse"` — answering it with the old response
would be worse than refusing.

Keys are scoped `UNIQUE (user_id, key)`, never globally. Two customers may pick
the same string without colliding, and one customer's key can never read
another's stored response.

### One transaction

The claim, the hold and the stored response all commit together:

```
BEGIN
  INSERT INTO idempotency_keys (...) VALUES (..., 'processing')
    ON CONFLICT (user_id, key) DO NOTHING RETURNING id
  ...the whole reservation, on this same client...
  UPDATE idempotency_keys SET status='completed', response_status, response_body
COMMIT
```

Claiming the key in one transaction and saving the result in another would
leave a window where the hold is durable but the record is not — a crash there
and the retry creates a second hold. Here there is no window.

### Concurrent duplicates

The unique index *is* the lock. A second request carrying the same key does not
fail fast and does not race ahead — its insert **waits** on the index until the
first transaction ends, then reacts to what actually happened:

| First transaction | Second request |
| ----------------- | --------------- |
| committed         | insert returns no row → read the record → replay its response |
| rolled back       | insert succeeds → take the key over and do the work |

Measured directly: with the first transaction held open 3s, the second insert
blocked ~2s and then read `completed`. Because the coordination lives in the
index, it holds across processes — two API instances behave exactly like two
connections from one. An in-memory map could not make that claim.

`processing` is therefore a state a row only occupies *inside* the transaction
that owns it; any committed row is already `completed`. A committed
`processing` row would mean an attempt died in a way this design does not
produce, so it is answered with `409 idempotency_key_in_flight` rather than a
guess.

### Failure semantics

**A failed request stores nothing.** The throw rolls back the claim along with
the hold, and the key is free again. So:

- a retry after a failure is a genuine new attempt, not a replayed error;
- a failure can never be stored as a success that never happened.

The tradeoff is deliberate: a `409` is not replayed. Persisting it would mean
committing the record in a separate transaction from the rolled-back hold —
exactly the split this design exists to avoid. It is also friendlier: a seat
that was taken a moment ago may since have been released, and the retry should
be allowed to get it.

## Authentication

Identity is established by the server, never asserted by the client.

```
HTTP -> request-id -> requireAuth -> requireRole -> controller -> service -> repository
```

`requireAuth` answers *who is this*; `requireRole` answers *may they*. Keeping
them separate is why no controller contains a role check.

### Passwords

Argon2id (`@node-rs/argon2`) at the OWASP baseline — 19 MiB memory, 2 passes, 1
lane. A general-purpose hash like SHA-256 is built to be fast, which is exactly
wrong for passwords: speed is the attacker's budget, and the memory cost is what
makes GPU cracking expensive. Parameters live inside the digest, so they can be
raised later without invalidating existing hashes. Verification always goes
through the library's own constant-time comparison.

Registration takes `{ email, password }` (plus an optional `name`, defaulted
from the email's local part because `users.name` is `NOT NULL`). **`role` is
never accepted from a client** — every account starts as `customer`.

### Login is deliberately uninformative

Wrong password and unknown email return a byte-identical response:

```json
{ "error": { "code": "INVALID_CREDENTIALS", "message": "Invalid credentials" } }
```

Three things had to be true for that to hold, and all three are tested:

- the **timing** matches — an unknown email still pays for one Argon2
  verification, against a decoy digest, so response time does not reveal
  whether an address is registered;
- the **response** carries no stack — the error handler omits it for any
  deliberate `AppError`, because the trace's line number alone distinguished
  the two branches;
- the **log line** carries no stack either, for the same reason. Anyone with
  log access would otherwise have the oracle the API denies them.

### Access tokens

Short-lived JWTs, HS256, signed with `JWT_SECRET`. Claims are `sub`, `role`,
`iss`, `aud`, `iat`, `exp`, `jti` — and nothing else. A JWT is signed, not
encrypted, so email and user detail stay out of it.

Verification pins the algorithm and checks issuer and audience. Pinning matters:
without it a token can ask to be verified as `alg: none`. Both forgeries are
tested.

The middleware **re-reads the user** on every request rather than trusting the
token wholesale. A JWT is a snapshot; without the re-read, a deleted account or
a demoted organiser would keep their old powers until expiry. The database is
the authority on role, and the token's claim only reflects it.

`JWT_SECRET` is required, must be ≥32 characters, and the placeholder shipped in
`.env.example` is rejected by name — an unedited copy fails fast instead of
signing tokens with a value that is public in this repository.

### Refresh tokens

32 random bytes, base64url. Deliberately **not** a JWT: a self-describing token
is honoured on its contents alone, which is what makes revocation impossible.
This one means nothing except as a lookup into a row the server controls.

Only a SHA-256 digest is stored. Plain SHA-256 rather than Argon2 is correct
here — the input is 256 bits of uniform randomness, so there is no dictionary to
grind and no benefit to a slow KDF; what matters is that the stored value is not
itself a usable credential.

Rotation is one locked transaction:

```
BEGIN
  SELECT ... WHERE token_hash = $1 FOR UPDATE
  reject if missing / revoked / expired
  UPDATE ... SET revoked_at = now()
  INSERT replacement, rotated_from -> old row
COMMIT
```

`FOR UPDATE` is what makes "a refresh token works exactly once" true under
concurrency — two simultaneous refreshes serialise and the second finds the
token revoked. A failed rotation rolls back entirely, leaving the original
usable rather than stranding the caller with nothing. Both are tested.

**Reuse detection.** A token that is found but already revoked has been
presented twice. Benignly that is a client retry; otherwise it leaked. The two
are indistinguishable from the server, so every live token for that user is
revoked and the caller refused. Note this revocation commits in its *own*
transaction — performing it inside the rotation transaction and then throwing
would roll it back, which is a bug this code had until a test caught it.

**Logout** revokes the presented token and always answers `204`, even for an
unknown or already-revoked token: it must be safe to retry, and must not tell an
unauthenticated caller which tokens exist.

**Access tokens are not revoked on logout.** They cannot be without a
revocation list consulted on every request, which is the per-request state JWTs
exist to avoid. The mitigation is the short TTL: the refresh chain dies at once
and the access token lapses within minutes. Anything needing instant kill-switch
semantics wants server-side sessions, not JWTs.

### Client token storage

Refresh tokens are returned in JSON. That is an **API-level** decision suited to
scripted clients and this test suite. A browser client should not keep them in
`localStorage` — anything reachable by JavaScript is reachable by injected
JavaScript. Production browser delivery should use an `HttpOnly; Secure;
SameSite` cookie so the token is never scriptable, with the access token held in
memory only.

### Authorization

```ts
eventRouter.post('/', requireAuth, requireRole('organiser', 'admin'), createEventHandler);
eventRouter.use('/:eventId/holds', requireAuth, reservationRouter);
```

`requireRole` takes a list of roles and nothing more — no permission matrix, no
inheritance. The three roles the database already recognises are the whole
model. Resource-level rules ("an organiser may edit *their own* event") are a
different question and belong in a service, not in this shape.

### Where the reservation's user comes from

`req.user.id`, read once in the controller, feeding three things that must
agree: the hold's `user_id`, the idempotency key's scope, and the request hash.
There is **no fallback** to a body field — a fallback *is* the vulnerability,
and a test reintroducing `userId ?? req.user.id` demonstrably lets one user
create a hold owned by another.

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
