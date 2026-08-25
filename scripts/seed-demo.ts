/**
 * Seeds the accounts and data a reviewer needs to exercise all three roles.
 *
 * Registration deliberately never accepts a role from a client, and there is no
 * way to bootstrap the first admin through the API - so without this, a fresh
 * database can only ever produce customers, and the organiser and admin halves
 * of the product are unreachable. That gap is exactly what this closes.
 *
 * Run it with `npm run seed:demo` against a migrated database. Safe to re-run:
 * every step is "create it if it isn't there", so nothing is duplicated and no
 * existing row is overwritten - an account that already exists keeps whatever
 * password it has rather than having this script's reset onto it.
 *
 * The sign-in secret is never stored in this repository: set DEMO_PASSWORD to
 * choose one, or let the script generate one and print it. It also refuses to
 * touch a production database unless you say so explicitly with --force, since
 * accounts created here are meant for evaluation rather than for real use.
 */
import { randomBytes } from 'node:crypto';

import { config } from '../src/config/index.js';
import { closePool, pool } from '../src/db/pool.js';
import { insertUser } from '../src/modules/auth/auth.repository.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { createEvent } from '../src/modules/events/event.service.js';
import type { EventCategory, EventType } from '../src/modules/events/event.types.js';
import type { UserRole } from '../src/modules/users/user.types.js';

/** Matches the registration policy in auth.schema.ts - anything shorter is rejected. */
const MIN_LENGTH = 12;

/**
 * The secret every demo account signs in with.
 *
 * Taken from DEMO_PASSWORD when set, so an operator picks their own and it
 * never has to exist in version control. Otherwise a random one is generated
 * and printed once, at the end of the run - which is the safe default: a value
 * committed here would be the same on every deployment that ever ran this
 * script, which is the property that makes a default credential dangerous.
 */
function resolvePassword(): { value: string; generated: boolean } {
  const supplied = process.env.DEMO_PASSWORD;

  if (supplied !== undefined && supplied !== '') {
    if (supplied.length < MIN_LENGTH) {
      throw new Error(`DEMO_PASSWORD must be at least ${MIN_LENGTH} characters`);
    }
    return { value: supplied, generated: false };
  }

  return { value: `demo-${randomBytes(9).toString('base64url')}`, generated: true };
}



const DEMO_USERS: { email: string; name: string; role: UserRole }[] = [
  { email: 'admin@tiqx.demo', name: 'tiqX Demo Admin', role: 'admin' },
  { email: 'organiser@tiqx.demo', name: 'tiqX Demo Organiser', role: 'organiser' },
  { email: 'customer@tiqx.demo', name: 'tiqX Demo Customer', role: 'customer' },
];

interface SeatBlock {
  rowLabel: string;
  seats: number;
  category: 'standard' | 'premium';
}

const DEMO_VENUE = {
  name: 'Aurora Arena',
  description: 'Demo venue seeded for reviewing tiqX.',
  city: 'Mumbai',
  layout: [
    { rowLabel: 'A', seats: 10, category: 'premium' },
    { rowLabel: 'B', seats: 10, category: 'premium' },
    { rowLabel: 'C', seats: 10, category: 'standard' },
    { rowLabel: 'D', seats: 10, category: 'standard' },
  ] satisfies SeatBlock[],
};

function daysFromNow(days: number, hour: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date;
}

const DEMO_EVENTS: {
  title: string;
  description: string;
  category: EventCategory;
  eventType: EventType;
  startsIn: number;
  status: 'draft' | 'published';
}[] = [
  {
    title: 'Neon Nights Live',
    description: 'An electric night of indie rock to open the season.',
    category: 'music',
    eventType: 'concert',
    startsIn: 21,
    status: 'published',
  },
  {
    title: 'Standup Marathon',
    description: 'Six comics, one stage, no interval.',
    category: 'comedy',
    eventType: 'concert',
    startsIn: 30,
    status: 'published',
  },
  {
    title: 'Twelfth Night — Winter Run',
    description: 'Left as a draft so the publish flow has something to publish.',
    category: 'theatre',
    eventType: 'concert',
    startsIn: 45,
    status: 'draft',
  },
];

async function ensureUser(user: (typeof DEMO_USERS)[number], password: string): Promise<string> {
  const existing = await pool.query<{ id: string; role: string }>(
    'SELECT id, role FROM users WHERE lower(email) = lower($1)',
    [user.email],
  );

  const found = existing.rows[0];
  if (found !== undefined) {
    // The role is corrected if it drifted, but the stored digest is left
    // alone: re-running this must never overwrite one someone has changed.
    if (found.role !== user.role) {
      await pool.query('UPDATE users SET role = $2 WHERE id = $1', [found.id, user.role]);
      console.log(`  ~ ${user.email} role corrected to ${user.role}`);
    } else {
      console.log(`  = ${user.email} (${user.role}) already exists`);
    }
    return found.id;
  }

  const created = await insertUser(pool, {
    email: user.email,
    name: user.name,
    passwordHash: await hashPassword(password),
    role: user.role,
  });
  console.log(`  + ${user.email} (${user.role})`);
  return created.id;
}

async function ensureVenue(): Promise<string> {
  const existing = await pool.query<{ id: string }>('SELECT id FROM venues WHERE name = $1', [
    DEMO_VENUE.name,
  ]);

  let venueId = existing.rows[0]?.id;
  if (venueId === undefined) {
    const inserted = await pool.query<{ id: string }>(
      'INSERT INTO venues (name, description, city) VALUES ($1, $2, $3) RETURNING id',
      [DEMO_VENUE.name, DEMO_VENUE.description, DEMO_VENUE.city],
    );
    venueId = inserted.rows[0]!.id;
    console.log(`  + venue ${DEMO_VENUE.name}`);
  } else {
    console.log(`  = venue ${DEMO_VENUE.name} already exists`);
  }

  // ON CONFLICT DO NOTHING against the (venue, row, seat) unique constraint, so
  // a partly-built layout is topped up rather than duplicated or rejected.
  for (const block of DEMO_VENUE.layout) {
    await pool.query(
      `INSERT INTO venue_seats (venue_id, row_label, seat_number, category)
       SELECT $1, $2, seat.n, $4
       FROM generate_series(1, $3) AS seat(n)
       ON CONFLICT ON CONSTRAINT venue_seats_venue_row_seat_key DO NOTHING`,
      [venueId, block.rowLabel, block.seats, block.category],
    );
  }

  const seats = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM venue_seats WHERE venue_id = $1',
    [venueId],
  );
  console.log(`    layout: ${seats.rows[0]?.count ?? '0'} seats`);

  return venueId;
}

async function ensureEvent(
  organiserId: string,
  venueId: string,
  spec: (typeof DEMO_EVENTS)[number],
): Promise<void> {
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM events WHERE title = $1 AND organiser_id = $2',
    [spec.title, organiserId],
  );

  if (existing.rows[0] !== undefined) {
    console.log(`  = event ${spec.title} already exists`);
    return;
  }

  const startsAt = daysFromNow(spec.startsIn, 19);
  const endsAt = new Date(startsAt.getTime() + 3 * 60 * 60 * 1000);

  // Through the real service, so the event and its seat inventory are created
  // exactly the way the API creates them: one transaction, each seat priced
  // from its category in the venue layout.
  const result = await createEvent({
    organiserId,
    venueId,
    title: spec.title,
    description: spec.description,
    category: spec.category,
    eventType: spec.eventType,
    startsAt,
    endsAt,
    status: spec.status,
    pricing: { standard: '499.00', premium: '999.00' },
    currency: 'INR',
  });

  console.log(`  + event ${spec.title} (${spec.status}, ${result.seatInventoryCount} seats)`);
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  if (config.env === 'production' && !force) {
    console.error(
      'Refusing to seed a production environment: these accounts exist to be\n' +
        'handed out for evaluation, which is not what a live deployment wants.\n' +
        'Re-run with --force if it genuinely is.',
    );
    process.exitCode = 1;
    return;
  }

  // Resolved here rather than at import, so a DEMO_PASSWORD that is too short
  // is reported as a one-line message by the handler below instead of an
  // unhandled throw during module evaluation.
  const password = resolvePassword();

  console.log('Seeding tiqX demo data\n');

  console.log('Accounts:');
  const ids = new Map<string, string>();
  for (const user of DEMO_USERS) {
    ids.set(user.email, await ensureUser(user, password.value));
  }

  console.log('\nVenue:');
  const venueId = await ensureVenue();

  console.log('\nEvents:');
  const organiserId = ids.get('organiser@tiqx.demo')!;
  for (const spec of DEMO_EVENTS) {
    await ensureEvent(organiserId, venueId, spec);
  }

  console.log('\nDone.');
  console.log('  admin@tiqx.demo      → /admin');
  console.log('  organiser@tiqx.demo  → /organiser');
  console.log('  customer@tiqx.demo   → browse and book from /');

  if (password.generated) {
    // Printed once and nowhere else: from here on it exists only as an Argon2
    // digest in the database.
    console.log(`\nGenerated sign-in secret (shown once): ${password.value}`);
    console.log('Set DEMO_PASSWORD to choose your own instead.');
  } else {
    console.log('\nAll three sign in with the DEMO_PASSWORD you supplied.');
  }
}

main()
  .catch((error: unknown) => {
    console.error('Seeding failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
