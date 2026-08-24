# tiqX frontend

Customer-facing booking UI: event discovery, live seat map, hold → checkout →
confirmation, tickets, and waitlist. React + TypeScript + Vite + Tailwind.

## Run

```bash
npm install
npm run dev
```

The dev server proxies `/api` and `/ws` to the backend at `localhost:4000`
(see `vite.config.ts`) - run the backend separately with `npm run dev` from
the repo root.

## Build

```bash
npm run build
```
