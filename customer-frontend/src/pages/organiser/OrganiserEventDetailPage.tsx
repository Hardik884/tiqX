import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteEvent,
  getEventSeatMap,
  getEventSummary,
  getManagedEvent,
  publishEvent,
} from '../../api/organiser';
import type { EventBookingSummary, ManagedEventView, SeatMapEntry } from '../../api/types';
import { Button } from '../../components/Button';
import { ErrorState, InlineNote, Spinner } from '../../components/Feedback';
import { StatusBadge } from '../../components/StatusBadge';
import { ConfirmDialog } from '../../components/manage/ConfirmDialog';
import { PageHeader } from '../../components/manage/PageHeader';
import { StatCard, StatGrid } from '../../components/manage/StatCard';
import { formatAmount, formatDateTime, messageOf } from '../../lib/manage';
import { categoryLabel } from '../../lib/ui';

const SEAT_TONE: Record<SeatMapEntry['status'], string> = {
  available: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  held: 'bg-amber-50 text-amber-700 ring-amber-200',
  booked: 'bg-neutral-100 text-neutral-400 ring-neutral-200',
};

function groupByRow(seats: readonly SeatMapEntry[]): [string, SeatMapEntry[]][] {
  const rows = new Map<string, SeatMapEntry[]>();
  for (const seat of seats) {
    const row = rows.get(seat.rowLabel) ?? [];
    row.push(seat);
    rows.set(seat.rowLabel, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, rowSeats]) => [label, [...rowSeats].sort((a, b) => a.seatNumber - b.seatNumber)]);
}

/**
 * One event, from its organiser's side: the totals, the details, the live seat
 * map, and the two state transitions the API exposes (publish, and delete while
 * still a draft).
 *
 * The seat map here is the same read-only `/events/:id/seats` the customer seat
 * picker uses. Nothing on this screen can hold, release or re-price a seat -
 * those paths belong to the booking flow and are untouched.
 */
export function OrganiserEventDetailPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();

  const [event, setEvent] = useState<ManagedEventView | null>(null);
  const [summary, setSummary] = useState<EventBookingSummary | null>(null);
  const [seats, setSeats] = useState<SeatMapEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'publish' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (eventId === undefined) return;
    setLoading(true);
    setError(null);
    try {
      const [eventData, summaryData, seatData] = await Promise.all([
        getManagedEvent(eventId),
        getEventSummary(eventId),
        getEventSeatMap(eventId),
      ]);
      setEvent(eventData);
      setSummary(summaryData);
      setSeats(seatData.seats);
    } catch (err) {
      setError(messageOf(err, 'Could not load this event.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [eventId]);

  async function handlePublish() {
    if (eventId === undefined) return;
    setBusy(true);
    setActionError(null);
    try {
      await publishEvent(eventId);
      setConfirm(null);
      await load();
    } catch (err) {
      setActionError(messageOf(err, 'Could not publish this event.'));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (eventId === undefined) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteEvent(eventId);
      navigate('/organiser/events');
    } catch (err) {
      setActionError(messageOf(err, 'Could not delete this event.'));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <Spinner label="Loading event…" />;
  }

  if (error !== null || event === null) {
    return <ErrorState message={error ?? 'Event not found.'} onRetry={load} />;
  }

  const isDraft = event.status === 'draft';

  return (
    <>
      <PageHeader
        eyebrow={`${event.venue.name}${event.venue.city ? ` · ${event.venue.city}` : ''}`}
        title={event.title}
        backTo="/organiser/events"
        backLabel="Back to my events"
        actions={
          <>
            <Link to={`/organiser/events/${event.id}/bookings`}>
              <Button variant="secondary">Bookings &amp; revenue</Button>
            </Link>
            {(isDraft || event.status === 'published') && (
              <Link to={`/organiser/events/${event.id}/edit`}>
                <Button variant="secondary">Edit</Button>
              </Link>
            )}
            {isDraft && (
              <>
                <Button variant="dark" onClick={() => setConfirm('publish')}>
                  Publish
                </Button>
                <Button variant="danger" onClick={() => setConfirm('delete')}>
                  Delete
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <StatusBadge status={event.status} />
        <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-600">
          {categoryLabel(event.category)}
        </span>
        <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-600">
          {event.eventType}
        </span>
        {event.status === 'published' && (
          <Link
            to={`/events/${event.id}`}
            className="text-xs font-semibold text-brand-600 underline underline-offset-2 focus-ring"
          >
            View public page
          </Link>
        )}
      </div>

      {actionError && (
        <div className="mb-5">
          <InlineNote tone="error">{actionError}</InlineNote>
        </div>
      )}

      {summary && (
        <StatGrid>
          <StatCard label="Total bookings" value={String(summary.totalBookings)} tone="accent" />
          <StatCard label="Seats sold" value={String(summary.seatsSold)} />
          <StatCard label="Seats available" value={String(summary.availableSeats)} />
          <StatCard label="Revenue" value={formatAmount(summary.currency, summary.revenue)} />
        </StatGrid>
      )}

      <div className="mt-8 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-card lg:col-span-1">
          <h2 className="font-display text-base font-bold text-ink-900">Details</h2>
          <dl className="mt-4 flex flex-col gap-3.5 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">Starts</dt>
              <dd className="mt-0.5 text-ink-800">{formatDateTime(event.startsAt)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">Ends</dt>
              <dd className="mt-0.5 text-ink-800">{formatDateTime(event.endsAt)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">Venue</dt>
              <dd className="mt-0.5 text-ink-800">
                {event.venue.name}
                {event.venue.city ? `, ${event.venue.city}` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">From</dt>
              <dd className="mt-0.5 text-ink-800">
                {event.startingPrice === null
                  ? 'No seats available'
                  : formatAmount(event.currency, event.startingPrice)}
              </dd>
            </div>
            {event.description && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">Description</dt>
                <dd className="mt-0.5 whitespace-pre-line text-ink-800">{event.description}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-card lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-base font-bold text-ink-900">Seat map</h2>
            <div className="flex items-center gap-3 text-[11px] text-neutral-500">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" /> Available
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-amber-400" /> Held
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-neutral-300" /> Booked
              </span>
            </div>
          </div>

          {seats.length === 0 ? (
            <p className="mt-4 text-sm text-neutral-500">No seat inventory exists for this event.</p>
          ) : (
            <div className="mt-4 flex flex-col gap-2 overflow-x-auto">
              {groupByRow(seats).map(([row, rowSeats]) => (
                <div key={row} className="flex items-center gap-1.5">
                  <span className="w-6 shrink-0 text-xs font-semibold text-neutral-400">{row}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {rowSeats.map((seat) => (
                      <span
                        key={seat.id}
                        title={`${seat.rowLabel}${seat.seatNumber} · ${seat.status} · ${event.currency} ${seat.price}`}
                        className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-semibold ring-1 ring-inset ${SEAT_TONE[seat.status]}`}
                      >
                        {seat.seatNumber}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {confirm === 'publish' && (
        <ConfirmDialog
          title="Publish this event?"
          description="It becomes visible to customers immediately and can no longer be deleted."
          confirmLabel="Publish"
          busy={busy}
          onConfirm={handlePublish}
          onCancel={() => setConfirm(null)}
        />
      )}

      {confirm === 'delete' && (
        <ConfirmDialog
          title="Delete this draft?"
          description="This permanently removes the event and the seat inventory created for it. It cannot be undone."
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={handleDelete}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
