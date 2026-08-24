import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { StatusBadge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatCard } from '../components/StatCard';
import { api, ApiError } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import type { EventBookingSummary, EventView, SeatMapEntry } from '../lib/types';

const SEAT_STATUS_LABEL: Record<SeatMapEntry['status'], string> = {
  available: 'Available',
  held: 'Held',
  booked: 'Booked',
};

function groupByRow(seats: SeatMapEntry[]): [string, SeatMapEntry[]][] {
  const rows = new Map<string, SeatMapEntry[]>();
  for (const seat of seats) {
    const row = rows.get(seat.rowLabel) ?? [];
    row.push(seat);
    rows.set(seat.rowLabel, row);
  }
  return [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function EventDetail(): JSX.Element {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();

  const [event, setEvent] = useState<EventView | null>(null);
  const [summary, setSummary] = useState<EventBookingSummary | null>(null);
  const [seats, setSeats] = useState<SeatMapEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'publish' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    if (!eventId) return;
    setLoading(true);
    setError(null);
    try {
      const [eventData, summaryData, seatData] = await Promise.all([
        api.get<EventView>(`/events/${eventId}`),
        api.get<EventBookingSummary>(`/organiser/events/${eventId}/summary`),
        api.get<{ seats: SeatMapEntry[] }>(`/events/${eventId}/seats`),
      ]);
      setEvent(eventData);
      setSummary(summaryData);
      setSeats(seatData.seats);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this event.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function handlePublish(): Promise<void> {
    if (!eventId) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/events/${eventId}/publish`);
      setConfirmAction(null);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not publish this event.');
      setConfirmAction(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!eventId) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.delete(`/events/${eventId}`);
      navigate('/events');
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not delete this event.');
      setConfirmAction(null);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <Loading label="Loading event…" />;
  }

  if (error || !event) {
    return <ErrorBanner message={error ?? 'Event not found.'} />;
  }

  return (
    <div>
      <div className="main-header">
        <div className="main-header-text">
          <span className="main-header-eyebrow">
            {event.venue.name}
            {event.venue.city ? ` · ${event.venue.city}` : ''}
          </span>
          <div className="flex items-center gap-3">
            <h1>{event.title}</h1>
            <StatusBadge status={event.status} />
          </div>
        </div>
        <div className="main-header-actions">
          <Link to={`/events/${event.id}/bookings`} className="btn btn-secondary">
            Bookings
          </Link>
          {event.status === 'draft' || event.status === 'published' ? (
            <Link to={`/events/${event.id}/edit`} className="btn btn-secondary">
              Edit
            </Link>
          ) : null}
          {event.status === 'draft' ? (
            <button type="button" className="btn" onClick={() => setConfirmAction('publish')}>
              Publish
            </button>
          ) : null}
          {event.status === 'draft' ? (
            <button type="button" className="btn btn-danger" onClick={() => setConfirmAction('delete')}>
              Delete
            </button>
          ) : null}
        </div>
      </div>

      {actionError ? <ErrorBanner message={actionError} /> : null}

      {summary ? (
        <div className="stat-grid">
          <StatCard label="Total bookings" value={String(summary.totalBookings)} />
          <StatCard label="Seats sold" value={String(summary.seatsSold)} />
          <StatCard label="Available seats" value={String(summary.availableSeats)} />
          <StatCard label="Revenue" value={formatMoney(summary.revenue, summary.currency)} />
        </div>
      ) : null}

      <div className="card card-pad section">
        <h2 className="mb-4">Details</h2>
        <div className="form-row">
          <div className="flex-col gap-1">
            <span className="text-sm text-muted">Starts</span>
            <span>{formatDateTime(event.startsAt)}</span>
          </div>
          <div className="flex-col gap-1">
            <span className="text-sm text-muted">Ends</span>
            <span>{formatDateTime(event.endsAt)}</span>
          </div>
        </div>
        <div className="form-row mt-6">
          <div className="flex-col gap-1">
            <span className="text-sm text-muted">Type</span>
            <span>{event.eventType}</span>
          </div>
          <div className="flex-col gap-1">
            <span className="text-sm text-muted">Category</span>
            <span>{event.category}</span>
          </div>
        </div>
        {event.description ? (
          <div className="flex-col gap-1 mt-6">
            <span className="text-sm text-muted">Description</span>
            <span>{event.description}</span>
          </div>
        ) : null}
      </div>

      <div className="card card-pad">
        <h2 className="mb-4">Seat layout</h2>
        {seats && seats.length > 0 ? (
          <div className="flex-col gap-3">
            {groupByRow(seats).map(([row, rowSeats]) => (
              <div key={row} className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                <span className="text-sm text-muted" style={{ width: 28 }}>
                  {row}
                </span>
                {rowSeats
                  .sort((a, b) => a.seatNumber - b.seatNumber)
                  .map((seat) => (
                    <span
                      key={seat.id}
                      title={`${row}${seat.seatNumber} · ${SEAT_STATUS_LABEL[seat.status]} · ${seat.price}`}
                      className={`badge badge-${seat.status === 'available' ? 'success' : seat.status === 'held' ? 'neutral' : 'danger'}`}
                    >
                      {seat.seatNumber}
                    </span>
                  ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">No seat inventory configured for this event.</p>
        )}
      </div>

      {confirmAction === 'publish' ? (
        <ConfirmDialog
          title="Publish this event?"
          description="Once published, this event becomes visible to customers and can no longer be deleted."
          confirmLabel="Publish"
          busy={busy}
          onConfirm={handlePublish}
          onCancel={() => setConfirmAction(null)}
        />
      ) : null}

      {confirmAction === 'delete' ? (
        <ConfirmDialog
          title="Delete this event?"
          description="This permanently removes the draft event and its seat inventory. This cannot be undone."
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={handleDelete}
          onCancel={() => setConfirmAction(null)}
        />
      ) : null}
    </div>
  );
}
