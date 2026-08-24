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
- Redis >= 6 (the API refuses to start without it - see [Redis](#redis))

## Getting started

```bash
# 1. install dependencies
npm install

# 2. create your local environment file, then point DATABASE_URL and REDIS_URL
#    at your database and cache, and set a real JWT_SECRET
cp .env.example .env

# 3. start Redis and confirm it answers
docker run -d --name tiqx-redis -p 6379:6379 redis:7-alpine
redis-cli ping            # -> PONG

# 4. create the schema
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
| `npm run worker`         | Run the hold expiration worker                       |
| `npm run worker:dev`     | Run the worker with hot reload                       |
| `npm test`               | Run the integration tests (needs a migrated DB and Redis) |

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
| `POST` | `/api/v1/events/:eventId/holds/:holdId/confirm` | Convert a hold into a booking. **Auth.** |

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
| `show_seats`  | per-event inventory state of each physical seat, and its price |
| `bookings`    | confirmed bookings, with a total snapshot            |
| `booking_seats` | which seats a booking covers, at the price charged |
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

## Redis

> **Redis is not the source of truth for seat ownership.**
>
> PostgreSQL remains authoritative for `show_seats` state, holds, hold-seat
> links, bookings and expiry correctness. Nothing in Redis decides whether a
> seat is available, and there is no `seat:A12 = locked` key. Seat contention is
> settled by `SELECT ... FOR UPDATE` inside one transaction, which is where it
> will stay.

Redis exists here for **ephemeral infrastructure state** - data that may be lost
without corrupting anything. Today that is two things: distributed rate limiting
and hold expiration *signals*. Everything Redis holds can be deleted without
changing which seats are available; see [Hold expiration](#hold-expiration).

| Concern | Owner |
| ------- | ----- |
| Seat state, holds, hold-seat links | PostgreSQL |
| Users, credentials, refresh tokens | PostgreSQL |
| Idempotency records and stored responses | PostgreSQL |
| Rate-limit counters | Redis |
| Hold expiration *signals* (never the decision) | Redis |

### Running Redis locally

```bash
docker run -d --name tiqx-redis -p 6379:6379 redis:7-alpine
# or: redis-server --port 6379
# or: brew services start redis / sudo systemctl start redis
```

### Verifying connectivity

```bash
redis-cli ping                       # PONG
curl -s localhost:4000/health        # liveness; never touches Redis
curl -s localhost:4000/health/ready  # {"dependencies":{"database":"up","redis":"up"}}
```

`/health` is liveness and deliberately ignores dependencies - a probe that
failed during a Redis outage would have the orchestrator restart a healthy
process, which cannot fix anything. `/health/ready` returns `503` with
`redis: "down"` when Redis is unreachable, so the instance leaves the load
balancer's rotation. Neither response contains a host, URL or error text; the
detail is logged with the request id instead.

### Key namespace

```
<namespace>:<version>:<purpose>:<parts...>
tiqx:v1:rate-limit:login:a1b2c3d4e5f6...
```

Every key is built by `src/redis/keys.ts`; no module writes a raw key string.
`REDIS_NAMESPACE` isolates deployments (and test runs) sharing one server, and
the `v1` segment means a key's meaning can change by bumping the version and
letting the old keys age out under their TTLs.

Caller-supplied components are **hashed**, not interpolated. Redis keys have no
escaping, so a colon inside an identifier would be indistinguishable from a
separator and could be steered into another caller's bucket. Hashing also bounds
cardinality and keeps the email and IP of a failed login out of the keyspace.

### Rate limiting

| Endpoint | Limit | Window | Keyed on |
| -------- | ----- | ------ | -------- |
| `POST /auth/login` | 10 | 5 min | email + IP |
| `POST /auth/register` | 5 | 1 hour | IP |
| `POST /auth/refresh` | 20 | 5 min | IP |

All configurable. `POST /auth/logout` is deliberately unlimited, because ending
a session must always be possible.

**Identifiers.** Login uses email *and* IP: email alone would let anyone lock a
victim out by failing logins on their behalf, and IP alone punishes everyone
behind one NAT. Register uses IP, because the attacker picks the email and
keying on it would hand out a fresh allowance per attempt. Refresh uses IP for
the same reason plus one more - keying on the presented token would mint a new
Redis key for every invalid token submitted, which is unbounded cardinality and
no limiting at all.

**Algorithm: fixed window.** One counter per key, created by the first request
and expiring with the window. The tradeoff is real: with 10 per 5 minutes a
caller can spend 10 at 04:59:59 and 10 more at 05:00:01 - twice the nominal rate
in two seconds, entirely within the rules. Fixed windows bound sustained abuse,
not bursts. A sliding window or token bucket would smooth that at the cost of
storing timestamps rather than one integer; the limiter returns a decision
rather than exposing its counter, so swapping the algorithm touches one file.

**Atomicity.** Increment and expiry happen in one Lua script. `INCR` followed by
a separate `EXPIRE` can fail between the two round trips and leave a counter
with no TTL - a key that never resets, locking an identifier out permanently.
Redis runs the script atomically, and the TTL is set only on the increment that
created the key, so later requests cannot extend a window already in progress.

**Fail closed.** If Redis cannot answer, these three endpoints return `503`
(`DEPENDENCY_UNAVAILABLE`), not `429` and not success.

That is deliberate and costs availability. Failing open would turn a Redis
outage into an unmetered window against the credential surface, precisely when
monitoring is noisiest. Failing closed is bounded, visible and self-announcing,
and readiness already pulls the instance from rotation. There is **no in-memory
fallback**: a process-local counter would claim protection that does not hold
across instances, which is the one guarantee this feature exists to provide. The
reasoning is specific to auth endpoints - a read-only listing endpoint would
sensibly fail open, which is why the policy lives in the middleware rather than
the limiter.

A limited response never mentions Redis, a key or a counter:

```json
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests. Try again later." } }
```

It carries `Retry-After`, plus `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset` headers so a well-behaved client can slow down before it is
refused.

### Behind a proxy

`TRUST_PROXY` (default `false`) decides whether `X-Forwarded-For` is believed
when resolving the client IP. Enable it **only** behind a proxy that overwrites
the header: enabled anywhere else, any client can spoof its address and walk
past an IP-keyed limit. Left off behind a load balancer the opposite breaks -
every request appears to come from the balancer and all callers share one
bucket.

### Startup and shutdown

Startup validates configuration, connects PostgreSQL, connects and pings Redis,
and only then opens the port. If Redis is unreachable the process **exits**
rather than serving traffic it cannot protect - a crash-looping container is a
louder signal than an API quietly returning 503s. Shutdown closes the HTTP
server, then Redis, then the PostgreSQL pool, through the existing graceful
shutdown path.

## Booking confirmation

A hold becomes a booking through one endpoint:

```
POST /api/v1/events/:eventId/holds/:holdId/confirm
Authorization: Bearer <access-token>
Idempotency-Key: <required>
```

There is no request body. The owner is the authenticated principal and nothing
else, so there is nothing a client could put in one.

```jsonc
// 201
{ "bookingId": "...", "bookingReference": "TX-2026-K4M9QP2X", "eventId": "...",
  "holdId": "...", "status": "confirmed", "seatCount": 3,
  "totalAmount": "1350.30", "currency": "INR", "createdAt": "..." }
```

### This is not payment confirmation

Confirming means the reservation is durably converted into a booking. No money
moves, and `bookings` has deliberately no payment status - two states, not a
half-built payment machine. The shape lets payment slot in *front* later:

```
authorise payment  ->  confirm booking (this transaction)
```

The reverse - confirm first, reconcile payment after - is how you end up owing
seats you were never paid for.

### State machines

The schema already had the states this needed, so neither CHECK constraint
changed. A confirmed hold is `converted`, the value `reservation_holds` has
allowed since it was created.

```
hold:   active ──> converted     (confirmation)
               └─> expired       (worker or opportunistic reclamation)
        converted / expired / cancelled are terminal

seat:   available ──> held ──> booked
                  <──┘
        available ──> booked is impossible through this endpoint
```

`expired -> converted` and `converted -> active` are not merely rejected - the
UPDATE that performs each transition is guarded on the state it comes from, so
they cannot happen even if a check above were removed.

### The transaction

Everything commits together or not at all:

```
BEGIN                            (owned by the idempotency wrapper)
  claim idempotency key
  lock the hold's seats FOR UPDATE, ascending id
  lock the hold FOR UPDATE
  verify: exists, owned by caller, same event, active, not expired
  verify: every seat is still held
  insert booking
  insert booking_seats           (one set-based statement, price snapshot)
  total_amount = SUM(booking_seats.price)     in SQL
  show_seats -> booked           (guarded on status = 'held')
  hold -> converted              (guarded on status = 'active')
  store the idempotency response
COMMIT
```

There is no observable ordering: a booking without booked seats, or a booked
seat without a booking, cannot be read by anyone.

### Lock order

One global order, followed by every path that touches these tables:

```
idempotency_keys  ->  show_seats (ascending id)  ->  reservation_holds
```

Reservation, the expiration worker and confirmation all obey it. Two of the
three naturally start from a hold, so taking the hold lock first is the
tempting mistake and the one that cycles against a reservation coming the other
way. Deadlocks are avoided by ordering, not by leaving PostgreSQL to detect
them.

### Money

Every monetary column is `NUMERIC(12,2)`; every sum is computed by PostgreSQL;
totals cross the API as strings. `450.10 x 3` is `1350.30` here and
`1350.3000000000002` in binary floating point, and money that does not add up
is a reconciliation failure rather than a rounding curiosity.

`booking_seats.price` is a **snapshot** taken at confirmation. Reprice the event
afterwards and the booking is unchanged - a booking must be able to explain
itself without reference to today's prices.

Pricing itself is deliberately minimal: a `price` on each `show_seats` row (the
grain price actually varies at - the same physical seat costs different amounts
at different events) and one `currency` per event. Optional `pricing` at event
creation fills it in. That is not a pricing engine and is not meant to be.

### Ownership, and what the API will not tell you

A hold that does not exist, is not yours, or belongs to a different event all
return the **same 404**. A 403 would confirm to a prober that the hold is real,
which is a small leak of another customer's activity for no benefit to any
honest client. The distinction is kept in the server logs, where an operator can
see it and an attacker cannot.

| Code | Status | Meaning |
| ---- | ------ | ------- |
| `HOLD_NOT_FOUND` | 404 | unknown, not yours, or wrong event |
| `HOLD_EXPIRED` | 409 | its time passed, by PostgreSQL's clock |
| `HOLD_ALREADY_CONFIRMED` | 409 | already converted |
| `HOLD_INVALID` | 409 | cancelled or otherwise unusable |
| `CONFIRMATION_CONFLICT` | 409 | seats and hold disagree |
| `idempotency_key_reuse` | 409 | key reused for a different hold |

### Database invariants

Constraints, not just code:

- `UNIQUE (bookings.hold_id)` - one booking per hold.
- `UNIQUE (booking_seats.show_seat_id)` - **a show seat belongs to at most one
  booking.** Stricter than "one *confirmed* booking", which a partial unique
  index cannot express because the status lives on another table. The strict
  rule is right today: cancellation does not release seats. It also subsumes
  `UNIQUE (booking_id, show_seat_id)` - a seat that appears at most once
  overall cannot appear twice within one booking - so that second index was not
  added.
- `total_amount >= 0`, `price >= 0`, status CHECKs, currency shape.
- `user_id` and `event_id` are `RESTRICT`, not `CASCADE`: a financial record
  must not vanish because a user row was deleted.

These are load-bearing rather than decorative. Removing both row locks from the
confirmation path leaves the concurrency tests passing, because the unique
constraints alone still prevent a duplicate; only when the constraints are
dropped as well does the 50-way test produce duplicate bookings.

### Deferred

Cancellation is designed for - `bookings.status` already allows `cancelled` -
but not implemented, and it does not release seats. When it does, the seat
uniqueness constraint becomes a partial unique index over a denormalised
status. Payments, refunds and ticket delivery are all out of scope here.


## Hold expiration

A hold has an `expires_at`. Something has to notice when it passes and give the
seats back. That job is split between a durable event in PostgreSQL, a signal in
Redis, and a worker - arranged so that **Redis is never what decides**.

```
    HTTP API                         Expiration worker
        │                                    │
        ▼                          ┌─────────┴──────────┐
   PostgreSQL                      │  publish  sweep  reconcile
   ┌────┴─────┐                    │     │       │        │
   hold     outbox  ───────────────┘     │       │        │
   state    event                        │       │        │
                    Redis key ◄──────────┘       │        ▼
                    (signal)                     │   restore lost keys
                                                 ▼
                                          PostgreSQL verify
                                          expire + release
```

`npm run worker` starts it. It is a separate entrypoint from the API: no HTTP
server, no duplicated Express lifecycle, and it scales independently.

### Why an outbox

PostgreSQL and Redis cannot share a transaction, so between `COMMIT` and the
Redis write there is a window where the hold exists and the signal does not.
That window cannot be closed - so instead of pretending, the *intent to publish*
is written into the hold's own transaction:

```
BEGIN
  validate event and user
  lock seats FOR UPDATE
  reclaim lapsed holds
  create hold, hold-seat rows, mark seats held
  insert hold_expiration_outbox row      <-- same transaction
COMMIT
```

Hold and event commit together or not at all. If Redis is down for an hour, the
row waits. **The API never calls Redis** on this path: a reservation the
database accepted cannot fail because a cache is unavailable, and Redis latency
never lands in the customer's response.

### Delivery is at-least-once

Not exactly-once, and it cannot be: a worker can set the Redis key and die
before recording that it did, after which the row is claimed again. This is safe
because `SET` is idempotent and so is the expiry transition it leads to. Nothing
here should be read as a claim of exactly-once processing.

### Three loops

| Loop | Cadence | Job |
| ---- | ------- | --- |
| publish | 1s | claim outbox rows, write Redis keys, mark processed |
| sweep | 1s | find holds past `expires_at` in **PostgreSQL**, expire them |
| reconcile | 30s | restore Redis keys that active holds should have |

They are separate because they fail independently. Redis being down stops
publishing and reconciliation, but the sweep needs only PostgreSQL - so an
outage delays the *signal*, never the expiry.

**The sweep is the authoritative path, and it does not read Redis.** An expired
Redis key is not a durable message: it can be evicted, lost to a flush, or
missed when no listener is connected. Keyspace notifications are not used at
all; correctness rests on an indexed PostgreSQL query.

### Claiming work: `FOR UPDATE SKIP LOCKED`

```sql
SELECT ... FROM hold_expiration_outbox
WHERE processed_at IS NULL AND available_at <= now()
ORDER BY available_at LIMIT $1
FOR UPDATE SKIP LOCKED
```

A plain `FOR UPDATE` would make worker B queue behind worker A on the same row,
so two workers would be no faster than one. `SKIP LOCKED` hands B what A has not
taken, which is what makes the worker horizontally scalable.

This is deliberately **the opposite of the customer seat path**, which uses a
plain `FOR UPDATE` and waits. Skipping a locked seat would mean silently
ignoring a seat someone asked for; skipping a locked outbox row just means
another worker already has it.

### Lock order

Both the worker and the reservation path take **seats first, in ascending id
order, then the hold**. Matching that order is what prevents a deadlock: two
transactions taking the same two locks in opposite orders will cycle, and
PostgreSQL will kill one. The worker naturally starts from a hold, so getting
this backwards would be the easy mistake - it explicitly loads the hold's seat
ids, locks those, and only then locks the hold.

The sweep's candidate query takes **no** lock, for the same reason: locking
holds there would take them before the seats.

### Redis TTL comes from PostgreSQL

```
ttl = ceil(expires_at - now())     -- both evaluated inside PostgreSQL
```

The application's wall clock never participates. A worker running fast would
otherwise set keys that lapse early; one running slow would set keys outliving
the hold. Key shape is `tiqx:v1:hold-expiry:<holdId>`, value is the hold id -
nothing sensitive, and readable in `redis-cli`.

### Retries

A failed publish does not mark the row processed. It increments `attempts`,
records the driver's message (never a URL, which can carry a password), and
pushes `available_at` forward by an exponential, capped backoff computed **by
PostgreSQL** - so a skewed worker clock cannot schedule a retry in the past and
spin on it. One polling loop, not thousands of timers.

### Self-healing

Reconciliation scans active holds expiring within a window and restores any
missing Redis key. It covers what the outbox cannot: a key lost *after*
publication, to a flush, an eviction, a restart without persistence, or a
failover to an empty replica.

Note what it is **not** needed for: if reconciliation never ran, every hold
would still expire on time, because the sweep reads PostgreSQL. It keeps the
Redis view honest; it does not keep the system correct.

### Invariants

1. A seat cannot become available while a valid active hold owns it.
2. A valid hold cannot disappear because Redis is unavailable.
3. Missing Redis signals are recoverable - by reconciliation, and irrelevant to
   the sweep in any case.
4. Duplicate signals are harmless; expiry is idempotent under concurrency.
5. Worker crashes lose no work: all progress is in PostgreSQL, and a killed
   process's locks are released by the database.
6. PostgreSQL is authoritative. **Redis is not the source of truth for seat
   ownership** - there is no seat key, no distributed seat lock, and deleting
   every expiration key changes no seat's availability.

### Future metrics

There is no metrics backend in this project, and one was not introduced for this
feature. The worker keeps in-process counters and logs a periodic summary
(pending outbox depth, published, publish failures, expired, no-ops, restored
keys, loop errors). Worth exporting when a backend exists: outbox depth and
oldest pending age (queue health), publish failure rate (Redis health),
expiry lag between `expires_at` and the actual transition (customer-visible
correctness), and reconciliation restores per hour (a non-zero rate means Redis
is losing keys).



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

The suite is integration-level: it exercises the real schema and a real Redis,
never a stand-in. A fake in-memory Redis would pass every test here while
proving nothing about atomicity, TTLs, or state shared between processes.

```bash
cp .env.example .env   # DATABASE_URL and REDIS_URL must point at real services
npm run migrate:up
npm test
```

Two suites deserve mention. `rate-limit.distributed.test.ts` spawns **two real
API processes** against one Redis and alternates requests between them, which is
the only way to tell a shared counter from a process-local one.
`redis.failure.test.ts` drops the connection mid-suite to prove the fail-closed
policy holds and that no Redis detail reaches a client.

Rate limits are live during tests. Rather than disabling the middleware, each
suite presents a distinct `X-Forwarded-For` so its identifiers are isolated;
the rate-limit suites pin one address deliberately in order to hit the limit.

Tests create their own venues and organisers and delete them afterwards.
