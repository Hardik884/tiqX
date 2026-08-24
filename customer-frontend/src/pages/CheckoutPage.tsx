import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { confirmHold } from '../api/bookings';
import { ApiError, newIdempotencyKey } from '../api/client';
import { Button } from '../components/Button';
import { Countdown } from '../components/Countdown';
import { InlineNote } from '../components/Feedback';
import { useBookingFlow } from '../store/bookingFlow';

export function CheckoutPage() {
  const hold = useBookingFlow((s) => s.hold);
  const clearHold = useBookingFlow((s) => s.clearHold);
  const navigate = useNavigate();

  const [expired, setExpired] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable for the lifetime of this hold: a retried click after a network
  // failure replays the same confirmation instead of risking a second booking.
  const idempotencyKey = useMemo(() => newIdempotencyKey(), [hold?.holdId]);

  if (hold === null) {
    return (
      <div className="mx-auto max-w-md text-center">
        <InlineNote>There's no active seat hold. Pick your seats from an event page first.</InlineNote>
        <Link to="/" className="mt-4 inline-block text-sm font-medium underline underline-offset-2">
          Browse events
        </Link>
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

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-xl font-semibold">Confirm your booking</h1>
      <p className="mt-1 text-sm text-neutral-500">{hold.event.title}</p>

      <div className="mt-6 rounded border border-neutral-200 p-5">
        <div className="flex items-center justify-between border-b border-neutral-200 pb-3">
          <span className="text-sm text-neutral-500">Hold expires in</span>
          {expired ? (
            <span className="text-sm font-semibold text-red-700">Expired</span>
          ) : (
            <Countdown expiresAt={hold.expiresAt} onExpire={() => setExpired(true)} />
          )}
        </div>

        <ul className="flex flex-col gap-1.5 py-4 text-sm">
          {hold.seats.map((s) => (
            <li key={s.id} className="flex justify-between">
              <span>
                Seat {s.rowLabel}
                {s.seatNumber}
              </span>
              <span className="text-neutral-500">
                {hold.event.currency} {s.price}
              </span>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between border-t border-neutral-200 pt-3 text-base font-semibold">
          <span>Total</span>
          <span>
            {hold.event.currency} {total.toFixed(2)}
          </span>
        </div>
      </div>

      {expired ? (
        <div className="mt-4 flex flex-col gap-3">
          <InlineNote tone="error">Your seat hold expired before checkout finished. The seats have been released.</InlineNote>
          <Button
            variant="secondary"
            onClick={() => {
              clearHold();
              navigate(`/events/${hold.eventId}`);
            }}
          >
            Pick seats again
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {error && <InlineNote tone="error">{error}</InlineNote>}
          <Button onClick={handleConfirm} loading={confirming} className="w-full">
            Confirm booking
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              clearHold();
              navigate(`/events/${hold.eventId}`);
            }}
          >
            Cancel and release seats
          </Button>
        </div>
      )}
    </div>
  );
}
