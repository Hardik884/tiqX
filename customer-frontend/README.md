# tiqX web app

The whole tiqX product in one Vite/React app — customer, organiser and admin —
so there is one deployment, one session and one visual identity.

- **Customer** (`/`, `/events`, `/events/:id`, `/checkout`, `/bookings`,
  `/waitlist`): discovery, the live seat map, holds with a countdown,
  checkout, QR tickets, cancellation and the waitlist.
- **Organiser** (`/organiser/*`): dashboard, event list, create/edit an event
  (venue, date/time, per-category pricing), publish, and per-event bookings
  and revenue.
- **Admin** (`/admin/*`): platform totals, venues and their seat layout
  (premium/standard), every organiser's events, and account roles.

React + TypeScript + Vite + Tailwind.

## Roles

The role wrappers in `App.tsx` decide what renders; they are not the security
boundary. Every management endpoint re-checks the caller's role server-side
and re-reads it from the database rather than trusting the token, so a
customer who types `/admin` gets a redirect here and a 403 from the API.

## Run

```bash
npm install
npm run dev
```

The dev server proxies `/api` and `/ws` to the backend at `localhost:4000`
(see `vite.config.ts`) — run the backend separately with `npm run dev` from
the repo root.

## Build

```bash
npm run build
```

Type-checks, then emits `dist/`. Deployed as a Vercel project rooted at this
directory: `vercel.json` rewrites `/api/*` to the API's origin and everything
else to `index.html`, which is what makes a direct hit on `/organiser/events`
or `/admin/venues` resolve. The real-time client connects straight to the
API's own `wss://.../ws` — a WebSocket upgrade does not survive that
HTTP-layer rewrite (see `src/lib/seatSocket.ts`).
