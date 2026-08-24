import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listMyBookings } from '../api/bookings';
import { ApiError } from '../api/client';
import type { MyBookingListItem } from '../api/types';
import { Button } from '../components/Button';
import { EmptyState, ErrorState, Spinner } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { CalendarIcon, MapPinIcon, TicketIcon } from '../components/icons';
import { CONTAINER, formatMoney } from '../lib/ui';

export function MyBookingsPage() {
  const [items, setItems] = useState<MyBookingListItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(p: number) {
    setLoading(true);
    setError(null);
    try {
      const result = await listMyBookings(p);
      setItems(result.bookings);
      setTotalPages(result.totalPages);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your bookings.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  return (
    <div className={`${CONTAINER} py-8 sm:py-10`}>
      <h1 className="font-display text-2xl font-bold text-ink-900">My tickets</h1>
      <p className="mt-1 text-sm text-neutral-500">Everything you've booked, in one place.</p>

      <div className="mt-6">
        {loading ? (
          <Spinner label="Loading your bookings…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => load(page)} />
        ) : items.length === 0 ? (
          <EmptyState
            title="No bookings yet"
            description="Once you book seats for an event, they'll show up here as digital tickets."
            icon={<TicketIcon width={22} height={22} />}
            action={
              <Link to="/">
                <Button variant="secondary">Browse events</Button>
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((b) => (
              <Link
                key={b.bookingId}
                to={`/bookings/${b.bookingId}`}
                className="group flex flex-wrap items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-white p-4 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-card-hover focus-ring sm:p-5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-display font-semibold text-ink-900">{b.eventTitle}</p>
                    <StatusBadge status={b.status} />
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-neutral-500">
                    <span className="flex items-center gap-1.5">
                      <CalendarIcon width={13} height={13} />
                      {new Date(b.eventStartsAt).toLocaleString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <MapPinIcon width={13} height={13} />
                      {b.venueName}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-xs text-neutral-400">{b.bookingReference}</p>
                </div>
                <div className="flex items-center gap-5 text-sm">
                  <span className="text-neutral-500">
                    {b.seatCount} seat{b.seatCount === 1 ? '' : 's'}
                  </span>
                  <span className="font-bold text-ink-900">{formatMoney(b.currency, b.totalAmount)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}

        {!loading && !error && totalPages > 1 && (
          <div className="mt-8 flex items-center justify-center gap-3 text-sm">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span className="text-neutral-500">
              Page {page} of {totalPages}
            </span>
            <Button variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
