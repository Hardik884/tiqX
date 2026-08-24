import { useEffect, useState } from 'react';

import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { api, ApiError } from '../lib/api';
import type { Venue } from '../lib/types';

export function AdminVenues(): JSX.Element {
  const [venues, setVenues] = useState<Venue[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ venues: Venue[] }>('/venues')
      .then((data) => {
        if (!cancelled) setVenues(data.venues);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load venues.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className="main-header">
        <div className="main-header-text">
          <span className="main-header-eyebrow">Admin</span>
          <h1>Venues</h1>
        </div>
      </div>

      <p className="text-sm text-muted mb-4">
        Read-only: venue creation and seat layout are provisioned outside this dashboard.
      </p>

      {error ? <ErrorBanner message={error} /> : null}

      {loading ? (
        <Loading label="Loading venues…" />
      ) : venues && venues.length === 0 ? (
        <EmptyState title="No venues configured" />
      ) : venues ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>City</th>
                <th>Seats</th>
              </tr>
            </thead>
            <tbody>
              {venues.map((venue) => (
                <tr key={venue.id}>
                  <td>{venue.name}</td>
                  <td>{venue.city ?? '—'}</td>
                  <td>{venue.seatCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
