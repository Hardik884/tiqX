import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDashboardTotals, listOrganiserEvents } from '../../api/organiser';
import { listVenues } from '../../api/venues';
import type { DashboardTotals, ManagedEventView, VenueSummary } from '../../api/types';
import { Button } from '../../components/Button';
import { ErrorState, Spinner } from '../../components/Feedback';
import { StatusBadge } from '../../components/StatusBadge';
import { ChevronRightIcon } from '../../components/icons';
import { PageHeader } from '../../components/manage/PageHeader';
import { StatCard, StatGrid } from '../../components/manage/StatCard';
import { formatAmount, formatDateTime, messageOf } from '../../lib/manage';

/**
 * Platform-wide totals. Same `/organiser/dashboard` endpoint the organiser view
 * uses, with `all=true` - a flag the backend honours only for an admin, so this
 * page cannot show more than the caller is entitled to even if it asks.
 */
export function AdminDashboardPage() {
  const [totals, setTotals] = useState<DashboardTotals | null>(null);
  const [events, setEvents] = useState<ManagedEventView[]>([]);
  const [venues, setVenues] = useState<VenueSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [dashboard, eventList, venueList] = await Promise.all([
        getDashboardTotals(true),
        listOrganiserEvents({ page: 1, limit: 5, all: true }),
        listVenues(),
      ]);
      setTotals(dashboard);
      setEvents(eventList.events);
      setVenues(venueList.venues);
    } catch (err) {
      setError(messageOf(err, 'Could not load the admin dashboard.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const seatlessVenues = venues.filter((venue) => venue.seatCount === 0);

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Admin dashboard"
        description="Every organiser’s events, venues and revenue in one view."
        actions={
          <Link to="/admin/venues/new">
            <Button variant="primary">New venue</Button>
          </Link>
        }
      />

      {loading ? (
        <Spinner label="Loading platform totals…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          {totals && (
            <StatGrid>
              <StatCard label="Upcoming events" value={String(totals.upcomingEvents)} tone="accent" />
              <StatCard label="Total bookings" value={String(totals.totalBookings)} />
              <StatCard label="Seats sold" value={String(totals.seatsSold)} />
              <StatCard label="Revenue" value={formatAmount('INR', totals.revenue)} hint="confirmed bookings" />
            </StatGrid>
          )}

          <div className="mt-8 grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-display text-lg font-bold text-ink-900">Latest events</h2>
                <Link
                  to="/admin/events"
                  className="flex items-center gap-0.5 text-sm font-semibold text-brand-600 focus-ring"
                >
                  All events
                  <ChevronRightIcon width={15} height={15} />
                </Link>
              </div>
              <div className="flex flex-col gap-2">
                {events.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-neutral-300 bg-white px-4 py-8 text-center text-sm text-neutral-500">
                    No events have been created yet.
                  </p>
                ) : (
                  events.map((event) => (
                    <div
                      key={event.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-3.5 shadow-card"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2.5">
                          <span className="truncate text-sm font-semibold text-ink-900">{event.title}</span>
                          <StatusBadge status={event.status} />
                        </div>
                        <span className="mt-0.5 block text-xs text-neutral-500">
                          {formatDateTime(event.startsAt)} · {event.venue.name}
                        </span>
                      </div>
                      <span className="text-xs text-neutral-500">{event.availableSeats} seats left</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-display text-lg font-bold text-ink-900">Venues</h2>
                <Link
                  to="/admin/venues"
                  className="flex items-center gap-0.5 text-sm font-semibold text-brand-600 focus-ring"
                >
                  Manage
                  <ChevronRightIcon width={15} height={15} />
                </Link>
              </div>
              <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
                <p className="font-display text-2xl font-bold text-ink-900">{venues.length}</p>
                <p className="text-xs text-neutral-500">
                  {venues.reduce((total, venue) => total + venue.seatCount, 0)} seats configured in total
                </p>
                {seatlessVenues.length > 0 && (
                  <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {seatlessVenues.length} venue{seatlessVenues.length === 1 ? '' : 's'} still ha
                    {seatlessVenues.length === 1 ? 's' : 've'} no seat layout — no event can be created there yet.
                  </p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
