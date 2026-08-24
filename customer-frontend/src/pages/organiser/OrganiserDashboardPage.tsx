import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDashboardTotals, listOrganiserEvents } from '../../api/organiser';
import type { DashboardTotals, ManagedEventView } from '../../api/types';
import { Button } from '../../components/Button';
import { EmptyState, ErrorState, Spinner } from '../../components/Feedback';
import { StatusBadge } from '../../components/StatusBadge';
import { CalendarIcon, ChevronRightIcon, TicketIcon } from '../../components/icons';
import { PageHeader } from '../../components/manage/PageHeader';
import { StatCard, StatGrid } from '../../components/manage/StatCard';
import { formatAmount, formatDateTime, messageOf } from '../../lib/manage';

/**
 * The organiser's landing screen: the backend's own aggregate totals, plus the
 * handful of events they are most likely to act on next. Both come from
 * endpoints that already existed - `/organiser/dashboard` and
 * `/organiser/events` - and nothing is re-totalled here.
 */
export function OrganiserDashboardPage() {
  const [totals, setTotals] = useState<DashboardTotals | null>(null);
  const [recent, setRecent] = useState<ManagedEventView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [dashboard, events] = await Promise.all([
        getDashboardTotals(false),
        listOrganiserEvents({ page: 1, limit: 5 }),
      ]);
      setTotals(dashboard);
      setRecent(events.events);
    } catch (err) {
      setError(messageOf(err, 'Could not load your dashboard.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Organiser dashboard"
        description="Live numbers across every event you run."
        actions={
          <Link to="/organiser/events/new">
            <Button variant="primary">Create event</Button>
          </Link>
        }
      />

      {loading ? (
        <Spinner label="Loading your dashboard…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          {totals && (
            <StatGrid>
              <StatCard label="Upcoming events" value={String(totals.upcomingEvents)} tone="accent" />
              <StatCard label="Total bookings" value={String(totals.totalBookings)} />
              <StatCard label="Seats sold" value={String(totals.seatsSold)} />
              <StatCard
                label="Revenue"
                value={formatAmount('INR', totals.revenue)}
                hint="confirmed bookings"
              />
            </StatGrid>
          )}

          <div className="mt-8">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-ink-900">Recent events</h2>
              <Link
                to="/organiser/events"
                className="flex items-center gap-0.5 text-sm font-semibold text-brand-600 focus-ring"
              >
                View all
                <ChevronRightIcon width={15} height={15} />
              </Link>
            </div>

            {recent.length === 0 ? (
              <EmptyState
                title="No events yet"
                description="Create your first event to start selling tickets."
                action={
                  <Link to="/organiser/events/new">
                    <Button variant="primary">Create event</Button>
                  </Link>
                }
              />
            ) : (
              <div className="flex flex-col gap-2">
                {recent.map((event) => (
                  <Link
                    key={event.id}
                    to={`/organiser/events/${event.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-3.5 shadow-card transition-all hover:border-neutral-300 hover:shadow-card-hover focus-ring"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5">
                        <span className="truncate text-sm font-semibold text-ink-900">{event.title}</span>
                        <StatusBadge status={event.status} />
                      </div>
                      <span className="mt-1 flex items-center gap-1.5 text-xs text-neutral-500">
                        <CalendarIcon width={13} height={13} />
                        {formatDateTime(event.startsAt)} · {event.venue.name}
                      </span>
                    </div>
                    <span className="flex items-center gap-1.5 text-xs font-medium text-neutral-500">
                      <TicketIcon width={14} height={14} />
                      {event.availableSeats} seats available
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
