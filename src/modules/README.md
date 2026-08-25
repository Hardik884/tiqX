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

| Module | Responsibility |
| --- | --- |
| `auth` | registration, login, JWT access tokens, rotating refresh tokens, and the middleware other modules mount |
| `users` | account role management — promoting an account to organiser or admin |
| `venues` | venues and their physical seat layout (row-by-row, premium/standard categories) |
| `events` | event creation and publishing, discovery/search, and the organiser and admin dashboards |
| `seats` | per-event seat inventory (`show_seats`), derived from a venue's layout at event creation |
| `reservations` | the transactional seat hold — TTL, row locks, idempotency |
| `bookings` | confirming a hold into a durable booking, and cancelling one |
| `tickets` | one per confirmed booking seat, QR issuance, and atomic verification |
| `waitlist` | queueing for a sold-out event/category, and time-limited offers when a seat frees up, on its own outbox/worker |
| `notifications` | ticket-delivery email, via an `EmailProvider` abstraction (mock and Resend) driven by the same outbox/worker pattern `expiration` and `waitlist` use |
| `idempotency` | stores responses so a retried write is safe to repeat |
| `rate-limit` | Redis-backed distributed request limiting |
| `expiration` | the hold-expiration sweep and its outbox |
| `realtime` | the seat-status outbox that feeds the WebSocket layer |
| `health` | liveness/readiness probes |
