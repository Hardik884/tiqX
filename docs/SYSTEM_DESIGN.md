# System design: seat holds and the waitlist

## Seat hold and TTL mechanism

A hold is a `reservation_holds` row (owner, event, `expires_at`) plus a
`reservation_hold_seats` junction naming which `show_seats` rows it covers.
Creating one is a single transaction: lock the requested seats, verify they
are all `available`, insert the hold and its seat links, flip the seats to
`held`. `expires_at` is computed by PostgreSQL as `now() + ttl`, never by the
application clock, so a skewed app-server cannot mint a hold outliving its
intended window.

Expiry is deliberately **not** a background-only concern. `expires_at` is a
plain timestamp, not a `CHECK` (a `CHECK` runs on write and can't express
"still valid as time passes"). A lapsed hold sits untouched until something
needs its seat — the *same request* that wants the seat expires the old hold
and reclaims it, under one lock, in one transaction. Correctness never
depends on a worker running on schedule; the worker exists to release seats
promptly with no incoming traffic, and to publish an expiry signal.

## Concurrency prevention

The seat lock is the entire mechanism — no Redis lock, no application mutex,
no advisory lock. Hold creation issues
`SELECT ... FROM show_seats WHERE id = ANY($seatIds) AND event_id = $eventId
ORDER BY id FOR UPDATE`. `FOR UPDATE` blocks every other transaction wanting
the same seat until this one commits or rolls back; the loser re-reads the
row *after* the lock is granted and sees the winner's actual result, not a
stale snapshot. `ORDER BY id` fixes lock order across every multi-seat
request, so overlapping requests always queue the same direction and can
never deadlock each other. If any requested seat turns out taken, the whole
transaction rolls back — no partial hold. The same discipline (seats
ascending by id, then the hold) is reused by confirmation, cancellation, and
waitlist offer creation/acceptance, so none of these paths can deadlock.

Duplicate *requests* (a client retrying after a timeout) are handled
separately, by a required `Idempotency-Key` header scoped `UNIQUE (user_id,
key)`. It is claimed with `INSERT ... ON CONFLICT DO NOTHING` inside the same
transaction as the operation it protects, so a concurrent duplicate blocks on
that index rather than racing ahead, then replays the first transaction's
committed response. A failed attempt commits nothing, so a retry after
failure is a fresh attempt, not a replayed error.

## Waitlist auto-assignment flow

An offer is not a new state machine — it's a `reservation_holds` row with a
`waitlist_offers` wrapper (`hold_id`, `UNIQUE`) recording which entry earned
it, letting offer creation and acceptance reuse the same transactional
functions as an ordinary hold and confirmation.

Seat release (cancellation or hold expiry) never scans the waitlist itself —
it only inserts one row into `waitlist_allocation_outbox` naming
`(event_id, seat_category)`, coalesced against any pending signal via a
partial unique index, so a burst of releases collapses into one pending row
per category. A worker claims that row (`FOR UPDATE SKIP LOCKED`)
and runs a deterministic pairing loop: lock the next FIFO candidate
(`ORDER BY joined_at, id`, `SKIP LOCKED` so workers never fight over one
candidate), read the next available seat, create a hold, insert the offer,
repeat until candidates or seats run out.
`SKIP LOCKED` applies to the candidate scan only — the seat's own lock is a
real blocking `FOR UPDATE`, since silently skipping a specific seat would be
a correctness bug, not a scheduling nicety. If a seat gets taken by an
ordinary customer just before the offer's hold locks it, a `SAVEPOINT` rolls
back that one pairing and the loop retries against a fresh seat list.

## Time-limited waitlist offer handling

An offer's expiry is its backing hold's expiry — there is no second timer.
When the hold-expiration sweep frees a lapsed hold's seat, it also checks
whether that hold backed an offer and, if so, marks the offer and its entry
`expired` in the same transaction. Acceptance
(`POST /waitlist/offers/:id/accept`) hands the offer's `hold_id` straight to
the ordinary confirm-hold transaction; because both acceptance and expiry
lock in the same order (seats, hold, then only afterward the offer row),
whichever reaches the hold's lock first wins, and the loser's own guarded
update matches zero rows and fails cleanly instead of corrupting state.

## PostgreSQL, outboxes, Redis, and failure

PostgreSQL is authoritative for every fact that matters: seat status, hold
state, idempotency, tokens. Redis holds only derived signals — rate-limit
counters, a hold's expiry-timer key (TTL computed inside PostgreSQL),
pub/sub for the WebSocket feed — all disposable. Since PostgreSQL and Redis
can't share a transaction, every cross-system effect (a Redis expiry key, a
ticket email, a seat broadcast) is first written as a durable outbox row in
the *same* transaction as the domain change, then delivered by a worker
polling with `FOR UPDATE SKIP LOCKED`, retried with PostgreSQL-computed
backoff on failure. Delivery is at-least-once — safe because every
downstream effect is itself idempotent.
