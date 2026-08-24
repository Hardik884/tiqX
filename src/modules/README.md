# Modules

Each feature lives in its own folder and owns its routes, controllers, services
and data access. A module is wired into the API by mounting its router in
`src/routes/index.ts`.

Conventions (see `health/` for the working example):

```
<module>/
  <module>.routes.ts      HTTP routes
  <module>.controller.ts  request/response handling
  <module>.service.ts     business rules
  <module>.repository.ts  SQL, using src/db/pool
  <module>.types.ts       shared types
```

`events`, `venues`, `seats` and `reservations` are partially implemented: event
creation with its derived seat inventory, and the transactional hold operation
that temporarily reserves seats. `auth` is implemented: registration, login,
JWT access tokens and rotating refresh tokens, plus the middleware that other
modules mount. `bookings` and `tickets` are implemented: confirming a hold,
cancelling a booking, and the ticket a confirmed booking earns, including
atomic verification. `waitlist` is implemented: queueing for a sold-out
event/category and allocating a time-limited offer when a seat frees up, on
its own outbox/worker. `notifications` is partially implemented:
ticket-delivery email only (an `EmailProvider` abstraction - mock and Resend -
driven by the same outbox/worker pattern `expiration` and `waitlist` use), not
the in-app notifications this table originally described. `idempotency` is a
supporting module rather than a feature: it wraps a write so retrying it is
safe. Folders that hold only a `.gitkeep` are placeholders and intentionally
contain no code yet.

| Module          | Planned responsibility                          |
| --------------- | ----------------------------------------------- |
| `auth`          | registration, login, tokens, guards             |
| `users`         | profile management                              |
| `venues`        | venues and their physical seat layout           |
| `events`        | movies and concerts scheduled at a venue        |
| `seats`         | per-event seat inventory (`show_seats`)         |
| `reservations`  | temporary seat holds (`reservation_holds`)      |
| `bookings`      | confirming a hold into a durable booking, and cancelling one |
| `tickets`       | one per confirmed booking seat, and its verification |
| `waitlist`      | queueing for sold-out event/categories, and time-limited offers when a seat frees up |
| `notifications` | ticket-delivery email (outbox-driven); in-app notifications still unplanned |
| `analytics`     | reporting for organisers and admins             |
| `idempotency`   | stored responses for safely retryable writes    |
| `rate-limit`    | Redis-backed distributed request limiting       |
| `users`         | shared role vocabulary                          |
