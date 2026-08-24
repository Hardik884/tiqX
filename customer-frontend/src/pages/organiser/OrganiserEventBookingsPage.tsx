import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getEventSummary, getManagedEvent, listEventBookings } from '../../api/organiser';
import type { EventBookingSummary, EventBookingsResult, ManagedEventView } from '../../api/types';
import { EmptyState, ErrorState, Spinner } from '../../components/Feedback';
import { StatusBadge } from '../../components/StatusBadge';
import { PageHeader } from '../../components/manage/PageHeader';
import { Pagination } from '../../components/manage/Pagination';
import { TableCard, Td, Th } from '../../components/manage/Table';
import { formatAmount, formatDateTime, messageOf } from '../../lib/manage';

/** Who booked what, for one event, straight from `/organiser/events/:id/bookings`. */
export function OrganiserEventBookingsPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [event, setEvent] = useState<ManagedEventView | null>(null);
  const [summary, setSummary] = useState<EventBookingSummary | null>(null);
  const [result, setResult] = useState<EventBookingsResult | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(nextPage: number) {
    if (eventId === undefined) return;
    setLoading(true);
    setError(null);
    try {
      const [eventData, summaryData, bookings] = await Promise.all([
        getManagedEvent(eventId),
        getEventSummary(eventId),
        listEventBookings(eventId, { page: nextPage, limit: 20 }),
      ]);
      setEvent(eventData);
      setSummary(summaryData);
      setResult(bookings);
    } catch (err) {
      setError(messageOf(err, 'Could not load bookings for this event.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(page);
  }, [eventId, page]);

  return (
    <>
      <PageHeader
        eyebrow={event?.title ?? 'Event'}
        title="Bookings & revenue"
        description="Every confirmed and cancelled booking for this event."
        backTo={eventId === undefined ? '/organiser/events' : `/organiser/events/${eventId}`}
        backLabel="Back to event"
      />

      {loading ? (
        <Spinner label="Loading bookings…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(page)} />
      ) : (
        <>
          {summary && (
            <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Bookings</span>
                <p className="font-display mt-1 text-2xl font-bold text-ink-900">{summary.totalBookings}</p>
              </div>
              <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Seats sold</span>
                <p className="font-display mt-1 text-2xl font-bold text-ink-900">{summary.seatsSold}</p>
              </div>
              <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Seats left</span>
                <p className="font-display mt-1 text-2xl font-bold text-ink-900">{summary.availableSeats}</p>
              </div>
              <div className="rounded-lg border border-ink-800 bg-ink-950 p-4 shadow-card">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Revenue</span>
                <p className="font-display mt-1 text-2xl font-bold text-white">
                  {formatAmount(summary.currency, summary.revenue)}
                </p>
              </div>
            </div>
          )}

          {result && result.bookings.length === 0 ? (
            <EmptyState
              title="No bookings yet"
              description="Confirmed bookings for this event will appear here as customers buy tickets."
            />
          ) : result ? (
            <TableCard>
              <thead>
                <tr>
                  <Th>Reference</Th>
                  <Th>Customer</Th>
                  <Th className="text-right">Seats</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>Status</Th>
                  <Th>Booked</Th>
                </tr>
              </thead>
              <tbody>
                {result.bookings.map((booking) => (
                  <tr key={booking.id} className="transition-colors hover:bg-neutral-50">
                    <Td className="font-mono text-xs font-semibold">{booking.bookingReference}</Td>
                    <Td>
                      <span className="block font-medium text-ink-900">{booking.customerName}</span>
                      <span className="block text-xs text-neutral-500">{booking.customerEmail}</span>
                    </Td>
                    <Td className="text-right">{booking.seatCount}</Td>
                    <Td className="text-right font-medium">
                      {formatAmount(booking.currency, booking.totalAmount)}
                    </Td>
                    <Td>
                      <StatusBadge status={booking.status} />
                    </Td>
                    <Td className="whitespace-nowrap text-neutral-600">{formatDateTime(booking.createdAt)}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6} className="p-0">
                    <Pagination
                      page={result.page}
                      totalPages={result.totalPages}
                      total={result.total}
                      onChange={setPage}
                    />
                  </td>
                </tr>
              </tfoot>
            </TableCard>
          ) : null}
        </>
      )}
    </>
  );
}
