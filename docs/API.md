# API reference

Base URL: `http://localhost:4000` in development. Every feature route is
mounted under `/api/v1`; health checks are unversioned at `/health`.

Conventions used throughout:

- **Auth** — `Authorization: Bearer <accessToken>`. "Required" = `401` with
  no token; "optional" = the response varies with identity but anonymous
  access is allowed; "role: organiser/admin" = `403` for a customer.
- **Idempotency** — a required `Idempotency-Key: <1-255 printable ASCII chars>`
  header on every endpoint marked below. Missing/malformed → `400`; reused
  for a materially different request → `409`.
- **Errors** — every non-2xx response is `{ "error": { "code", "message", "details"?, "requestId"? } }`.
  Ownership failures (an existing resource that isn't yours) return `404`,
  identically to a nonexistent resource — never `403` — so an id can't be
  used to probe what exists.
- Pagination on organiser/admin list endpoints is page-based
  (`page`, `limit`, response includes `total`/`totalPages`); public event
  discovery uses an opaque keyset `cursor` instead (see below).

## Authentication

### `POST /api/v1/auth/register`
No auth. Rate-limited per IP.
Body: `{ email, password (12-200 chars), name? }`.
→ `201 { user: { id, email, name, role } }`. `409` on duplicate email
(case-insensitive).

### `POST /api/v1/auth/login`
No auth. Rate-limited per (email, IP).
Body: `{ email, password }`.
→ `200 { user, accessToken, tokenType, expiresIn, refreshToken, refreshTokenExpiresAt }`.
Wrong email or wrong password return the same generic `401` — never which
one was wrong.

### `POST /api/v1/auth/refresh`
No bearer token — authenticated by the refresh token itself. Rate-limited per IP.
Body: `{ refreshToken }`.
→ `200` new token pair. The presented token is revoked (rotation); replaying
an already-rotated token revokes the entire session chain.

### `POST /api/v1/auth/logout`
No auth required, unlimited. Body: `{ refreshToken }`. → `204`, always —
logging out is never an error.

### `GET /api/v1/auth/me`
Required auth. → `200 { user: { id, role } }`.

## Events, search & discovery

### `GET /api/v1/events`
Optional auth. Rate-limited per IP (public, unauthenticated, most expensive
read). Public discovery — full-text search + filters.
Query: `q?`, `category?` (`music|comedy|sports|theatre|other`),
`eventType?` (`movie|concert`), `city?`, `venueId?`, `startFrom?`/`startTo?`
(ISO datetime), `sort?` (`start_asc|start_desc|name_asc|name_desc`, default
`start_asc`), `limit?` (1-100, default 20), `cursor?` (opaque, from a
previous response; rejected if it doesn't match the current `sort`).
→ `200 { items: PublicEventView[], pagination: { limit, nextCursor, hasMore } }`.

### `GET /api/v1/events/:eventId`
Optional auth — a published event is visible to anyone; a draft is visible
only to its owning organiser or an admin (`404` otherwise, not `403`).
→ `200` a `PublicEventView` (or the organiser's own richer view when owned).

### `GET /api/v1/events/:eventId/seats`
Optional auth, same visibility rule as the event itself. The public seat map.
→ `200 { seats: [{ id, rowLabel, seatNumber, price, status: available|held|booked }] }`.
Never reveals whose hold or booking a seat belongs to.

### `POST /api/v1/events` · `PATCH /api/v1/events/:eventId` · `DELETE /api/v1/events/:eventId` · `POST /api/v1/events/:eventId/publish`
Role: organiser/admin. Resource ownership (does *this* organiser own *this*
event?) is checked in the service layer, not the route. Create body:
`{ venueId, title, eventType, startsAt, endsAt, description?, category?, pricing?: { standard?, premium? }, currency? }`.
Update accepts a subset of `title/description/category/startsAt/endsAt` only
— `venueId`/`eventType`/`status` cannot be changed this way. Publish and
delete take no body; delete is `204` and only allowed while still `draft`.

## Reservations / holds

### `POST /api/v1/events/:eventId/holds`
Required auth, required `Idempotency-Key`.
Body: `{ showSeatIds: string[] (1-10, unique), ttlSeconds?: 60-900, default 600 }`.
→ `201 { holdId, eventId, showSeatIds, status, expiresAt }`. `409` if any
requested seat is already held or booked (the whole request fails — no
partial hold). See [ARCHITECTURE.md](ARCHITECTURE.md) for the locking
mechanism.

### `POST /api/v1/events/:eventId/holds/:holdId/confirm`
Required auth, required `Idempotency-Key`. Converts a hold into a booking.
→ `201 { bookingId, bookingReference, eventId, holdId, status, seatCount, totalAmount, currency, createdAt }`.
`409` if the hold has expired, was already confirmed, or is otherwise
invalid.

## Bookings

### `GET /api/v1/bookings`
Required auth. The caller's own bookings.
Query: `page? (default 1)`, `limit? (1-100, default 20)`.
→ `200 { bookings: [...], page, limit, total, totalPages }`, each item
including event title/start time, venue name, live seat count, ticket count.

### `GET /api/v1/bookings/:bookingId`
Required auth, scoped to the caller (`404` for someone else's booking).
→ `200` full detail: booking, event/venue info, per-seat rows
(`rowLabel`, `seatNumber`, `price`, `cancelled`), and per-ticket rows
(`ticketReference`, `status`, `issuedAt`, `usedAt`).

### `POST /api/v1/bookings/:bookingId/cancel`
Required auth, required `Idempotency-Key`. Owner or an organiser/admin.
→ `200 { bookingId, bookingReference, eventId, status, releasedSeatCount, totalAmount, currency, cancelledAt }`.
`409` if already cancelled or a ticket has already been used. Releasing
seats enqueues a waitlist allocation signal — see
[ARCHITECTURE.md](ARCHITECTURE.md).

### `POST /api/v1/bookings/:bookingId/tickets/issue`
Required auth, required `Idempotency-Key`. Normally unnecessary — tickets
are issued automatically at confirmation and emailed via the outbox — this
endpoint replays/repeats issuance idempotently for the same booking.
→ `201 { bookingId, eventId, ticketCount, tickets: [{ ticketId, ticketReference, status, issuedAt, qrPayload }] }`.
`qrPayload` (`{ v: 1, ticketId, ticketReference }`) is the value a QR code
encodes; this API returns the payload, not an image — rendering is a client
concern.

## Waitlist

### `POST /api/v1/events/:eventId/waitlist`
Required auth, required `Idempotency-Key`. Body: `{ seatCategory: standard|premium }`.
→ `201 { waitlistEntryId, eventId, seatCategory, status }`. `409` if already
actively queued (`waiting`/`offered`) for this event+category.

### `POST /api/v1/events/:eventId/waitlist/:entryId/leave`
Required auth, no idempotency key needed (naturally idempotent).
→ `200 { waitlistEntryId, status }`. Only a `waiting` entry can leave.

### `GET /api/v1/waitlist/mine`
Required auth. Every entry the caller has ever joined, any status, newest
first, each joined with event/venue info and its currently-`offered` offer
(if any).
→ `200 { entries: [{ waitlistEntryId, eventId, eventTitle, eventStartsAt, venueName, seatCategory, status, joinedAt, offer: { offerId, expiresAt, status } | null }] }`.

### `POST /api/v1/waitlist/offers/:offerId/accept`
Required auth, required `Idempotency-Key`. Converts a time-limited offer
into a confirmed booking via the same path as a direct hold confirmation.
→ `200 { offerId, eventId, status, bookingId, bookingReference }`. `409` if
the offer has expired or was already accepted.

## Tickets / QR verification

### `POST /api/v1/tickets/:ticketId/verify`
Role: organiser/admin (door-staff stand-in — there is no dedicated gate-staff
role). Rate-limited per authenticated user. Marks a ticket used; a
double-scan is answered by the ticket's own state, not replayed.
→ `200 { ticketReference, status, usedAt, eventId, seatId, verifiedAt }`.
`409` if already used or void.

## Organiser / admin

### `GET /api/v1/organiser/events`
Role: organiser/admin. "My events", paginated (`page`, `limit`). Admin-only
escape hatch: `all=true` lists every organiser's events.
→ `200 { events, page, limit, total, totalPages }`.

### `GET /api/v1/organiser/dashboard`
Role: organiser/admin. Aggregate headline numbers across the caller's events
(`all=true` for an admin, across every organiser's).
→ `200 { upcomingEvents, totalBookings, seatsSold, availableSeats, revenue }`.

### `GET /api/v1/organiser/events/:eventId/summary`
Role: organiser/admin, ownership-checked.
→ `200 { totalBookings, seatsSold, availableSeats, revenue, currency }`.

### `GET /api/v1/organiser/events/:eventId/bookings`
Role: organiser/admin, ownership-checked, paginated (`page`, `limit`).
→ `200 { bookings: [{ id, bookingReference, status, totalAmount, currency, seatCount, customerName, customerEmail, createdAt }], page, limit, total, totalPages }`.

## Venues & seat layout

Reads are organiser/admin (an organiser has to pick a venue and see what they
are selling); every write is **admin only**. A venue's `venue_seats` layout is
the source an event's `show_seats` inventory is derived from — once, at event
creation — so changes here shape events created afterwards and never alter an
existing event's seat map.

### `GET /api/v1/venues`
Role: organiser/admin. Every venue with its physical seat count.
→ `200 { venues: [{ id, name, description, city, seatCount }] }`.

### `GET /api/v1/venues/:venueId`
Role: organiser/admin. One venue, with per-category seat totals and how many
events already derived inventory from this layout.
→ `200 { venue: { id, name, description, city, seatCount, seatsByCategory: { standard, premium }, eventCount } }`.

### `POST /api/v1/venues`
Role: admin. Body `{ name, description?, city? }`.
→ `201 { venue }`.

### `PATCH /api/v1/venues/:venueId`
Role: admin. Body: any of `{ name, description, city }` (an empty string
clears a nullable column).
→ `200 { venue }`.

### `GET /api/v1/venues/:venueId/seats`
Role: organiser/admin. The physical layout — not any event's inventory.
→ `200 { seats: [{ id, rowLabel, seatNumber, category }] }`.

### `POST /api/v1/venues/:venueId/seats`
Role: admin. Adds contiguous blocks of seats:
`{ rows: [{ rowLabel, fromSeat, toSeat, category }] }` (max 26 rows per
request, 100 seats per row). Idempotent — a seat that already exists is left
untouched, never re-categorised.
→ `201 { created, seats }`.

### `PATCH /api/v1/venues/:venueId/seats/:seatId`
Role: admin. Body `{ category }` — `standard` or `premium`. Existing events
keep the price they derived at creation; `show_seats.price` is stored, not
looked up through the category.
→ `200 { seats }`.

### `DELETE /api/v1/venues/:venueId/seats/:seatId`
Role: admin. `409` if any event's seat map still refers to this seat.
→ `200 { seats }`.

## Account administration

### `GET /api/v1/admin/users`
Role: admin. Paginated (`page`, `limit`), optional `q` matching name or email.
→ `200 { users: [{ id, name, email, role, createdAt }], page, limit, total, totalPages }`.

### `PATCH /api/v1/admin/users/:userId/role`
Role: admin. Body `{ role }` — `customer`, `organiser` or `admin`. Registration
never accepts a role from the client, so this is the only way an organiser
account comes to exist. An admin cannot change their own role (`409`), which
is what stops the last admin locking everyone out. The new role applies to the
target's next request — the API re-reads it from the database rather than
trusting a token they already hold.
→ `200 { user }`.

## Health / readiness

### `GET /health`
No auth. Liveness only — confirms the process is up. Never touches a
dependency.
→ `200 { status: "ok", uptimeSeconds, timestamp }`.

### `GET /health/ready`
No auth. Probes PostgreSQL and Redis. Reports states only, never a
connection string or error detail (both can carry credentials).
→ `200 { status: "ok", dependencies: { database, redis } }` when both are
`up`, else `503 { status: "unavailable", dependencies }`.

## Real-time seat status (WebSocket, not REST)

`ws://<host>/ws` — optionally authenticated the same way as the REST seat map
(`Authorization: Bearer` on the upgrade request; no token still connects,
scoped to what an anonymous caller may see).

Client → server: `{ type: "SUBSCRIBE_EVENT" | "UNSUBSCRIBE_EVENT", eventId }`.
Server → client: `{ type: "SEAT_HELD" | "SEAT_RELEASED" | "SEAT_BOOKED", version: 1, eventId, seatId, status, seatVersion, occurredAt }`,
plus `SUBSCRIBED`/`UNSUBSCRIBED` acknowledgements and `{ type: "ERROR", code, message }`.
The REST seat map remains the authoritative snapshot; this delivers only
what changes after a client has fetched one. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the outbox that feeds it.
