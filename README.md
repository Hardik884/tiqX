# tiqX — Ticket Booking System

Backend foundation: TypeScript + Express 5 + PostgreSQL.

This repository contains the backend foundation, the database schema, and the
transactional machinery behind reservation holds, booking confirmation and
cancellation, ticketing, and the waitlist and time-limited offer engine.
Payments, email, QR codes, WebSockets and search/discovery are intentionally
not implemented yet.

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
| `npm run worker:waitlist` | Run the waitlist allocation worker                  |
| `npm run worker:waitlist:dev` | Run the waitlist worker with hot reload         |
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
| `POST` | `/api/v1/bookings/:bookingId/cancel` | Cancel a booking and release its seats. **Auth.** |
| `POST` | `/api/v1/events/:eventId/waitlist` | Join the waitlist for a seat category. **Auth.** |
| `POST` | `/api/v1/events/:eventId/waitlist/:entryId/leave` | Leave the waitlist. **Auth.** |
| `POST` | `/api/v1/waitlist/offers/:offerId/accept` | Accept a time-limited waitlist offer. **Auth.** |

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
| `booking_seats` | which seats a booking covers, at the price charged; `cancelled_at` retires a row without deleting it |
| `reservation_holds` | a customer's temporary claim on seats of one event |
| `reservation_hold_seats` | which show seats a hold covers                |
| `idempotency_keys` | stored responses that make a retried write safe to repeat |
| `refresh_tokens` | server-side session state; stores digests, never tokens |
| `waitlist_entries` | a customer's queue position for one event and seat category |
| `waitlist_offers` | a time-limited offer of one seat, wrapping a `reservation_holds` row |
| `waitlist_allocation_outbox` | durable "an event/category may have a seat to offer" signal |
| `waitlist_notification_outbox` | durable "tell this user" signal; unconsumed until a notification worker exists |

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
idempotency_keys  ->  bookings  ->  show_seats (ascending id)  ->  reservation_holds
```

Reservation, the expiration worker, confirmation and cancellation all obey it.
Three of the four naturally start from a hold, so taking the hold lock first is
the tempting mistake and the one that cycles against a reservation coming the
other way. Deadlocks are avoided by ordering, not by leaving PostgreSQL to
detect them.

Confirmation never locks an existing `bookings` row - it inserts one nobody else
can see yet - so only cancellation uses that step. See
[Booking cancellation](#booking-cancellation) for why that cannot cycle.

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
- `UNIQUE (booking_seats.show_seat_id) WHERE cancelled_at IS NULL` - **a show
  seat belongs to at most one live booking.** This started as a plain unique
  constraint, which was right while cancellation did not exist and had to become
  partial when it did; see
  [Booking cancellation](#booking-cancellation). It subsumes
  `UNIQUE (booking_id, show_seat_id)` - a seat that appears at most once overall
  cannot appear twice within one booking - so that second index was not added.
- `total_amount >= 0`, `price >= 0`, status CHECKs, currency shape.
- `user_id` and `event_id` are `RESTRICT`, not `CASCADE`: a financial record
  must not vanish because a user row was deleted.

These are load-bearing rather than decorative. Removing both row locks from the
confirmation path leaves the concurrency tests passing, because the unique
constraints alone still prevent a duplicate; only when the constraints are
dropped as well does the 50-way test produce duplicate bookings.

### Deferred

Payments, refunds and ticket delivery are out of scope here. Cancellation is
implemented - see the next section, which is also where the seat uniqueness
constraint predicted above actually became a partial unique index.


## Booking cancellation

A booking is cancelled through one endpoint:

```
POST /api/v1/bookings/:bookingId/cancel
Authorization: Bearer <access-token>
Idempotency-Key: <required>
```

No request body, and none possible: the owner is the authenticated principal.
A booking is addressed on its own rather than under its event - it is globally
unique, and a URL carrying both would only give a caller a second thing to get
wrong.

```jsonc
// 200
{ "bookingId": "...", "bookingReference": "TX-2026-K4M9QP2X", "eventId": "...",
  "status": "cancelled", "releasedSeatCount": 3,
  "totalAmount": "1350.30", "currency": "INR", "cancelledAt": "..." }
```

`200`, not `201`: cancelling changes a booking, it does not create anything. The
total is echoed unchanged - it is what the customer paid, and cancelling does
not rewrite history.

### The one schema change, and why it was needed

Three of the four state machines needed nothing. `bookings.status` already
allowed `cancelled`, `show_seats.status` already allowed `available`, and
`reservation_holds` is not touched at all.

What did block cancellation was a constraint from the previous task:
`booking_seats_show_seat_id_key`, unique on `show_seat_id` across *every*
booking. It was right while cancellation did not exist - a sold seat stayed
sold - and wrong the moment it did. Cancel a seat, resell it, and PostgreSQL
refuses:

```
ERROR: duplicate key value violates unique constraint "booking_seats_show_seat_id_key"
```

The invariant it was reaching for was never "one booking ever", it was **one
live booking**. A partial unique index cannot read `bookings.status` from
another table, so liveness has to be visible on the row itself:

```sql
ALTER TABLE booking_seats ADD COLUMN cancelled_at timestamptz;
DROP  CONSTRAINT booking_seats_show_seat_id_key;
CREATE UNIQUE INDEX booking_seats_live_show_seat_key
    ON booking_seats (show_seat_id) WHERE cancelled_at IS NULL;
CREATE INDEX booking_seats_show_seat_id_idx ON booking_seats (show_seat_id);
```

The plain index is not redundant with the partial one. The partial index
deliberately excludes cancelled rows, so it cannot answer "does *any* row
reference this seat?" - which is exactly what PostgreSQL asks when the
`ON DELETE RESTRICT` on `show_seat_id` is checked. Without it, deleting a show
seat scans every sale ever recorded.

`bookings` gets no `cancelled_at`: status plus the existing `updated_at` trigger
already record that a booking was cancelled and when, and that is the value the
response returns. The column on `booking_seats` earns its place only because an
index needs it.

### State machine

```
booking:  confirmed ──> cancelled
          cancelled is terminal

seat:     available ──> held ──> booked ──> available
```

`cancelled -> confirmed` is not merely rejected: no statement anywhere performs
it, and the UPDATE that cancels is guarded on `status = 'confirmed'`, so a
second cancellation changes zero rows. That zero is treated as a refusal, never
as success - which is what stops a seat being released twice.

A repeated cancellation answers deliberately:

| Second request | Answer |
| --- | --- |
| same `Idempotency-Key` | the original `200`, replayed byte for byte |
| different key | `409 BOOKING_ALREADY_CANCELLED` |

### What moves and what does not

```
bookings.status         confirmed -> cancelled
booking_seats           rows stay; only cancelled_at is stamped
booking_seats.price     untouched - a historical snapshot
bookings.total_amount   untouched, for the same reason
bookings.currency       untouched
show_seats.status       booked -> available
reservation_holds       untouched
```

Seat rows are **never deleted**. They are the record of what was sold and at
what price; the timestamp only drops them out of the partial unique index so the
seat can be sold again. Both sales stay visible afterwards.

### The hold stays converted

Cancelling a booking is not undoing the confirmation that created it. The hold
was consumed when the booking was made, and `converted` is terminal. Rewinding
it to `active` would resurrect a reservation nobody asked for, with an
`expires_at` long past, and hand the seats to a hold whose owner has just given
them up.

After confirmation the **booking** owns the seats. The booking - and only the
booking - releases them.

### The transaction

Everything commits together or not at all:

```
BEGIN                            (owned by the idempotency wrapper)
  claim idempotency key
  lock the booking FOR UPDATE
  verify: exists, owned by caller
  verify: status = confirmed
  lock its live seats FOR UPDATE, ascending id   (one statement)
  verify: every seat is still booked
  booking -> cancelled           (guarded on status = 'confirmed')
  booking_seats.cancelled_at = now()             (one statement)
  show_seats -> available        (guarded on status = 'booked')
  store the idempotency response
COMMIT
```

The booking transitions **before** any seat is released, so there is no instant -
not even inside the transaction - where a seat is free while its booking still
claims it. Every guarded UPDATE's affected-row count is compared against what
was locked, and a mismatch aborts the whole thing rather than half-releasing.

Set-based throughout: one statement to lock the seats, one to retire the seat
rows, one to release the inventory, whether the booking has one seat or ten.

### Lock order

Cancellation extends the global order rather than contradicting it:

```
idempotency_keys  ->  bookings  ->  show_seats (ascending id)  ->  reservation_holds
```

Confirmation takes seats and then the hold, and never locks an existing
`bookings` row - it inserts one no other transaction can see. So `bookings` and
`reservation_holds` sit on opposite sides of `show_seats` and no cycle is
possible. The only table the four paths contend for is `show_seats`, and
reservation, expiration, confirmation and cancellation all reach it in ascending
id order.

Locking the seats is not optional. A cancellation releasing seat A1 and a
reservation wanting A1 must serialise, and

```sql
UPDATE show_seats SET status = 'available' WHERE id IN (...)
```

on its own would not make them. Under the lock, one of two things happens and
nothing else: the reservation runs first, finds A1 booked and is refused; or the
cancellation commits and the reservation then takes a genuinely free seat.

### Ownership

A booking that does not exist and a booking that is not yours return the **same
404**. Answering `403` for the second would let anyone walk booking ids and
learn which are real - and a real booking reference is a support-desk credential
in most ticketing systems. The distinction is kept in the logs, where an
operator can see it and an attacker cannot.

### Refunds are deliberately outside this transaction

No refund, no payment call, no webhook. That is not only scope: this transaction
holds row locks on inventory other customers are queuing for, and an HTTP call
to a payment provider inside those locks would hold them for the provider's
latency and timeout rather than the database's.

The boundary a payment layer would slot into:

```
cancel booking (this transaction, commits)
    -> enqueue a refund intent
        -> payment provider
            -> refund webhook updates the refund record
```

Only the enqueue step joins this transaction, and it would join it the way hold
expiration already does - an outbox row written here and drained by a worker
afterwards. Nothing external is called while a lock is held.

### What actually provides the protection

Worth being precise about, because the layers are not equally load-bearing.
Each was removed in turn and the concurrency suites re-run:

| Removed | Result |
| --- | --- |
| `FOR UPDATE` on `bookings` | 9 of 50 racing cancellations read a stale `confirmed`, fell through to the seat check and answered `CANCELLATION_CONFLICT` instead of `BOOKING_ALREADY_CANCELLED`. No corruption - but the wrong layer catching it, and the tests said so. |
| `AND status = 'confirmed'` on the UPDATE | Nothing observable. With the row lock and the service check both intact, the SQL guard is a backstop, not the primary defence. |
| the service's already-cancelled check | Every retry answered `409 BOOKING_INVALID`. Detected. |
| both of the above | The seat check caught it: `409 CANCELLATION_CONFLICT`, still no corruption. |
| all three, plus the seat check | **Corruption.** All 50 concurrent cancellations answered `200`, and a booking already cancelled and resold cancelled again. Four tests failed. |
| `booking_seats_live_show_seat_key` | Every service-level test still passed. The index only shows itself when rows are written straight to the table, which is exactly what the invariant test does. |

So: the **row lock** decides the answer, the **guarded UPDATEs and the seat
check** prevent the corruption, and the **partial unique index** is the backstop
for anything that bypasses the service. Each implementation was restored
byte-for-byte afterwards.

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

## Waitlist and time-limited offers

When an event/category is sold out, a customer can queue for it. When a seat
frees up - a cancellation, or another customer's hold simply lapsing - it is
offered to whoever has waited longest, for a limited time. If they do not act,
the next candidate gets it.

```
POST /api/v1/events/:eventId/waitlist            join the queue
POST /api/v1/events/:eventId/waitlist/:id/leave   leave it
POST /api/v1/waitlist/offers/:offerId/accept      accept a time-limited offer
```

### An offer is a reservation hold

This is the central design decision, and everything else follows from it.
Inspecting `reservation_holds` before adding anything found it already means
exactly what an offer needs: one user's time-limited claim on seats of one
event, with expiry decided by PostgreSQL and a release path that already
exists and is already tested. `waitlist_offers` does not duplicate that state
machine - it wraps one `reservation_holds` row (`hold_id`, `UNIQUE`) and adds
only what a hold does not carry: which waitlist entry earned it, and its own
status for the waitlist-facing API. Seat ownership itself - `available` /
`held` / `booked` - is still decided by `show_seats` and `reservation_holds`
alone, exactly as everywhere else in this system.

The payoff is that offer creation and offer acceptance need no new booking
logic at all:

- **creating** an offer is one call to `createHoldInTransaction`, the same
  function `POST /events/:eventId/holds` uses, for one seat and the offered
  candidate's `userId`.
- **accepting** an offer is one call to `confirmHoldInTransaction`, the same
  function `POST .../holds/:holdId/confirm` uses, against that hold's id.
- **expiring** an offer rides the *existing* hold-expiration sweep. There is
  no second worker polling `expires_at`; `expireHoldInTransaction` (see
  "Hold expiration" above) was extended to notice, after it frees
  a hold's seats, whether that hold was backing a waitlist offer, and if so
  marks the offer and its entry `expired` in the same transaction. One clock,
  one sweep, one place that decides a hold's time is up - not two racing each
  other over the same row.

The alternative - a separate `held_for_offer` seat state, or a hand-rolled
expiry timer for offers - was rejected because it would recreate a state
machine that already exists, already has tests, and already has the seat-lock
discipline every other path relies on. See "Database constraints" below for why that discipline still needed one *new* thing: a way to say "this seat
belongs to at most one live offer or hold", which `reservation_holds` alone
does not express for the waitlist's own bookkeeping table.

### Entry state machine

```
waiting ──> offered ──> accepted
   │            │
   │            └──> expired
   └──> cancelled
```

`accepted`, `expired` and `cancelled` are terminal. In particular:

- `expired -> waiting` does not exist. A customer whose offer lapses does not
  re-queue at the front of a line they already had their turn at - they are
  done, and the *next* candidate gets the next offer. Joining again starts a
  fresh entry, at the back of the queue.
- `waiting -> cancelled` (`.../waitlist/:id/leave`) exists in the schema and
  the guarded transition, though it is not part of the task's required test
  matrix - it exists because the state machine documents it, and the endpoint
  is the minimal thing that reaches it.

Every transition is a single guarded `UPDATE ... WHERE status = '<from>'`, the
same discipline every other state machine in this codebase uses: a repeated
transition changes zero rows and is treated as a refusal, never assumed to be
a success.

### Offer state machine

```
offered ──> accepted
   │
   └──> expired
```

Deliberately three states, not the four the task sketches as *possible*
(`offered`/`accepted`/`expired`/`cancelled`). No path in this system ever
declines or revokes a live offer other than by it lapsing, so a fourth
`cancelled` state would have no transition that ever produces it - an
unreachable state is worse than a state that does not exist.

### Duplicate membership

`waiting` and `offered` both count as **active** membership; `accepted`,
`expired` and `cancelled` are history. A customer cannot hold two active
entries for the same event and category - enforced by
`waitlist_entries_active_membership_key`, a partial unique index on
`(event_id, user_id, seat_category) WHERE status IN ('waiting', 'offered')` -
but a customer whose earlier attempt ended in one of the three terminal states
is free to join again. This is a database constraint, not a check-then-insert:
`joinWaitlistInTransaction` never `SELECT`s before it `INSERT`s, because a
check-then-insert has exactly the race window a partial unique index closes
for free. Two concurrent joins collide on the index; the loser gets a
constraint violation, mapped to the same `409 ALREADY_ON_WAITLIST` a client
would see calling it twice in sequence.

### FIFO order, and why availability is not gated at join time

Queue order is `(joined_at, id)`, read at query time - never stored as a
mutable `position`. A stored position would need renumbering every time
someone leaves ahead of others; `(joined_at, id)` is one `ORDER BY` away from
being computed for free, and `id` is a deterministic tie-breaker for the case
two entries share a `joined_at`, which a burst of concurrent joins can
genuinely produce.

Joining does **not** check whether the category is actually sold out. The
task's own validation list does not include an availability gate, and is
explicit that a join must not be made impossible by a seat freeing up between
a check and the join's own transaction - so this implementation does not try
to enforce "sold out" as a hard precondition at all. A customer choosing to
queue for a category that happens to have seats open right now costs the
system nothing; the allocation pass is what actually decides who gets a seat,
and it is unaffected by why someone joined.

### Cancellation creates an opportunity; it does not act on one

`cancelBookingInTransaction` and `expireHoldInTransaction` are the only two
places a seat is ever released to `available` (see "Lock order" below). Both, after releasing, call
`enqueueWaitlistAllocationForSeats` - a plain `INSERT` naming the event and
category, coalesced against any already-pending signal for that same pair via
a partial unique index and `ON CONFLICT ... DO NOTHING`. Neither function
scans the waitlist, locks a candidate, or creates an offer itself: the whole
point is that the HTTP request confirming a cancellation stays fast and holds
no lock longer than releasing its own seats needs.

```
booking cancelled / hold expired
        │
        ▼
show_seats -> available          (same transaction)
        │
        ▼
waitlist_allocation_outbox row   (same transaction, coalesced)
        │                           = "look at event X, category Y"
        ▼
waitlist allocation worker       (separate process, separate transaction)
        │
        ▼
offer created, notification enqueued
```

### The allocation pass

One worker transaction per claimed outbox row, pairing seats and candidates
deterministically - seats ascending by id, candidates FIFO - until either runs
out:

```
loop:
  lock the next waiting candidate    FOR UPDATE SKIP LOCKED, ORDER BY joined_at, id
  if none: stop
  read the next available seat        ascending id, unlocked
  if none: stop (the candidate stays `waiting`, still locked by this transaction)
  mark the candidate `offered`
  createHoldInTransaction(...)        the seat's actual lock and claim
  insert the waitlist_offers row
  enqueue a WAITLIST_OFFER_CREATED notification
mark the outbox row processed
```

`SKIP LOCKED` on the **candidate** scan, never on the **seat**: skipping a
locked queue position just means another worker already has it, but silently
abandoning a specific seat is a different kind of mistake, so the seat's own
lock (inside `createHoldInTransaction`) is a plain, blocking `FOR UPDATE`. A
`SAVEPOINT` wraps each attempted pairing: if the seat this pass read as
available gets claimed by an ordinary reservation microseconds before
`createHoldInTransaction` re-locks it, only that one pairing rolls back - the
candidate reverts to `waiting`, still held by this transaction's own lock -
and the loop retries it against a freshly read seat list, rather than undoing
every offer already made earlier in the same pass.

Two workers claiming the *same* outbox row cannot happen - the coalescing
index guarantees at most one pending row per (event, category), and
`FOR UPDATE SKIP LOCKED` at the claim gives whoever gets it sole ownership of
that pass. Two workers processing genuinely *different* signals that happen to
touch overlapping seats are still safe: the seat lock inside
`createHoldInTransaction` is a real, blocking lock, so the second worker
simply waits, then re-reads a seat list that no longer includes what the first
worker just took.

There is a self-healing **reconcile** loop alongside allocation, mirroring
`reconcileExpiryKeys` for the same reason: every path that frees a seat
already enqueues a signal, but "the worker was down when it mattered" is worth
a slow, bounded backstop for. It scans for event/categories with a waiting
candidate and an available seat but no pending outbox row, and enqueues one.

### Accepting an offer, and why it cannot deadlock with expiry

`POST /waitlist/offers/:offerId/accept` does an unlocked, ownership-only read
of the offer (an honest 404 for "not yours", nothing more), then hands the
offer's `hold_id` straight to `confirmHoldInTransaction` - the exact function
a direct hold confirmation uses. Only *after* that succeeds does it stamp
`waitlist_offers` and `waitlist_entries` `accepted`.

That ordering is what makes acceptance and expiry safe to race. Both reach
`reservation_holds` through the identical path - `show_seats` locked first,
then the hold - and both touch `waitlist_offers` only afterwards:
`confirmHoldInTransaction` on the accept side, `markOfferExpiredByHoldId` on
the expiry side (inside `expireHoldInTransaction`). So the two locks are
always taken in the same order by both paths, and whichever transaction wins
the hold's lock decides the outcome; the loser's own guarded transition on
`reservation_holds` simply matches zero rows, and its later, offer-specific
UPDATE is never reached because the earlier step already threw.
`confirmHoldInTransaction`'s `HOLD_EXPIRED` / `HOLD_INVALID` become
`OFFER_EXPIRED` for the customer; `HOLD_ALREADY_CONFIRMED` becomes
`OFFER_ALREADY_ACCEPTED`.

### Lock order

Waitlist operations extend the existing global order rather than
contradicting it. The order confirmation and cancellation already established:

```
idempotency_keys  ->  bookings  ->  show_seats (ascending id)  ->  reservation_holds
```

becomes, with the waitlist paths folded in:

```
idempotency_keys  ->  bookings  ->  waitlist_offers  ->  show_seats (ascending id)  ->  reservation_holds
waitlist_allocation_outbox  ->  waitlist_entries  ->  show_seats (ascending id)  ->  reservation_holds
```

Two observations make this safe rather than merely hopeful:

- **Acceptance and expiry** both take `waitlist_offers` only *after* `show_seats`
  and `reservation_holds` - see the previous section - so they sit on the
  correct side of the existing order, not before it.
- **Allocation** takes `waitlist_entries` (via the candidate lock), then
  `show_seats`/`reservation_holds` (via `createHoldInTransaction`), and never
  touches an *existing* `waitlist_offers` row - it only ever inserts a fresh
  one, which needs no lock. Nothing in this system ever locks `show_seats` or
  `reservation_holds` and *then* reaches back to lock `waitlist_entries` or an
  existing `waitlist_offers` row, so no cycle is possible between the
  allocation path and either of the others.

`enqueueWaitlistAllocationForSeats`, called from both `cancelBookingInTransaction`
and `expireHoldInTransaction`, takes no lock of its own - a plain `INSERT`
against a row nothing else in that transaction has touched - so it adds
nothing to this ordering either.

### Database constraints

- `waitlist_entries_active_membership_key` - `UNIQUE (event_id, user_id,
  seat_category) WHERE status IN ('waiting', 'offered')`. See
  "Duplicate membership" above.
- `waitlist_offers_active_seat_key` - `UNIQUE (show_seat_id) WHERE status =
  'offered'`, and `waitlist_offers_active_entry_key` - `UNIQUE
  (waitlist_entry_id) WHERE status = 'offered'`. Both are **backstops, not the
  primary defence** - see "Negative controls" below for why that distinction
  was actually measured, not assumed.
- `waitlist_offers_hold_id_key` - `UNIQUE (hold_id)`: exactly one offer per
  backing hold, which is also structurally guaranteed by construction (each
  offer creates a fresh hold), but made a real constraint anyway.
- `waitlist_allocation_outbox_pending_key` - `UNIQUE (event_id, seat_category)
  WHERE processed_at IS NULL`: the coalescing index described above.
- `..._accepted_at_consistency_check` / `..._expired_at_consistency_check` on
  `waitlist_offers`: each timestamp is present exactly when its status says it
  should be, the same discipline `tickets_used_at_consistency_check` applies.

### Negative controls

Each mechanism below was temporarily removed, the relevant tests re-run to
capture the failure, and the code restored byte-for-byte (verified by hash)
before moving to the next:

| Removed | Result |
| --- | --- |
| `waitlist_entries_active_membership_key` | All 50 concurrent duplicate-join attempts succeeded - `50 !== 1`. **Corruption.** This index is the primary defence; there is no row lock protecting it, because there is no existing row to lock until the `INSERT` itself resolves the race. |
| `waitlist_offers_active_seat_key` | No test failed. Fabricating two `offered` rows for the same seat by inserting directly into the table, bypassing the service entirely, still succeeded - proving the constraint *can* be violated with it gone - but every service-level path was already prevented from reaching that state by the seat's own row lock inside `createHoldInTransaction`. Backstop, not primary defence, exactly as `booking_seats_show_seat_id_key` was found to be in the cancellation task. |
| the `status = 'offered'` guard on `markOfferAccepted` | No test failed, for the same reason: `confirmHoldInTransaction`'s own guard on `reservation_holds.status` is what actually prevents a second acceptance from doing anything - the offer-row guard removed here is a second, redundant expression of a rule the hold's own state machine already enforces. |
| the `ORDER BY joined_at, id` on the candidate query | The plain "offers the first joiner" test still passed - a small, freshly inserted table tends to return rows in insertion order even unordered, which is a false negative waiting to happen. A test that inserts candidates in one order but gives them `joined_at` values in the *opposite* order caught it immediately: the wrong candidate was offered the seat. Kept as a permanent regression test precisely because it is the only one of the FIFO tests that would fail without the `ORDER BY`. |

### What is deferred

No email, no QR codes, no push notifications - `waitlist_notification_outbox`
is a durable producer with no consumer yet, carrying only safe identifiers
(`offerId`, `waitlistEntryId`, `userId`, `eventId`, `showSeatId`, `expiresAt`).
A future notification worker claims rows from it exactly the way the
allocation worker claims from `waitlist_allocation_outbox` - `FOR UPDATE SKIP
LOCKED`, mark-processed-or-back-off - and sends whatever it sends. Nothing
here calls out to email, SMS or push while holding a lock, or at all.

**Token security for a future email link.** The authenticated `accept`
endpoint uses `offerId` + the caller's session identity, which is sufficient
today because every caller is already authenticated. A future "accept from
your email" link cannot rely on the same thing - a bare `offerId` in a URL is
then the only credential, and offer ids are sequential-looking UUIDs handed
out at a predictable rate. That link would need its own single-use, expiring
token (an opaque random value, stored **hashed** - the same pattern
`refresh_tokens` already uses for exactly this reason), checked instead of, not
in addition to, requiring a login. Not built now; noted so it is not
accidentally built as "just check the offer id."

## Tests

The suite is integration-level: it exercises the real schema and a real Redis,
never a stand-in. A fake in-memory Redis would pass every test here while
proving nothing about atomicity, TTLs, or state shared between processes.

```bash
cp .env.example .env   # DATABASE_URL and REDIS_URL must point at real services
npm run migrate:up
npm test
```

A few suites deserve mention. `rate-limit.distributed.test.ts` spawns **two real
API processes** against one Redis and alternates requests between them, which is
the only way to tell a shared counter from a process-local one.
`redis.failure.test.ts` drops the connection mid-suite to prove the fail-closed
policy holds and that no Redis detail reaches a client.
`booking-cancel.concurrency.test.ts` fires 50 simultaneous cancellations at one
booking and races cancellation against reservation, confirmation and the
expiration worker; the races are jittered so both outcomes actually occur rather
than one side always winning on timing, and each round re-checks the same set of
cross-table invariants.
`waitlist.concurrency.test.ts` runs the same style of race against the waitlist:
50 concurrent joins, 5 simulated allocation workers racing for one seat across
several expire-and-reoffer rounds, and a cancellation/reservation/allocation
three-way race, each round re-checking that a seat never has two owners and a
queue position never holds two live offers. `waitlist-allocation.test.ts` and
`waitlist-offer-accept.test.ts` drive the allocation pass and the accept/expire
paths directly - the same functions the real worker calls, run inline rather
than by spawning the worker process - including the end-to-end scenario the
task itself poses: a booking cancels, the first waiter's offer lapses, the
second accepts, and a third candidate never gets an offer because only one
seat ever existed.

Rate limits are live during tests. Rather than disabling the middleware, each
suite presents a distinct `X-Forwarded-For` so its identifiers are isolated;
the rate-limit suites pin one address deliberately in order to hit the limit.

Tests create their own venues and organisers and delete them afterwards.
