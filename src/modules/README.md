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
modules mount. `idempotency` is a supporting module rather than a feature: it
wraps a write so retrying it is safe. Folders that hold only a `.gitkeep` are placeholders
and intentionally contain no code yet.

| Module          | Planned responsibility                          |
| --------------- | ----------------------------------------------- |
| `auth`          | registration, login, tokens, guards             |
| `users`         | profile management                              |
| `venues`        | venues and their physical seat layout           |
| `events`        | movies and concerts scheduled at a venue        |
| `seats`         | per-event seat inventory (`show_seats`)         |
| `reservations`  | temporary seat holds (`reservation_holds`)      |
| `bookings`      | confirmed bookings and payment state            |
| `waitlist`      | queueing for sold-out events                    |
| `notifications` | email and in-app notifications                  |
| `analytics`     | reporting for organisers and admins             |
| `idempotency`   | stored responses for safely retryable writes    |
| `users`         | shared role vocabulary                          |
