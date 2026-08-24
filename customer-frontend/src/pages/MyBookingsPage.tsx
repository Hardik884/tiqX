import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listMyBookings } from '../api/bookings';
import { ApiError } from '../api/client';
import type { MyBookingListItem } from '../api/types';
import { Button } from '../components/Button';
import { EmptyState, ErrorState, Spinner } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';

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
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">My tickets</h1>
      <p className="mt-1 text-sm text-neutral-500">Everything you've booked, in one place.</p>

      <div className="mt-6">
        {loading ? (
          <Spinner label="Loading your bookings…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => load(page)} />
        ) : items.length === 0 ? (
          <EmptyState
            title="No bookings yet"
            description="Once you book seats for an event, they'll show up here."
            action={
              <Link to="/">
                <Button variant="secondary">Browse events</Button>
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col divide-y divide-neutral-200 border-y border-neutral-200">
            {items.map((b) => (
              <Link
                key={b.bookingId}
                to={`/bookings/${b.bookingId}`}
                className="flex flex-wrap items-center justify-between gap-3 py-4 hover:bg-neutral-50 focus-ring"
              >
                <div>
                  <p className="font-medium">{b.eventTitle}</p>
                  <p className="text-sm text-neutral-500">
                    {new Date(b.eventStartsAt).toLocaleString()} · {b.venueName}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-neutral-400">{b.bookingReference}</p>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-neutral-500">
                    {b.seatCount} seat{b.seatCount === 1 ? '' : 's'}
                  </span>
                  <span className="font-medium">
                    {b.currency} {b.totalAmount}
                  </span>
                  <StatusBadge status={b.status} />
                </div>
              </Link>
            ))}
          </div>
        )}

        {!loading && !error && totalPages > 1 && (
          <div className="mt-6 flex items-center justify-center gap-3 text-sm">
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
