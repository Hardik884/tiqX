import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

const WAITLIST_ENTRY_STATUSES = ['waiting', 'offered', 'accepted', 'expired', 'cancelled'] as const;
const WAITLIST_OFFER_STATUSES = ['offered', 'accepted', 'expired'] as const;
const SEAT_CATEGORIES = ['standard', 'premium'] as const;
const NOTIFICATION_TYPES = ['WAITLIST_OFFER_CREATED', 'WAITLIST_OFFER_EXPIRED'] as const;

/** Renders a value list for a CHECK constraint, e.g. `'waiting', 'offered'`. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * The waitlist: a customer's place in line for a seat category that is
 * currently sold out, and the time-limited offer they get when one opens up.
 *
 * Four tables, deliberately not fewer:
 *
 *   waitlist_entries             a customer's queue position for event+category
 *   waitlist_offers               one seat, temporarily set aside for one entry
 *   waitlist_allocation_outbox    durable "go look at this event+category" signal
 *   waitlist_notification_outbox  durable "tell this user" signal, unconsumed here
 *
 * WHY AN OFFER IS A RESERVATION HOLD. Inspection of reservation_holds found it
 * already means exactly what an offer needs: one user's time-limited claim on
 * seats of one event, with expiry decided by PostgreSQL and a release path
 * that already exists and is already tested. `waitlist_offers` therefore does
 * not duplicate that state machine - it wraps one `reservation_holds` row
 * (`hold_id`, UNIQUE) and adds only what a hold does not already carry: which
 * waitlist entry earned it, and its own status for the waitlist-facing API.
 * The seat's actual ownership - available / held / booked - is still decided
 * by `show_seats` and `reservation_holds` alone, exactly as it is for every
 * other path. See waitlist.service.ts for how this lets offer creation reuse
 * `createHoldInTransaction` and offer acceptance reuse
 * `confirmHoldInTransaction` verbatim, and expiration.service.ts for how offer
 * expiry rides the existing hold-expiration sweep instead of a second one.
 *
 * WHY NOT A MUTABLE POSITION COLUMN. Queue order is `(joined_at, id)`, read at
 * query time, never stored. A stored `position` would need renumbering every
 * time an entry leaves the queue ahead of others - an UPDATE fanning out to
 * every row behind it - for a value that is one ORDER BY away from being
 * computed for free.
 *
 * WHY THE OUTBOX ROW IS "event + category", NOT "this seat". A specific-seat
 * signal can go stale before a worker gets to it - the seat might already be
 * taken by an ordinary reservation - and would then have to be reprocessed
 * into "look at the category instead" anyway. Signalling the category
 * directly means one worker pass naturally picks up whatever is currently
 * available, however many seats and however many signals produced it, and the
 * partial unique index below coalesces repeat signals for a still-unprocessed
 * category into the row already waiting rather than growing the table.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // ---------------------------------------------------------------------------
  // waitlist_entries
  // ---------------------------------------------------------------------------
  pgm.createTable('waitlist_entries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // Not a financial record and not history worth keeping once its owner is
    // gone - the same reasoning reservation_holds already applies to both of
    // these columns.
    event_id: {
      type: 'uuid',
      notNull: true,
      references: 'events(id)',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    // A customer joins a category, not a physical seat - see the task's own
    // domain model. Checked against the same fixed vocabulary venue_seats.
    // category uses, so the two can never drift apart.
    seat_category: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'waiting' },
    joined_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('waitlist_entries', 'waitlist_entries_seat_category_check', {
    check: `seat_category IN (${sqlList(SEAT_CATEGORIES)})`,
  });
  pgm.addConstraint('waitlist_entries', 'waitlist_entries_status_check', {
    check: `status IN (${sqlList(WAITLIST_ENTRY_STATUSES)})`,
  });

  // THE DUPLICATE-MEMBERSHIP GUARD. `waiting` and `offered` both count as
  // active membership - a customer already in line, or already holding the
  // one offer their place in line has earned, must not be able to queue a
  // second time for the same event and category. `accepted`, `expired` and
  // `cancelled` are history: once an entry leaves the active states it never
  // re-enters them (see waitlist.service.ts), so a customer whose earlier
  // attempt ended one of those ways is free to join again. A partial unique
  // index makes this the database's guarantee, not a SELECT-then-INSERT the
  // application could race - two concurrent join attempts collide on this
  // index, and the loser gets a constraint violation, not a duplicate row.
  pgm.createIndex('waitlist_entries', ['event_id', 'user_id', 'seat_category'], {
    name: 'waitlist_entries_active_membership_key',
    unique: true,
    where: "status IN ('waiting', 'offered')",
  });

  // THE FIFO CANDIDATE SCAN: WHERE event_id = ? AND seat_category = ? AND
  // status = 'waiting' ORDER BY joined_at, id. Partial on `waiting` because
  // every other status is exactly what this query excludes, and accumulates
  // forever; `id` is a deterministic tie-breaker for the case two entries
  // share a `joined_at` (a burst of concurrent joins can genuinely tie at
  // whatever resolution the column stores), so the queue order never depends
  // on a comparison PostgreSQL treats as equal.
  pgm.createIndex('waitlist_entries', ['event_id', 'seat_category', 'joined_at', 'id'], {
    name: 'waitlist_entries_waiting_fifo_idx',
    where: "status = 'waiting'",
  });

  pgm.createTrigger('waitlist_entries', 'waitlist_entries_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  // ---------------------------------------------------------------------------
  // waitlist_offers
  // ---------------------------------------------------------------------------
  pgm.createTable('waitlist_offers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    waitlist_entry_id: {
      type: 'uuid',
      notNull: true,
      references: 'waitlist_entries(id)',
      onDelete: 'CASCADE',
    },
    show_seat_id: {
      type: 'uuid',
      notNull: true,
      references: 'show_seats(id)',
      onDelete: 'CASCADE',
    },
    // The reservation_holds row that actually owns the seat for the life of
    // this offer - see the migration's top comment. UNIQUE because each offer
    // gets a hold created fresh for it; no two offers ever share one.
    hold_id: {
      type: 'uuid',
      notNull: true,
      references: 'reservation_holds(id)',
      onDelete: 'CASCADE',
    },
    // A snapshot of the backing hold's own expires_at, taken once at creation.
    // Offer expiry is still decided by the hold - see expiration.service.ts -
    // this column exists so the pending-offer queries below never need to
    // join back to reservation_holds just to read it.
    expires_at: { type: 'timestamptz', notNull: true },
    status: { type: 'text', notNull: true, default: 'offered' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    accepted_at: { type: 'timestamptz' },
    expired_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('waitlist_offers', 'waitlist_offers_status_check', {
    check: `status IN (${sqlList(WAITLIST_OFFER_STATUSES)})`,
  });
  // Each timestamp is present exactly when its status says it should be - the
  // same discipline tickets_used_at_consistency_check applies to tickets.
  pgm.addConstraint('waitlist_offers', 'waitlist_offers_accepted_at_consistency_check', {
    check: `(status = 'accepted') = (accepted_at IS NOT NULL)`,
  });
  pgm.addConstraint('waitlist_offers', 'waitlist_offers_expired_at_consistency_check', {
    check: `(status = 'expired') = (expired_at IS NOT NULL)`,
  });
  pgm.addConstraint('waitlist_offers', 'waitlist_offers_hold_id_key', {
    unique: ['hold_id'],
  });

  // ONE LIVE OFFER PER SEAT, ONE LIVE OFFER PER ENTRY. Both are already
  // implied structurally - a seat only ever backs one offer because
  // `createHoldInTransaction` will not hand out an already-held seat, and an
  // entry only ever gets one offer because allocation claims it with a guarded
  // UPDATE before creating one - but a partial unique index makes each of them
  // a constraint the database enforces on its own, not merely a property of
  // the code happening to be correct. Both are partial on `offered`: once an
  // offer is accepted or expired it is history, and the seat or entry it
  // named is free to appear in a new live offer.
  pgm.createIndex('waitlist_offers', 'show_seat_id', {
    name: 'waitlist_offers_active_seat_key',
    unique: true,
    where: "status = 'offered'",
  });
  pgm.createIndex('waitlist_offers', 'waitlist_entry_id', {
    name: 'waitlist_offers_active_entry_key',
    unique: true,
    where: "status = 'offered'",
  });

  // ---------------------------------------------------------------------------
  // waitlist_allocation_outbox
  // ---------------------------------------------------------------------------
  pgm.createTable('waitlist_allocation_outbox', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    event_id: {
      type: 'uuid',
      notNull: true,
      references: 'events(id)',
      onDelete: 'CASCADE',
    },
    seat_category: { type: 'text', notNull: true },
    available_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    processed_at: { type: 'timestamptz' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('waitlist_allocation_outbox', 'waitlist_allocation_outbox_seat_category_check', {
    check: `seat_category IN (${sqlList(SEAT_CATEGORIES)})`,
  });
  pgm.addConstraint('waitlist_allocation_outbox', 'waitlist_allocation_outbox_attempts_check', {
    check: 'attempts >= 0',
  });

  // Coalesces repeat signals: several cancellations for the same event and
  // category before a worker gets to any of them collapse into the one row
  // already pending, via ON CONFLICT DO NOTHING - see
  // enqueueWaitlistAllocation in waitlist.repository.ts. Partial on
  // unprocessed rows for the same reason hold_expiration_outbox's index is:
  // processed rows accumulate forever and this index must never see them.
  pgm.createIndex('waitlist_allocation_outbox', ['event_id', 'seat_category'], {
    name: 'waitlist_allocation_outbox_pending_key',
    unique: true,
    where: 'processed_at IS NULL',
  });

  // The claim query: WHERE processed_at IS NULL AND available_at <= now()
  // ORDER BY available_at FOR UPDATE SKIP LOCKED - identical shape to
  // hold_expiration_outbox_pending_idx, for the identical reason.
  pgm.createIndex('waitlist_allocation_outbox', 'available_at', {
    name: 'waitlist_allocation_outbox_pending_idx',
    where: 'processed_at IS NULL',
  });

  // ---------------------------------------------------------------------------
  // waitlist_notification_outbox
  // ---------------------------------------------------------------------------
  //
  // Produced only. No consumer exists yet - email is explicitly out of scope -
  // so this is the durable half of "tell this user" with nothing reading it
  // for now. `payload` carries exactly the safe identifiers a notification
  // needs (offer id, user id, event id, expiry) and nothing a credential could
  // ever be built from.
  pgm.createTable('waitlist_notification_outbox', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    offer_id: {
      type: 'uuid',
      notNull: true,
      references: 'waitlist_offers(id)',
      onDelete: 'CASCADE',
    },
    type: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    processed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('waitlist_notification_outbox', 'waitlist_notification_outbox_type_check', {
    check: `type IN (${sqlList(NOTIFICATION_TYPES)})`,
  });

  pgm.createIndex('waitlist_notification_outbox', 'offer_id', {
    name: 'waitlist_notification_outbox_offer_id_idx',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Reverse dependency order. Each drop takes its own constraints, indexes
  // and trigger with it; nothing outside these four tables is touched.
  pgm.dropTable('waitlist_notification_outbox');
  pgm.dropTable('waitlist_allocation_outbox');
  pgm.dropTable('waitlist_offers');
  pgm.dropTable('waitlist_entries');
}
