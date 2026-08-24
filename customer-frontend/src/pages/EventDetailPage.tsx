import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { createHold } from '../api/bookings';
import { ApiError, newIdempotencyKey } from '../api/client';
import { getEvent } from '../api/events';
import { joinWaitlist } from '../api/waitlist';
import type { PublicEventView, SeatCategory, SeatMapEntry } from '../api/types';
import { Button } from '../components/Button';
import { ErrorState, InlineNote, Spinner } from '../components/Feedback';
import { SeatMap } from '../components/SeatMap';
import { useSeatMap } from '../lib/useSeatMap';
import { useAuthStore } from '../store/auth';
import { useBookingFlow } from '../store/bookingFlow';

const MAX_SEATS = 10;

function formatDateRange(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const dateFmt: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
  const timeFmt: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${start.toLocaleDateString(undefined, dateFmt)} · ${start.toLocaleTimeString(undefined, timeFmt)} – ${end.toLocaleTimeString(undefined, timeFmt)}`;
}

export function EventDetailPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const setHold = useBookingFlow((s) => s.setHold);

  const [event, setEvent] = useState<PublicEventView | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const { seats, loading: seatsLoading, error: seatsError, connected, refetch } = useSeatMap(eventId);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reserving, setReserving] = useState(false);
  const [reserveError, setReserveError] = useState<string | null>(null);
  const [waitlistCategory, setWaitlistCategory] = useState<SeatCategory>('standard');
  const [waitlistBusy, setWaitlistBusy] = useState(false);
  const [waitlistMessage, setWaitlistMessage] = useState<string | null>(null);

  useEffect(() => {
    if (eventId === undefined) return;
    getEvent(eventId)
      .then(setEvent)
      .catch((err) => setEventError(err instanceof ApiError ? err.message : 'Event not found.'));
  }, [eventId]);

  function toggleSeat(seat: SeatMapEntry) {
    if (seat.status !== 'available' && !selected.has(seat.id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seat.id)) {
        next.delete(seat.id);
      } else if (next.size < MAX_SEATS) {
        next.add(seat.id);
      }
      return next;
    });
  }

  const selectedSeats = seats.filter((s) => selected.has(s.id));
  const total = selectedSeats.reduce((sum, s) => sum + Number(s.price), 0);

  async function handleReserve() {
    if (eventId === undefined || event === null || selectedSeats.length === 0) return;
    if (user === null) {
      navigate('/login', { state: { from: `/events/${eventId}` } });
      return;
    }

    setReserving(true);
    setReserveError(null);
    try {
      const hold = await createHold(eventId, selectedSeats.map((s) => s.id), undefined, newIdempotencyKey());
      setHold({ holdId: hold.holdId, eventId, expiresAt: hold.expiresAt, seats: selectedSeats, event });
      navigate('/checkout');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setReserveError('One or more selected seats were just taken. Please choose different seats.');
        setSelected(new Set());
        refetch();
      } else if (err instanceof ApiError) {
        setReserveError(err.message);
      } else {
        setReserveError('Could not reserve these seats. Please try again.');
      }
    } finally {
      setReserving(false);
    }
  }

  async function handleJoinWaitlist() {
    if (eventId === undefined) return;
    if (user === null) {
      navigate('/login', { state: { from: `/events/${eventId}` } });
      return;
    }
    setWaitlistBusy(true);
    setWaitlistMessage(null);
    try {
      await joinWaitlist(eventId, waitlistCategory, newIdempotencyKey());
      setWaitlistMessage("You're on the waitlist. We'll notify you if a seat opens up.");
    } catch (err) {
      setWaitlistMessage(err instanceof ApiError ? err.message : 'Could not join the waitlist.');
    } finally {
      setWaitlistBusy(false);
    }
  }

  if (eventError) {
    return <ErrorState message={eventError} />;
  }
  if (event === null) {
    return <Spinner label="Loading event…" />;
  }

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4 border-b border-neutral-200 pb-6">
        <div>
          <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{event.category}</span>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{event.title}</h1>
          <p className="mt-2 text-sm text-neutral-600">{formatDateRange(event.startsAt, event.endsAt)}</p>
          <p className="text-sm text-neutral-600">
            {event.venue.name}
            {event.venue.city ? `, ${event.venue.city}` : ''}
          </p>
          {event.description && <p className="mt-3 max-w-2xl text-sm text-neutral-500">{event.description}</p>}
        </div>
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-600' : 'bg-neutral-300'}`} />
          {connected ? 'Live seat updates on' : 'Reconnecting…'}
        </div>
      </div>

      {seatsLoading ? (
        <Spinner label="Loading seat map…" />
      ) : seatsError ? (
        <ErrorState message={seatsError} onRetry={refetch} />
      ) : seats.length === 0 ? (
        <InlineNote>No seats have been configured for this event yet.</InlineNote>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          <SeatMap seats={seats} selected={selected} onToggle={toggleSeat} disabled={reserving} />

          <aside className="flex flex-col gap-4 rounded border border-neutral-200 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Your selection</h2>
            {selectedSeats.length === 0 ? (
              <p className="text-sm text-neutral-400">Select up to {MAX_SEATS} available seats.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {selectedSeats.map((s) => (
                  <li key={s.id} className="flex justify-between">
                    <span>
                      {s.rowLabel}
                      {s.seatNumber}
                    </span>
                    <span className="text-neutral-500">
                      {event.currency} {s.price}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between border-t border-neutral-200 pt-3 text-sm font-semibold">
              <span>Total</span>
              <span>
                {event.currency} {total.toFixed(2)}
              </span>
            </div>
            {reserveError && <InlineNote tone="error">{reserveError}</InlineNote>}
            <Button onClick={handleReserve} loading={reserving} disabled={selectedSeats.length === 0}>
              Reserve seats
            </Button>

            <div className="mt-2 border-t border-neutral-200 pt-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Sold out? Join the waitlist</h3>
              <div className="mt-3 flex gap-2">
                <select
                  value={waitlistCategory}
                  onChange={(e) => setWaitlistCategory(e.target.value as SeatCategory)}
                  className="flex-1 rounded border border-neutral-300 px-2 py-2 text-sm focus-ring"
                >
                  <option value="standard">Standard</option>
                  <option value="premium">Premium</option>
                </select>
                <Button variant="secondary" onClick={handleJoinWaitlist} loading={waitlistBusy}>
                  Join
                </Button>
              </div>
              {waitlistMessage && <p className="mt-2 text-xs text-neutral-500">{waitlistMessage}</p>}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
