import { Link } from 'react-router-dom';
import type { PublicEventView } from '../api/types';
import { categoryLabel, categoryStyle, formatDateShort, formatMoney } from '../lib/ui';
import { CalendarIcon, ChevronRightIcon, MapPinIcon } from './icons';

export function EventCard({ event }: { event: PublicEventView }) {
  const style = categoryStyle(event.category);
  const soldOut = event.availableSeats === 0;

  return (
    <Link
      to={`/events/${event.id}`}
      className="group flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-neutral-300 hover:shadow-card-hover focus-ring"
    >
      <div className={`relative flex h-28 items-end bg-gradient-to-br p-4 ${style.band}`}>
        <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white backdrop-blur-sm">
          {categoryLabel(event.category)}
        </span>
        {soldOut && (
          <span className="absolute right-3 top-3 rounded-full bg-ink-950/80 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
            Sold out
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug text-ink-900">{event.title}</h3>
        <div className="mt-2.5 flex flex-col gap-1.5 text-[13px] text-neutral-500">
          <span className="flex items-center gap-1.5">
            <CalendarIcon width={14} height={14} className="shrink-0 text-neutral-400" />
            {formatDateShort(event.startsAt)}
          </span>
          <span className="flex items-center gap-1.5">
            <MapPinIcon width={14} height={14} className="shrink-0 text-neutral-400" />
            <span className="truncate">
              {event.venue.name}
              {event.venue.city ? `, ${event.venue.city}` : ''}
            </span>
          </span>
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-neutral-100 pt-3">
          <span className="text-sm font-bold text-ink-900">
            {event.startingPrice !== null ? (
              <>
                <span className="text-[11px] font-medium text-neutral-400">from </span>
                {formatMoney(event.currency, event.startingPrice)}
              </>
            ) : (
              '—'
            )}
          </span>
          <span className="flex items-center gap-0.5 text-xs font-semibold text-brand-600 transition-transform group-hover:translate-x-0.5">
            View details
            <ChevronRightIcon width={14} height={14} />
          </span>
        </div>
      </div>
    </Link>
  );
}
