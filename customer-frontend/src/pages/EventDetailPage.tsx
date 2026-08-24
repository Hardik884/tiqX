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
import { CalendarIcon, ClockIcon, MapPinIcon, SofaIcon } from '../components/icons';
import { useSeatMap } from '../lib/useSeatMap';
import { useAuthStore } from '../store/auth';
import { useBookingFlow } from '../store/bookingFlow';
import { CONTAINER, categoryLabel, categoryStyle, formatMoney } from '../lib/ui';

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
  const soldOut = seats.length > 0 && seats.every((s) => s.status !== 'available');

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
    return (
      <div className={`${CONTAINER} py-10`}>
        <ErrorState message={eventError} />
      </div>
    );
  }
  if (event === null) {
    return <Spinner label="Loading event…" />;
  }

  const style = categoryStyle(event.category);

  return (
    <div>
      {/* Event header */}
      <section className={`bg-gradient-to-br ${style.band}`}>
        <div className={`${CONTAINER} py-10 sm:py-12`}>
          <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white backdrop-blur-sm">
            {categoryLabel(event.category)}
          </span>
          <h1 className="font-display mt-3 max-w-3xl text-2xl font-bold leading-tight text-white sm:text-3xl">{event.title}</h1>
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/90">
            <span className="flex items-center gap-1.5">
              <CalendarIcon width={16} height={16} />
              {formatDateRange(event.startsAt, event.endsAt)}
            </span>
            <span className="flex items-center gap-1.5">
              <MapPinIcon width={16} height={16} />
              {event.venue.name}
              {event.venue.city ? `, ${event.venue.city}` : ''}
            </span>
          </div>
          {event.description && <p className="mt-4 max-w-2xl text-sm text-white/80">{event.description}</p>}
        </div>
      </section>

      <div className={`${CONTAINER} py-8`}>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display flex items-center gap-2 text-lg font-bold text-ink-900">
            <SofaIcon width={20} height={20} className="text-neutral-400" />
            Select your seats
          </h2>
          <span className="flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-neutral-500 shadow-card">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'animate-pulse bg-emerald-500' : 'bg-neutral-300'}`} />
            {connected ? 'Live seat availability' : 'Reconnecting…'}
          </span>
        </div>

        {seatsLoading ? (
          <Spinner label="Loading seat map…" />
        ) : seatsError ? (
          <ErrorState message={seatsError} onRetry={refetch} />
        ) : seats.length === 0 ? (
          <InlineNote>No seats have been configured for this event yet.</InlineNote>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px] lg:items-start">
            <SeatMap seats={seats} selected={selected} onToggle={toggleSeat} disabled={reserving} currency={event.currency} />

            <aside className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5 shadow-card lg:sticky lg:top-20">
              <h2 className="font-display text-sm font-bold uppercase tracking-wide text-neutral-500">Your selection</h2>
              {selectedSeats.length === 0 ? (
                <p className="text-sm text-neutral-400">Select up to {MAX_SEATS} available seats to get started.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {selectedSeats.map((s) => (
                    <li key={s.id} className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2">
                      <span className="font-medium">
                        Seat {s.rowLabel}
                        {s.seatNumber}
                      </span>
                      <span className="text-neutral-500">{formatMoney(event.currency, s.price)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center justify-between border-t border-neutral-200 pt-3">
                <span className="text-sm text-neutral-500">
                  {selectedSeats.length} ticket{selectedSeats.length === 1 ? '' : 's'}
                </span>
                <span className="text-lg font-bold text-ink-900">{formatMoney(event.currency, total)}</span>
              </div>
              {reserveError && <InlineNote tone="error">{reserveError}</InlineNote>}
              <Button onClick={handleReserve} loading={reserving} disabled={selectedSeats.length === 0} size="lg">
                Reserve seats
              </Button>

              <div className="mt-2 border-t border-neutral-200 pt-4">
                <h3 className="font-display text-sm font-bold uppercase tracking-wide text-neutral-500">
                  {soldOut ? 'Sold out — join the waitlist' : 'Can\'t find your seat? Join the waitlist'}
                </h3>
                <p className="mt-1 text-xs text-neutral-400">We'll notify you the moment a seat in your category opens up.</p>
                <div className="mt-3 flex gap-2">
                  <select
                    value={waitlistCategory}
                    onChange={(e) => setWaitlistCategory(e.target.value as SeatCategory)}
                    className="flex-1 rounded-md border border-neutral-300 px-2.5 py-2 text-sm focus-ring"
                  >
                    <option value="standard">Standard</option>
                    <option value="premium">Premium</option>
                  </select>
                  <Button variant="secondary" onClick={handleJoinWaitlist} loading={waitlistBusy}>
                    Join
                  </Button>
                </div>
                {waitlistMessage && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-neutral-500">
                    <ClockIcon width={13} height={13} />
                    {waitlistMessage}
                  </p>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
