import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { cancelBooking, getBookingDetail } from '../api/bookings';
import { ApiError, newIdempotencyKey } from '../api/client';
import type { BookingDetail } from '../api/types';
import { Button } from '../components/Button';
import { ErrorState, InlineNote, Spinner } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { ArrowLeftIcon, CalendarIcon, CheckCircleIcon, MapPinIcon } from '../components/icons';
import { CONTAINER, formatMoney } from '../lib/ui';

function TicketQr({ ticketId, ticketReference }: { ticketId: string; ticketReference: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const payload = JSON.stringify({ v: 1, ticketId, ticketReference });
    QRCode.toDataURL(payload, { margin: 1, width: 176, color: { dark: '#0a0a0b', light: '#ffffff' } })
      .then(setDataUrl)
      .catch(() => setDataUrl(null));
  }, [ticketId, ticketReference]);

  if (dataUrl === null) {
    return <div className="skeleton h-32 w-32 rounded-md" />;
  }
  return <img src={dataUrl} alt={`QR code for ticket ${ticketReference}`} className="h-32 w-32 rounded-md border border-neutral-100" />;
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
  if (error) {
    return (
      <div className={`${CONTAINER} py-10`}>
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }
  if (detail === null) return null;

  const activeSeats = detail.seats.filter((s) => !s.cancelled);
  const cancelled = detail.status === 'cancelled';

  return (
    <div className={`${CONTAINER} py-8 sm:py-10`}>
      <div className="mx-auto max-w-2xl">
        {justBooked && (
          <div className="mb-6 flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-4 animate-fadeUp">
            <CheckCircleIcon width={26} height={26} className="shrink-0 text-emerald-600" />
            <div>
              <p className="text-sm font-bold text-emerald-800">Booking confirmed</p>
              <p className="mt-0.5 text-sm text-emerald-700">Your tickets are ready below — see you there!</p>
            </div>
          </div>
        )}

        {/* Ticket card */}
        <div className={`relative overflow-hidden rounded-xl border bg-white shadow-card ${cancelled ? 'border-neutral-200 opacity-75' : 'border-neutral-200'}`}>
          <div className={`h-2 w-full ${cancelled ? 'bg-neutral-300' : 'bg-gradient-to-r from-brand-600 to-brand-500'}`} />

          <div className="flex flex-wrap items-start justify-between gap-4 p-6 pb-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Booking reference</p>
              <p className="mt-0.5 font-mono text-lg font-bold tracking-wide text-ink-900">{detail.bookingReference}</p>
            </div>
            <StatusBadge status={detail.status} />
          </div>

          <div className="grid grid-cols-1 gap-4 px-6 text-sm sm:grid-cols-2">
            <div>
              <p className="flex items-center gap-1.5 text-neutral-400">Event</p>
              <p className="mt-0.5 font-semibold text-ink-900">{detail.eventTitle}</p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-neutral-400">
                <MapPinIcon width={13} height={13} /> Venue
              </p>
              <p className="mt-0.5 font-semibold text-ink-900">
                {detail.venueName}
                {detail.venueCity ? `, ${detail.venueCity}` : ''}
              </p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-neutral-400">
                <CalendarIcon width={13} height={13} /> Date &amp; time
              </p>
              <p className="mt-0.5 font-semibold text-ink-900">{new Date(detail.eventStartsAt).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-neutral-400">Total paid</p>
              <p className="mt-0.5 font-semibold text-ink-900">{formatMoney(detail.currency, detail.totalAmount)}</p>
            </div>
          </div>

          <div className="px-6 pt-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Seats</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {detail.seats.map((seat) => (
                <li
                  key={seat.showSeatId}
                  className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                    seat.cancelled ? 'border-neutral-200 text-neutral-300 line-through' : 'border-neutral-200 bg-neutral-50 text-ink-800'
                  }`}
                >
                  {seat.rowLabel}
                  {seat.seatNumber}
                </li>
              ))}
            </ul>
          </div>

          {/* Perforated seam */}
          <div className="relative my-6">
            <div className="ticket-notch-left" />
            <div className="ticket-notch-right" />
            <div className="border-t border-dashed border-neutral-200" />
          </div>

          {detail.tickets.length > 0 && (
            <div className="px-6 pb-6">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                {detail.tickets.length} ticket{detail.tickets.length === 1 ? '' : 's'} · scan at entry
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {detail.tickets.map((ticket) => (
                  <div key={ticket.id} className="flex items-center gap-4 rounded-lg border border-neutral-100 bg-neutral-50/60 p-4">
                    <TicketQr ticketId={ticket.id} ticketReference={ticket.ticketReference} />
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-semibold text-ink-900">{ticket.ticketReference}</p>
                      <div className="mt-1.5">
                        <StatusBadge status={ticket.status} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {detail.status === 'confirmed' && activeSeats.length > 0 && (
          <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-5">
            <p className="text-sm font-medium text-ink-900">Need to cancel?</p>
            <p className="mt-0.5 text-sm text-neutral-500">Your seats will be released back for others to book.</p>
            {cancelError && (
              <div className="mt-3">
                <InlineNote tone="error">{cancelError}</InlineNote>
              </div>
            )}
            <Button variant="danger" onClick={handleCancel} loading={cancelling} className="mt-3">
              Cancel booking
            </Button>
          </div>
        )}

        <Link to="/bookings" className="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600">
          <ArrowLeftIcon width={15} height={15} />
          Back to my tickets
        </Link>
      </div>
    </div>
  );
}
