import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { confirmHold, releaseHold } from '../api/bookings';
import { ApiError, newIdempotencyKey } from '../api/client';
import { Button } from '../components/Button';
import { Countdown } from '../components/Countdown';
import { InlineNote } from '../components/Feedback';
import { AlertIcon, CalendarIcon, MapPinIcon, TicketIcon } from '../components/icons';
import { useBookingFlow } from '../store/bookingFlow';
import { CONTAINER, formatMoney } from '../lib/ui';

export function CheckoutPage() {
  const hold = useBookingFlow((s) => s.hold);
  const clearHold = useBookingFlow((s) => s.clearHold);
  const navigate = useNavigate();

  const [expired, setExpired] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable for the lifetime of this hold: a retried click after a network
  // failure replays the same confirmation instead of risking a second booking.
  const idempotencyKey = useMemo(() => newIdempotencyKey(), [hold?.holdId]);

  if (hold === null) {
    return (
      <div className={`${CONTAINER} py-16`}>
        <div className="mx-auto max-w-md text-center">
          <InlineNote>There's no active seat hold. Pick your seats from an event page first.</InlineNote>
          <Link to="/" className="mt-4 inline-block text-sm font-semibold text-brand-600 underline underline-offset-2">
            Browse events
          </Link>
        </div>
      </div>
    );
  }

  const total = hold.seats.reduce((sum, s) => sum + Number(s.price), 0);

  async function handleConfirm() {
    if (hold === null) return;
    setConfirming(true);
    setError(null);
    try {
      const booking = await confirmHold(hold.eventId, hold.holdId, idempotencyKey);
      clearHold();
      navigate(`/bookings/${booking.bookingId}`, { state: { justBooked: true } });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        setError(err.message || 'This hold is no longer valid.');
        setExpired(true);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not confirm your booking. Please try again.');
      }
    } finally {
      setConfirming(false);
    }
  }

  /**
   * Best-effort: the hold is released either way from the customer's point of
   * view (they're leaving checkout), so a failure here - the hold already
   * expired, a flaky network - must not trap them on this page. It only
   * changes how promptly the seats reappear as available to everyone else;
   * worst case, the existing TTL still releases them on its own.
   */
  async function handleRelease() {
    if (hold === null) return;
    setReleasing(true);
    try {
      await releaseHold(hold.eventId, hold.holdId);
    } catch {
      // Nothing actionable for the customer - see the doc comment above.
    } finally {
      setReleasing(false);
      clearHold();
      navigate(`/events/${hold.eventId}`);
    }
  }

  return (
    <div className={`${CONTAINER} py-8 sm:py-10`}>
      <div className="mx-auto max-w-lg">
        <h1 className="font-display text-2xl font-bold text-ink-900">Confirm your booking</h1>
        <p className="mt-1 text-sm text-neutral-500">Review your seats before the hold expires.</p>

        {/* Hold expiration warning banner */}
        <div
          className={`mt-5 flex items-center justify-between gap-3 rounded-lg px-4 py-3 ${
            expired ? 'bg-red-50 ring-1 ring-inset ring-red-200' : 'bg-amber-50 ring-1 ring-inset ring-amber-200'
          }`}
        >
          <span className="flex items-center gap-2 text-sm font-medium text-amber-800">
            <AlertIcon width={17} height={17} className={expired ? 'text-red-600' : 'text-amber-600'} />
            {expired ? 'Your hold has expired' : 'Your seats are held — complete checkout soon'}
          </span>
          {expired ? (
            <span className="text-sm font-bold text-red-700">Expired</span>
          ) : (
            <Countdown expiresAt={hold.expiresAt} onExpire={() => setExpired(true)} variant="prominent" />
          )}
        </div>

        <div className="mt-5 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
          <div className="border-b border-neutral-100 bg-neutral-50/60 p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Event</p>
            <p className="mt-1 font-display text-base font-bold text-ink-900">{hold.event.title}</p>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-neutral-500">
              <span className="flex items-center gap-1.5">
                <CalendarIcon width={14} height={14} />
                {new Date(hold.event.startsAt).toLocaleString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
              <span className="flex items-center gap-1.5">
                <MapPinIcon width={14} height={14} />
                {hold.event.venue.name}
                {hold.event.venue.city ? `, ${hold.event.venue.city}` : ''}
              </span>
            </div>
          </div>

          <div className="p-5">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              <TicketIcon width={14} height={14} />
              {hold.seats.length} seat{hold.seats.length === 1 ? '' : 's'} selected
            </p>
            <ul className="flex flex-col gap-1.5 text-sm">
              {hold.seats.map((s) => (
                <li key={s.id} className="flex justify-between">
                  <span>
                    Seat {s.rowLabel}
                    {s.seatNumber}
                  </span>
                  <span className="text-neutral-500">{formatMoney(hold.event.currency, s.price)}</span>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex items-center justify-between border-t border-neutral-200 pt-4">
              <span className="text-base font-bold text-ink-900">Total</span>
              <span className="text-xl font-bold text-ink-900">{formatMoney(hold.event.currency, total)}</span>
            </div>
          </div>
        </div>

        {expired ? (
          <div className="mt-5 flex flex-col gap-3">
            <InlineNote tone="error">Your seat hold expired before checkout finished. The seats have been released.</InlineNote>
            <Button
              variant="secondary"
              size="lg"
              onClick={() => {
                clearHold();
                navigate(`/events/${hold.eventId}`);
              }}
            >
              Pick seats again
            </Button>
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-3">
            {error && <InlineNote tone="error">{error}</InlineNote>}
            <Button onClick={handleConfirm} loading={confirming} size="lg" className="w-full">
              Confirm booking
            </Button>
            <Button variant="ghost" onClick={handleRelease} loading={releasing}>
              Cancel and release seats
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
