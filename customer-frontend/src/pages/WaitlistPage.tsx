import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { acceptWaitlistOffer, leaveWaitlist, listMyWaitlistEntries } from '../api/waitlist';
import { ApiError, newIdempotencyKey } from '../api/client';
import type { MyWaitlistEntry } from '../api/types';
import { Button } from '../components/Button';
import { Countdown } from '../components/Countdown';
import { EmptyState, ErrorState, InlineNote, Spinner } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';

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
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Waitlist</h1>
      <p className="mt-1 text-sm text-neutral-500">Sold-out events you've queued for.</p>

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
            action={
              <Link to="/">
                <Button variant="secondary">Browse events</Button>
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col divide-y divide-neutral-200 border-y border-neutral-200">
            {entries.map((entry) => (
              <div key={entry.waitlistEntryId} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <p className="font-medium">{entry.eventTitle}</p>
                  <p className="text-sm text-neutral-500">
                    {new Date(entry.eventStartsAt).toLocaleString()} · {entry.venueName}
                  </p>
                  <p className="mt-0.5 text-xs uppercase tracking-wide text-neutral-400">{entry.seatCategory}</p>
                </div>
                <div className="flex items-center gap-3">
                  {entry.offer !== null && entry.offer.status === 'offered' ? (
                    <>
                      <div className="text-right text-sm">
                        <p className="text-neutral-500">Offer expires in</p>
                        <Countdown expiresAt={entry.offer.expiresAt} />
                      </div>
                      <Button onClick={() => handleAccept(entry)} loading={busyId === entry.waitlistEntryId}>
                        Accept offer
                      </Button>
                    </>
                  ) : (
                    <StatusBadge status={entry.status} />
                  )}
                  {entry.status === 'waiting' && (
                    <Button
                      variant="ghost"
                      onClick={() => handleLeave(entry)}
                      loading={busyId === entry.waitlistEntryId}
                    >
                      Leave
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
