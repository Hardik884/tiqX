import { useEffect, useState } from 'react';
import { searchEvents } from '../api/events';
import { ApiError } from '../api/client';
import type { EventCategory, EventSortMode, PublicEventView } from '../api/types';
import { EventCard } from '../components/EventCard';
import { Button } from '../components/Button';
import { EmptyState, ErrorState, EventCardSkeleton } from '../components/Feedback';
import { CalendarIcon, ChevronDownIcon, MapPinIcon, SearchIcon } from '../components/icons';
import { CONTAINER, categoryLabel } from '../lib/ui';

const CATEGORIES: EventCategory[] = ['music', 'comedy', 'sports', 'theatre', 'movies', 'other'];
const SORTS: { value: EventSortMode; label: string }[] = [
  { value: 'start_asc', label: 'Date: soonest first' },
  { value: 'start_desc', label: 'Date: latest first' },
  { value: 'name_asc', label: 'Name: A → Z' },
  { value: 'name_desc', label: 'Name: Z → A' },
];

export function EventsPage() {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<EventCategory | ''>('');
  const [city, setCity] = useState('');
  const [sort, setSort] = useState<EventSortMode>('start_asc');

  const [items, setItems] = useState<PublicEventView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSearch(reset: boolean) {
    if (reset) {
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
    }
    try {
      const result = await searchEvents({
        q: q || undefined,
        category: category || undefined,
        city: city || undefined,
        sort,
        cursor: reset ? undefined : (cursor ?? undefined),
      });
      setItems((prev) => (reset ? result.items : [...prev, ...result.items]));
      setCursor(result.pagination.nextCursor);
      setHasMore(result.pagination.hasMore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load events right now.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    // Sort and category act as instant filters; free-text search and city wait for submit.
    void runSearch(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, category]);

  function handleFilterSubmit(e: React.FormEvent) {
    e.preventDefault();
    void runSearch(true);
  }

  function toggleCategory(c: EventCategory) {
    setCategory((prev) => (prev === c ? '' : c));
  }

  const activeFilterCount = [q, category, city].filter(Boolean).length;
  const sectionTitle = sort === 'start_desc' ? 'Recently added' : 'Upcoming events';

  return (
    <div>
      {/* Hero / discovery banner */}
      <section className="bg-ink-950 bg-[radial-gradient(ellipse_80%_60%_at_50%_-20%,rgba(220,47,67,0.25),transparent)]">
        <div className={`${CONTAINER} py-12 sm:py-16`}>
          <h1 className="font-display max-w-xl text-3xl font-bold leading-tight text-white sm:text-4xl">
            Book tickets for live events near you
          </h1>
          <p className="mt-3 max-w-lg text-sm text-neutral-400 sm:text-base">
            Concerts, comedy nights, sports and theatre — find your next night out and grab a seat before it's gone.
          </p>

          <form onSubmit={handleFilterSubmit} className="mt-7 flex flex-col gap-2.5 sm:flex-row">
            <div className="relative flex-1">
              <SearchIcon width={18} height={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-neutral-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search events, artists, venues…"
                className="w-full rounded-md border-0 bg-white py-3.5 pl-11 pr-3 text-sm text-ink-900 shadow-card focus-ring placeholder:text-neutral-400"
              />
            </div>
            <div className="relative sm:w-44">
              <MapPinIcon width={16} height={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" />
              <input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="City"
                className="w-full rounded-md border-0 bg-white py-3.5 pl-9 pr-3 text-sm text-ink-900 shadow-card focus-ring placeholder:text-neutral-400"
              />
            </div>
            <Button type="submit" variant="primary" size="lg" className="sm:w-auto">
              Search
            </Button>
          </form>
        </div>
      </section>

      <div className={CONTAINER}>
        {/* Category chips */}
        <div className="flex gap-2 overflow-x-auto py-6 scrollbar-none">
          <button
            onClick={() => setCategory('')}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors focus-ring ${
              category === '' ? 'bg-ink-950 text-white' : 'bg-white text-neutral-600 ring-1 ring-inset ring-neutral-200 hover:ring-neutral-300'
            }`}
          >
            All categories
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => toggleCategory(c)}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors focus-ring ${
                category === c ? 'bg-ink-950 text-white' : 'bg-white text-neutral-600 ring-1 ring-inset ring-neutral-200 hover:ring-neutral-300'
              }`}
            >
              {categoryLabel(c)}
            </button>
          ))}
        </div>

        {/* Sort + result count */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 pb-5">
          <div>
            <h2 className="font-display text-xl font-bold text-ink-900">{sectionTitle}</h2>
            {!loading && !error && (
              <p className="mt-0.5 text-sm text-neutral-500">
                {items.length} event{items.length === 1 ? '' : 's'}
                {activeFilterCount > 0 ? ' matching your filters' : ''}
              </p>
            )}
          </div>
          <label className="relative flex items-center">
            <CalendarIcon width={15} height={15} className="pointer-events-none absolute left-3 text-neutral-400" />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as EventSortMode)}
              className="appearance-none rounded-md border border-neutral-300 bg-white py-2 pl-8 pr-8 text-sm font-medium text-ink-800 focus-ring"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <ChevronDownIcon width={14} height={14} className="pointer-events-none absolute right-2.5 text-neutral-400" />
          </label>
        </div>

        <div className="pb-16">
          {loading ? (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <EventCardSkeleton key={i} />
              ))}
            </div>
          ) : error ? (
            <ErrorState message={error} onRetry={() => runSearch(true)} />
          ) : items.length === 0 ? (
            <EmptyState
              title="No events match your search"
              description="Try a broader search, clear your filters, or check back soon — new events are added regularly."
              icon={<SearchIcon width={22} height={22} />}
            />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((event) => (
                  <EventCard key={event.id} event={event} />
                ))}
              </div>
              {hasMore && (
                <div className="mt-10 flex justify-center">
                  <Button variant="secondary" size="lg" loading={loadingMore} onClick={() => runSearch(false)}>
                    Load more events
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
