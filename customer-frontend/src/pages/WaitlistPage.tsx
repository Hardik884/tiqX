import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { acceptWaitlistOffer, leaveWaitlist, listMyWaitlistEntries } from '../api/waitlist';
import { ApiError, newIdempotencyKey } from '../api/client';
import type { MyWaitlistEntry } from '../api/types';
import { Button } from '../components/Button';
import { Countdown } from '../components/Countdown';
import { EmptyState, ErrorState, InlineNote, Spinner } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { CalendarIcon, ClockIcon, MapPinIcon, SparkleIcon } from '../components/icons';
import { CONTAINER } from '../lib/ui';

export function WaitlistPage() {
  const [entries, setEntries] = useState<MyWaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { entries } = await listMyWaitlistEntries();
      setEntries(entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your waitlist entries.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleAccept(entry: MyWaitlistEntry) {
    if (entry.offer === null) return;
    setBusyId(entry.waitlistEntryId);
    setActionError(null);
    try {
      const result = await acceptWaitlistOffer(entry.offer.offerId, newIdempotencyKey());
      navigate(`/bookings/${result.bookingId}`, { state: { justBooked: true } });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not accept this offer - it may have expired.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function handleLeave(entry: MyWaitlistEntry) {
    setBusyId(entry.waitlistEntryId);
    setActionError(null);
    try {
      await leaveWaitlist(entry.eventId, entry.waitlistEntryId);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not leave the waitlist.');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <Spinner label="Loading your waitlist…" />;
  if (error) {
    return (
      <div className={`${CONTAINER} py-10`}>
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }

  return (
    <div className={`${CONTAINER} py-8 sm:py-10`}>
      <h1 className="font-display text-2xl font-bold text-ink-900">Waitlist</h1>
      <p className="mt-1 text-sm text-neutral-500">Sold-out events you've queued for — we'll ping you the moment a seat frees up.</p>

      {actionError && (
        <div className="mt-4">
          <InlineNote tone="error">{actionError}</InlineNote>
        </div>
      )}

      <div className="mt-6">
        {entries.length === 0 ? (
          <EmptyState
            title="You're not on any waitlists"
            description="Join a waitlist from a sold-out event's page and it'll show up here."
            icon={<ClockIcon width={22} height={22} />}
            action={
              <Link to="/">
                <Button variant="secondary">Browse events</Button>
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {entries.map((entry) => {
              const hasActiveOffer = entry.offer !== null && entry.offer.status === 'offered';
              return (
                <div
                  key={entry.waitlistEntryId}
                  className={`flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-white p-4 sm:p-5 ${
                    hasActiveOffer ? 'border-brand-300 shadow-card ring-1 ring-brand-100' : 'border-neutral-200 shadow-card'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-display font-semibold text-ink-900">{entry.eventTitle}</p>
                      {hasActiveOffer && (
                        <span className="flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-brand-700">
                          <SparkleIcon width={11} height={11} />
                          Offer active
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-neutral-500">
                      <span className="flex items-center gap-1.5">
                        <CalendarIcon width={13} height={13} />
                        {new Date(entry.eventStartsAt).toLocaleString()}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <MapPinIcon width={13} height={13} />
                        {entry.venueName}
                      </span>
                    </div>
                    <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                      {entry.seatCategory} category
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {hasActiveOffer && entry.offer !== null ? (
                      <>
                        <div className="text-right">
                          <p className="text-xs font-medium text-neutral-500">Offer expires in</p>
                          <Countdown expiresAt={entry.offer.expiresAt} variant="prominent" />
                        </div>
                        <Button onClick={() => handleAccept(entry)} loading={busyId === entry.waitlistEntryId} size="lg">
                          Accept offer
                        </Button>
                      </>
                    ) : (
                      <StatusBadge status={entry.status} />
                    )}
                    {entry.status === 'waiting' && (
                      <Button variant="ghost" onClick={() => handleLeave(entry)} loading={busyId === entry.waitlistEntryId}>
                        Leave
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
