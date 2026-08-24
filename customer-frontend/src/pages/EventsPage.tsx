import { useEffect, useState } from 'react';
import { searchEvents } from '../api/events';
import { ApiError } from '../api/client';
import type { EventCategory, EventSortMode, PublicEventView } from '../api/types';
import { EventCard } from '../components/EventCard';
import { Button } from '../components/Button';
import { EmptyState, ErrorState, Spinner } from '../components/Feedback';

const CATEGORIES: EventCategory[] = ['music', 'comedy', 'sports', 'theatre', 'other'];
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
        cursor: reset ? undefined : cursor ?? undefined,
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
    void runSearch(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort]);

  function handleFilterSubmit(e: React.FormEvent) {
    e.preventDefault();
    void runSearch(true);
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Find your next event</h1>
        <p className="mt-1 text-sm text-neutral-500">Search live shows, concerts and screenings.</p>
      </div>

      <form onSubmit={handleFilterSubmit} className="mb-8 flex flex-wrap gap-3 border-b border-neutral-200 pb-6">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search events…"
          className="min-w-[200px] flex-1 rounded border border-neutral-300 px-3 py-2 text-sm focus-ring"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as EventCategory | '')}
          className="rounded border border-neutral-300 px-3 py-2 text-sm focus-ring"
        >
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c[0].toUpperCase() + c.slice(1)}
            </option>
          ))}
        </select>
        <input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="City"
          className="w-32 rounded border border-neutral-300 px-3 py-2 text-sm focus-ring"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as EventSortMode)}
          className="rounded border border-neutral-300 px-3 py-2 text-sm focus-ring"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {loading ? (
        <Spinner label="Loading events…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => runSearch(true)} />
      ) : items.length === 0 ? (
        <EmptyState title="No events match your search" description="Try a broader search or clear your filters." />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
          {hasMore && (
            <div className="mt-8 flex justify-center">
              <Button variant="secondary" loading={loadingMore} onClick={() => runSearch(false)}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
