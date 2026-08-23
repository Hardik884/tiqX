import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

const USER_ROLES = ['customer', 'organiser', 'admin'] as const;
const SEAT_CATEGORIES = ['standard', 'premium'] as const;
const EVENT_TYPES = ['movie', 'concert'] as const;
const EVENT_STATUSES = ['draft', 'published', 'cancelled', 'completed'] as const;

/** Renders a value list for a CHECK constraint, e.g. `'movie', 'concert'`. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export async function up(pgm: MigrationBuilder): Promise<void> {
  // gen_random_uuid() is built into PostgreSQL 13+; no extension required.

  // ---------------------------------------------------------------------------
  // updated_at maintenance
  // ---------------------------------------------------------------------------
  pgm.createFunction(
    'set_updated_at',
    [],
    { returns: 'trigger', language: 'plpgsql', replace: true },
    `
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    `,
  );

  // ---------------------------------------------------------------------------
  // users
  // ---------------------------------------------------------------------------
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    email: { type: 'text', notNull: true },
    password_hash: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true, default: 'customer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('users', 'users_name_not_blank_check', {
    check: 'char_length(btrim(name)) > 0',
  });
  pgm.addConstraint('users', 'users_email_shape_check', {
    check: "position('@' in email) > 1",
  });
  pgm.addConstraint('users', 'users_role_check', {
    check: `role IN (${sqlList(USER_ROLES)})`,
  });

  // Case-insensitive uniqueness: two accounts cannot differ only by casing.
  pgm.sql('CREATE UNIQUE INDEX users_email_lower_key ON users ((lower(email)));');

  pgm.createTrigger('users', 'users_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  // ---------------------------------------------------------------------------
  // venues
  // ---------------------------------------------------------------------------
  pgm.createTable('venues', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('venues', 'venues_name_not_blank_check', {
    check: 'char_length(btrim(name)) > 0',
  });

  pgm.createIndex('venues', 'name', { name: 'venues_name_idx' });

  pgm.createTrigger('venues', 'venues_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  // ---------------------------------------------------------------------------
  // venue_seats - the physical seat layout of a venue
  // ---------------------------------------------------------------------------
  pgm.createTable('venue_seats', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    venue_id: {
      type: 'uuid',
      notNull: true,
      references: 'venues(id)',
      onDelete: 'CASCADE',
    },
    row_label: { type: 'text', notNull: true },
    seat_number: { type: 'integer', notNull: true },
    category: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('venue_seats', 'venue_seats_row_label_not_blank_check', {
    check: 'char_length(btrim(row_label)) > 0',
  });
  pgm.addConstraint('venue_seats', 'venue_seats_seat_number_check', {
    check: 'seat_number > 0',
  });
  pgm.addConstraint('venue_seats', 'venue_seats_category_check', {
    check: `category IN (${sqlList(SEAT_CATEGORIES)})`,
  });

  // A physical seat exists once per venue. The index also serves lookups by
  // venue_id (and by venue_id + row_label), so no extra FK index is needed.
  pgm.addConstraint('venue_seats', 'venue_seats_venue_row_seat_key', {
    unique: ['venue_id', 'row_label', 'seat_number'],
  });

  pgm.createIndex('venue_seats', ['venue_id', 'category'], {
    name: 'venue_seats_venue_id_category_idx',
  });

  // ---------------------------------------------------------------------------
  // events - a movie screening or a concert/show
  // ---------------------------------------------------------------------------
  pgm.createTable('events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    organiser_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'RESTRICT',
    },
    venue_id: {
      type: 'uuid',
      notNull: true,
      references: 'venues(id)',
      onDelete: 'RESTRICT',
    },
    title: { type: 'text', notNull: true },
    description: { type: 'text' },
    event_type: { type: 'text', notNull: true },
    starts_at: { type: 'timestamptz', notNull: true },
    ends_at: { type: 'timestamptz', notNull: true },
    status: { type: 'text', notNull: true, default: 'draft' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('events', 'events_title_not_blank_check', {
    check: 'char_length(btrim(title)) > 0',
  });
  pgm.addConstraint('events', 'events_event_type_check', {
    check: `event_type IN (${sqlList(EVENT_TYPES)})`,
  });
  pgm.addConstraint('events', 'events_status_check', {
    check: `status IN (${sqlList(EVENT_STATUSES)})`,
  });
  pgm.addConstraint('events', 'events_time_range_check', {
    check: 'ends_at > starts_at',
  });

  pgm.createIndex('events', 'organiser_id', { name: 'events_organiser_id_idx' });
  pgm.createIndex('events', 'venue_id', { name: 'events_venue_id_idx' });
  pgm.createIndex('events', 'starts_at', { name: 'events_starts_at_idx' });
  // Serves the common "upcoming published events" listing.
  pgm.createIndex('events', ['status', 'starts_at'], { name: 'events_status_starts_at_idx' });

  pgm.createTrigger('events', 'events_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Reverse creation order so foreign keys are dropped before their targets.
  pgm.dropTable('events');
  pgm.dropTable('venue_seats');
  pgm.dropTable('venues');
  pgm.dropTable('users');
  pgm.dropFunction('set_updated_at', []);
}
