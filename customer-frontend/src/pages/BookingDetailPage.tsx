import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { cancelBooking, getBookingDetail } from '../api/bookings';
import { ApiError, newIdempotencyKey } from '../api/client';
import type { BookingDetail } from '../api/types';
import { Button } from '../components/Button';
import { ErrorState, InlineNote, Spinner } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';

function TicketQr({ ticketId, ticketReference }: { ticketId: string; ticketReference: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const payload = JSON.stringify({ v: 1, ticketId, ticketReference });
    QRCode.toDataURL(payload, { margin: 1, width: 160, color: { dark: '#000000', light: '#ffffff' } })
      .then(setDataUrl)
      .catch(() => setDataUrl(null));
  }, [ticketId, ticketReference]);

  if (dataUrl === null) {
    return <div className="h-40 w-40 animate-pulse rounded bg-neutral-100" />;
  }
  return <img src={dataUrl} alt={`QR code for ticket ${ticketReference}`} className="h-40 w-40" />;
}

export function BookingDetailPage() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const location = useLocation();
  const justBooked = (location.state as { justBooked?: boolean } | null)?.justBooked ?? false;

  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  async function load() {
    if (bookingId === undefined) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await getBookingDetail(bookingId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this booking.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  async function handleCancel() {
    if (detail === null) return;
    if (!window.confirm('Cancel this booking? Seats will be released and this cannot be undone.')) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelBooking(detail.bookingId, newIdempotencyKey());
      await load();
    } catch (err) {
      setCancelError(err instanceof ApiError ? err.message : 'Could not cancel this booking.');
    } finally {
      setCancelling(false);
    }
  }

  if (loading) return <Spinner label="Loading booking…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (detail === null) return null;

  const activeSeats = detail.seats.filter((s) => !s.cancelled);

  return (
    <div className="mx-auto max-w-2xl">
      {justBooked && (
        <div className="mb-6 rounded border border-black bg-black px-5 py-4 text-white">
          <p className="text-sm font-semibold">Booking confirmed</p>
          <p className="mt-0.5 text-sm text-neutral-300">Your tickets are ready below.</p>
        </div>
      )}

      <div className="flex items-start justify-between gap-4 border-b border-neutral-200 pb-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Booking reference</p>
          <p className="mt-0.5 font-mono text-lg font-semibold">{detail.bookingReference}</p>
        </div>
        <StatusBadge status={detail.status} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
        <div>
          <p className="text-neutral-400">Event</p>
          <p className="font-medium">{detail.eventTitle}</p>
        </div>
        <div>
          <p className="text-neutral-400">Venue</p>
          <p className="font-medium">
            {detail.venueName}
            {detail.venueCity ? `, ${detail.venueCity}` : ''}
          </p>
        </div>
        <div>
          <p className="text-neutral-400">Date</p>
          <p className="font-medium">{new Date(detail.eventStartsAt).toLocaleString()}</p>
        </div>
        <div>
          <p className="text-neutral-400">Total paid</p>
          <p className="font-medium">
            {detail.currency} {detail.totalAmount}
          </p>
        </div>
      </div>

      <div className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Seats</h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {detail.seats.map((seat) => (
            <li
              key={seat.showSeatId}
              className={`rounded border px-3 py-1.5 text-sm ${seat.cancelled ? 'border-neutral-200 text-neutral-300 line-through' : 'border-neutral-300'}`}
            >
              {seat.rowLabel}
              {seat.seatNumber}
            </li>
          ))}
        </ul>
      </div>

      {detail.tickets.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Tickets</h2>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {detail.tickets.map((ticket) => (
              <div key={ticket.id} className="flex items-center gap-4 rounded border border-neutral-200 p-4">
                <TicketQr ticketId={ticket.id} ticketReference={ticket.ticketReference} />
                <div className="min-w-0">
                  <p className="font-mono text-sm font-medium">{ticket.ticketReference}</p>
                  <div className="mt-1">
                    <StatusBadge status={ticket.status} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.status === 'confirmed' && activeSeats.length > 0 && (
        <div className="mt-8 border-t border-neutral-200 pt-5">
          {cancelError && <InlineNote tone="error">{cancelError}</InlineNote>}
          <Button variant="danger" onClick={handleCancel} loading={cancelling} className="mt-3">
            Cancel booking
          </Button>
        </div>
      )}

      <Link to="/bookings" className="mt-8 inline-block text-sm font-medium underline underline-offset-2">
        ← Back to my tickets
      </Link>
    </div>
  );
}
