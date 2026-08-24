import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatCard } from '../components/StatCard';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMoney } from '../lib/format';
import type { DashboardTotals } from '../lib/types';

export function Dashboard(): JSX.Element {
  const { user } = useAuth();
  const [totals, setTotals] = useState<DashboardTotals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scopeAll, setScopeAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .get<DashboardTotals>('/organiser/dashboard', { all: scopeAll })
      .then((result) => {
        if (!cancelled) setTotals(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load the dashboard.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [scopeAll]);

  return (
    <div>
      <div className="main-header">
        <div className="main-header-text">
          <span className="main-header-eyebrow">Overview</span>
          <h1>Dashboard</h1>
        </div>
        <div className="main-header-actions">
          {user?.role === 'admin' ? (
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={scopeAll} onChange={(event) => setScopeAll(event.target.checked)} />
              All organisers
            </label>
          ) : null}
          <Link to="/events/new" className="btn">
            New event
          </Link>
        </div>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      {loading ? (
        <Loading label="Loading your dashboard…" />
      ) : totals ? (
        <div className="stat-grid">
          <StatCard label="Upcoming events" value={String(totals.upcomingEvents)} />
          <StatCard label="Total bookings" value={String(totals.totalBookings)} />
          <StatCard label="Seats sold" value={String(totals.seatsSold)} />
          <StatCard label="Available seats" value={String(totals.availableSeats)} />
          <StatCard label="Revenue" value={formatMoney(totals.revenue, 'INR')} sub="confirmed bookings" />
        </div>
      ) : null}

      <div className="card card-pad flex-col gap-2">
        <h3>Getting started</h3>
        <p className="text-sm text-muted">
          Manage your events, seat inventory and bookings from the Events section. Every number above comes straight
          from the backend - nothing here is computed in the browser.
        </p>
      </div>
    </div>
  );
}
