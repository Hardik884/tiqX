# Architecture: seat holds and the waitlist

This document explains the two mechanisms at the core of tiqX: how a seat
hold is created and expires, and how the waitlist turns a freed seat into a
time-limited offer. Both are built entirely on PostgreSQL row locking and
constraints; Redis and the background workers exist to make the *signal*
that something changed durable and low-latency, never to decide anything.

See [DATABASE.md](DATABASE.md) for the tables referenced here, and
[SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) for a condensed, interview-style version
of the same material.

## Seat holds

### Creating a hold

`POST /api/v1/events/:eventId/holds` — request: `{ showSeatIds: string[], ttlSeconds?: number }` (1-10 seats, 60-900s, default 600s). Requires
`Authorization` and a required `Idempotency-Key` header.

Everything happens in one transaction:

```
BEGIN
  event exists?
  SELECT ... FROM show_seats
   WHERE id = ANY(showSeatIds) AND event_id = :eventId
   ORDER BY id
   FOR UPDATE                       <- competing requests serialise here
  every requested seat came back?    (else 404/400)
  expire any lapsed holds still marking these seats 'held', and free them
  re-read availability; any seat still taken -> 409, whole request fails
  INSERT reservation_holds (expires_at = now() + ttl)
  INSERT reservation_hold_seats
  UPDATE show_seats SET status = 'held'
  INSERT hold_expiration_outbox     <- same transaction, see below
COMMIT
```

If any one requested seat is unavailable, the whole request fails and
*nothing* changes — no hold row, no seat flips to `held`. That is not
compensating logic cleaning up after a partial failure; it is simply what a
single transaction that throws does.

### Why concurrent requests cannot both get the same seat

Three things, together:

1. **`SELECT ... FOR UPDATE`** on the requested `show_seats` rows blocks every
   other transaction wanting the same seat until this one commits or rolls
   back. A blocked transaction re-reads the row *after* the lock is granted,
   so it observes the winner's actual result, not a stale value read before
   waiting.
2. **`ORDER BY id`** fixes the order in which locks are acquired for any
   multi-seat request. Two overlapping requests therefore queue in the same
   direction and can never form a lock cycle (a deadlock).
3. **`event_id` in the locking query** doubles as the ownership check — a
   client cannot reach a seat belonging to a different event.

No application-level mutex, no Redis lock, no advisory lock is involved.
PostgreSQL's row lock is the *only* arbiter of who wins a contested seat.

### Hold expiration

A hold's `expires_at` is a plain timestamp column — not a `CHECK` constraint,
because a `CHECK` is evaluated on write and cannot express "still valid right
now" as time passes. Nothing rewrites a hold the instant it lapses; whoever
next needs that seat performs the transition, inside their own transaction,
under the same seat lock described above (mark old hold expired → free the
seat → acquire it for the new hold). **Correctness never depends on a
background worker running on time** — a lapsed hold sitting untouched is
simply reclaimed by the next request that wants its seat.

The expiration worker (`npm run worker`, entry point
`src/workers/hold-expiration.worker.ts`) exists to release seats *promptly*
even with no incoming request, and to publish a signal other parts of the
system use. It runs three independent loops:

| Loop | Cadence (`EXPIRY_SWEEP_INTERVAL_MS` etc.) | Job |
| --- | --- | --- |
| sweep | 1s | find holds past `expires_at` **in PostgreSQL**, expire them, release their seats |
| publish | 1s | claim `hold_expiration_outbox` rows, write a Redis key, mark processed |
| reconcile | 30s | restore Redis keys that should exist for still-active holds but are missing |

**The sweep is the authoritative path and never reads Redis.** It queries
`reservation_holds` directly via the partial index on `expires_at WHERE
status = 'active'`. If Redis is down for an hour, holds still expire exactly
on time — only the *publish* and *reconcile* loops stall.

Releasing a seat here (and on booking cancellation) also enqueues a waitlist
allocation signal — see below.

### Why Redis is not authoritative for seat availability

There is no seat key in Redis, no distributed seat lock, and no seat state
cached there. Redis holds:

- an expiry-timer key per active hold (`tiqx:v1:hold-expiry:<holdId>`, TTL
  computed **inside PostgreSQL** as `ceil(expires_at - now())` so an
  app-server clock skew can never mint a wrong TTL) — used only for
  operational visibility, not correctness;
- rate-limit counters;
- pub/sub channels the real-time WebSocket layer fans out from.

Deleting every key in Redis changes no seat's availability. The reason this
works is the outbox pattern: PostgreSQL and Redis cannot share a
transaction, so instead of writing to both and hoping, the *intent* to
publish is written into the hold's own transaction
(`hold_expiration_outbox`), and a worker retries the Redis write
independently, as many times as it needs, with the seat's true state never
depending on whether that retry has succeeded yet.

Delivery to Redis is **at-least-once**, not exactly-once — a worker can set a
key and crash before recording that it did, causing a re-publish. This is
safe because both the Redis `SET` and the PostgreSQL expiry transition it
leads to are idempotent.

### Idempotency

Every hold-creation and hold-confirmation request requires an
`Idempotency-Key` header (1-255 printable ASCII characters). The key is
scoped `UNIQUE (user_id, key)` in `idempotency_keys` — never global — and a
retried request with the same key returns the **exact stored response**
(status, body) without re-running any reservation logic.

What makes two requests "the same" is a SHA-256 hash over the fields that
actually change behaviour (`userId`, `eventId`, seat IDs sorted, `ttlSeconds`)
— key order and seat order are irrelevant. A key reused for a *different*
request is refused with `409` rather than silently replayed.

The claim, the underlying operation, and the stored response all commit in
**one transaction**: `INSERT ... ON CONFLICT (user_id, key) DO NOTHING` races
concurrent duplicates against the unique index itself, so a second request
carrying the same key **blocks** on the index until the first finishes, then
either replays its committed response or — if the first rolled back — takes
the key over and does the work. A failed request stores nothing: the
transaction rollback undoes the claim along with everything else, so a retry
after a genuine failure is a fresh attempt, not a replayed error.

## Waitlist

### An offer is a reservation hold

The central design decision: `waitlist_offers` does not reimplement
time-limited claims. It wraps one `reservation_holds` row (`hold_id`,
`UNIQUE`) and adds only what a hold does not carry — which waitlist entry
earned it, and a status for the waitlist-facing API. Seat ownership itself
is still decided by `show_seats` and `reservation_holds` alone, exactly as
everywhere else. This means:

- **creating** an offer calls the same `createHoldInTransaction` a direct
  hold request uses, for one seat and the candidate's `userId`;
- **accepting** an offer calls the same `confirmHoldInTransaction` a direct
  confirmation uses, against that hold's id;
- **expiring** an offer rides the *existing* hold-expiration sweep — there is
  no second timer. When the sweep frees a hold's seat, it checks whether that
  hold was backing a waitlist offer and, if so, marks the offer and its entry
  `expired` in the same transaction.

### Joining

`POST /api/v1/events/:eventId/waitlist` — body `{ seatCategory }`. A customer
joins a **category** (`standard`/`premium`), not a specific seat. Joining
does not check whether the category is actually sold out — the allocation
pass below is what decides who gets a seat, and a customer choosing to queue
for a category with seats open right now costs the system nothing.

A customer cannot hold two *active* (`waiting` or `offered`) entries for the
same event and category — enforced by the partial unique index
`waitlist_entries_active_membership_key`, not a check-then-insert. Two
concurrent joins simply collide on the index; the loser gets a `409`.

### FIFO ordering

Queue order is `(joined_at, id)`, computed at query time from an index —
never stored as a mutable position column that would need renumbering every
time someone leaves ahead of others.

### What happens when a seat becomes available

`cancelBookingInTransaction` and the hold-expiration sweep are the only two
places a seat is ever released to `available`. Both, immediately after
releasing, enqueue a row into `waitlist_allocation_outbox` naming the event
and category — a plain `INSERT`, coalesced against any already-pending
signal for the same pair via a partial unique index and
`ON CONFLICT DO NOTHING`. Neither function scans the waitlist or creates an
offer itself, so the HTTP request confirming a cancellation stays fast and
holds no lock longer than releasing its own seats needs.

```
booking cancelled / hold expired
   -> show_seats set to 'available'                (same transaction)
   -> waitlist_allocation_outbox row inserted        (same transaction, coalesced)
   -> waitlist allocation worker claims it            (separate process/transaction)
   -> offer created, notification enqueued
```

### The allocation pass (`npm run worker:waitlist`)

One worker transaction per claimed outbox row, pairing seats and candidates
deterministically until either runs out:

```
loop:
  lock the next waiting candidate   FOR UPDATE SKIP LOCKED, ORDER BY joined_at, id
  if none: stop
  read the next available seat       ascending id, unlocked
  if none: stop (candidate stays 'waiting')
  mark the candidate 'offered'
  createHoldInTransaction(...)        the seat's real lock and claim
  insert the waitlist_offers row
  enqueue a WAITLIST_OFFER_CREATED notification
mark the outbox row processed
```

`SKIP LOCKED` is used on the **candidate** scan only — skipping a locked
queue position just means another worker already has it. The seat's own lock
inside `createHoldInTransaction` is a plain, blocking `FOR UPDATE`, because
silently abandoning a specific seat would be a different, worse kind of
mistake. If the seat this pass read as available gets claimed by an ordinary
customer reservation microseconds before the offer's hold locks it, a
`SAVEPOINT` around that one pairing rolls back just that attempt — the
candidate reverts to `waiting` — and the loop retries against a freshly read
seat list, rather than undoing every offer already made earlier in the pass.

A self-healing **reconcile** loop (`WAITLIST_RECONCILE_INTERVAL_MS`, default
30s) scans for event/categories with a waiting candidate and an available
seat but no pending outbox row, for the case a signal was somehow lost.

### Accepting an offer

`POST /api/v1/waitlist/offers/:offerId/accept` reads the offer (ownership
check only, no lock), then hands its `hold_id` straight to
`confirmHoldInTransaction` — identical to a direct booking confirmation.
Only after that succeeds are `waitlist_offers`/`waitlist_entries` stamped
`accepted`.

### Why acceptance and expiry cannot race incorrectly

Both paths reach `reservation_holds` through the identical lock order —
`show_seats` first, then the hold — and both touch `waitlist_offers` only
*afterwards* (`confirmHoldInTransaction` on accept, the expiration sweep's
`markOfferExpiredByHoldId` on expiry). Whichever transaction wins the hold's
row lock decides the outcome; the loser's own guarded `UPDATE` on
`reservation_holds` simply matches zero rows and throws before it ever
reaches the offer-specific update. A hold expiring under an in-flight accept
surfaces to the customer as `OFFER_EXPIRED`; a hold already confirmed
surfaces as `OFFER_ALREADY_ACCEPTED`.

### What is deliberately deferred

`waitlist_notification_outbox` is a durable producer with **no consumer**:
no email, SMS, or push notification is ever sent for a waitlist offer today
(this is different from ticket-issuance email, which *is* sent — see the
outbox in [DATABASE.md](DATABASE.md)). A customer only learns about an offer
by checking `GET /api/v1/waitlist/mine` in the product.
