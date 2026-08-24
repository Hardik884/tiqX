import { Link } from 'react-router-dom';
import type { PublicEventView } from '../api/types';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function EventCard({ event }: { event: PublicEventView }) {
  return (
    <Link
      to={`/events/${event.id}`}
      className="group flex flex-col justify-between rounded border border-neutral-200 p-5 transition-colors hover:border-black focus-ring"
    >
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            {event.category}
          </span>
          {event.availableSeats === 0 && (
            <span className="text-[11px] font-medium uppercase tracking-wide text-red-700">Sold out</span>
          )}
        </div>
        <h3 className="text-base font-semibold leading-snug text-black">{event.title}</h3>
        <p className="mt-1 text-sm text-neutral-500">{formatDate(event.startsAt)}</p>
        <p className="mt-0.5 text-sm text-neutral-500">
          {event.venue.name}
          {event.venue.city ? `, ${event.venue.city}` : ''}
        </p>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-neutral-100 pt-3">
        <span className="text-sm font-medium text-black">
          {event.startingPrice !== null ? `${event.currency} ${event.startingPrice}` : '—'}
        </span>
        <span className="text-xs text-neutral-400 transition-colors group-hover:text-black">View details →</span>
      </div>
    </Link>
  );
}
