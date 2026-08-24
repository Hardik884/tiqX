import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { StatusBadge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { Pagination } from '../components/Pagination';
import { api, ApiError } from '../lib/api';
import { formatDate } from '../lib/format';
import type { OrganiserEventsResult } from '../lib/types';

export function EventsList(): JSX.Element {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<OrganiserEventsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .get<OrganiserEventsResult>('/organiser/events', { page, limit: 20 })
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load your events.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [page]);

  return (
    <div>
      <div className="main-header">
        <div className="main-header-text">
          <span className="main-header-eyebrow">Manage</span>
          <h1>Events</h1>
        </div>
        <div className="main-header-actions">
          <Link to="/events/new" className="btn">
            New event
          </Link>
        </div>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      {loading ? (
        <Loading label="Loading events…" />
      ) : result && result.events.length === 0 ? (
        <EmptyState
          title="No events yet"
          description="Create your first event to start selling tickets."
          action={
            <Link to="/events/new" className="btn">
              New event
            </Link>
          }
        />
      ) : result ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Venue</th>
                <th>Status</th>
                <th>Starts</th>
                <th>Available seats</th>
              </tr>
            </thead>
            <tbody>
              {result.events.map((event) => (
                <tr
                  key={event.id}
                  className="table-clickable-row"
                  onClick={() => navigate(`/events/${event.id}`)}
                >
                  <td>{event.title}</td>
                  <td>{event.venue.name}</td>
                  <td>
                    <StatusBadge status={event.status} />
                  </td>
                  <td>{formatDate(event.startsAt)}</td>
                  <td>{event.availableSeats}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={result.page} totalPages={result.totalPages} total={result.total} onChange={setPage} />
        </div>
      ) : null}
    </div>
  );
}
