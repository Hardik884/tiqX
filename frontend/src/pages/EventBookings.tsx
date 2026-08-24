import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { Pagination } from '../components/Pagination';
import { StatCard } from '../components/StatCard';
import { api, ApiError } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import type { EventBookingSummary, EventBookingsResult, EventView } from '../lib/types';

export function EventBookings(): JSX.Element {
  const { eventId } = useParams<{ eventId: string }>();
  const [event, setEvent] = useState<EventView | null>(null);
  const [summary, setSummary] = useState<EventBookingSummary | null>(null);
  const [result, setResult] = useState<EventBookingsResult | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      api.get<EventView>(`/events/${eventId}`),
      api.get<EventBookingSummary>(`/organiser/events/${eventId}/summary`),
      api.get<EventBookingsResult>(`/organiser/events/${eventId}/bookings`, { page, limit: 20 }),
    ])
      .then(([eventData, summaryData, bookingsData]) => {
        if (cancelled) return;
        setEvent(eventData);
        setSummary(summaryData);
        setResult(bookingsData);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load bookings for this event.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [eventId, page]);

  if (loading) {
    return <Loading label="Loading bookings…" />;
  }

  if (error) {
    return <ErrorBanner message={error} />;
  }

  return (
    <div>
      <div className="main-header">
        <div className="main-header-text">
          <span className="main-header-eyebrow">
            <Link to={eventId ? `/events/${eventId}` : '/events'}>{event?.title ?? 'Event'}</Link>
          </span>
          <h1>Bookings &amp; revenue</h1>
        </div>
      </div>

      {summary ? (
        <div className="stat-grid">
          <StatCard label="Total bookings" value={String(summary.totalBookings)} />
          <StatCard label="Seats sold" value={String(summary.seatsSold)} />
          <StatCard label="Revenue" value={formatMoney(summary.revenue, summary.currency)} />
        </div>
      ) : null}

      {result && result.bookings.length === 0 ? (
        <EmptyState title="No bookings yet" description="Confirmed bookings for this event will appear here." />
      ) : result ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Customer</th>
                <th>Seats</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Booked</th>
              </tr>
            </thead>
            <tbody>
              {result.bookings.map((booking) => (
                <tr key={booking.id}>
                  <td>{booking.bookingReference}</td>
                  <td>
                    <div className="flex-col">
                      <span>{booking.customerName}</span>
                      <span className="text-sm text-muted">{booking.customerEmail}</span>
                    </div>
                  </td>
                  <td>{booking.seatCount}</td>
                  <td>{formatMoney(booking.totalAmount, booking.currency)}</td>
                  <td>
                    <Badge tone={booking.status === 'confirmed' ? 'success' : 'danger'}>{booking.status}</Badge>
                  </td>
                  <td>{formatDateTime(booking.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={result.page} totalPages={result.totalPages} total={result.total} onChange={setPage} />
        </div>
      ) : null}
    </div>
  );
}
