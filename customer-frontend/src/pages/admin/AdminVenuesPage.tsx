import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listVenues } from '../../api/venues';
import type { VenueSummary } from '../../api/types';
import { Button } from '../../components/Button';
import { EmptyState, ErrorState, Spinner } from '../../components/Feedback';
import { PageHeader } from '../../components/manage/PageHeader';
import { ClickableRow, TableCard, Td, Th } from '../../components/manage/Table';
import { messageOf } from '../../lib/manage';

/** Every venue, with how much of a seat layout each one actually has. */
export function AdminVenuesPage() {
  const navigate = useNavigate();
  const [venues, setVenues] = useState<VenueSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setVenues((await listVenues()).venues);
    } catch (err) {
      setError(messageOf(err, 'Could not load venues.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Venues"
        description="Venues and their physical seat layout. An event can only be created at a venue that has seats."
        actions={
          <Link to="/admin/venues/new">
            <Button variant="primary">New venue</Button>
          </Link>
        }
      />

      {loading ? (
        <Spinner label="Loading venues…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : venues && venues.length === 0 ? (
        <EmptyState
          title="No venues yet"
          description="Add a venue and lay out its seats before organisers can create events."
          action={
            <Link to="/admin/venues/new">
              <Button variant="primary">New venue</Button>
            </Link>
          }
        />
      ) : venues ? (
        <TableCard>
          <thead>
            <tr>
              <Th>Venue</Th>
              <Th>City</Th>
              <Th className="text-right">Seats</Th>
              <Th>Layout</Th>
            </tr>
          </thead>
          <tbody>
            {venues.map((venue) => (
              <ClickableRow key={venue.id} onClick={() => navigate(`/admin/venues/${venue.id}`)}>
                <Td>
                  <span className="font-semibold text-ink-900">{venue.name}</span>
                  {venue.description && (
                    <span className="mt-0.5 block max-w-md truncate text-xs text-neutral-500">
                      {venue.description}
                    </span>
                  )}
                </Td>
                <Td className="text-neutral-600">{venue.city ?? '—'}</Td>
                <Td className="text-right font-medium">{venue.seatCount}</Td>
                <Td>
                  {venue.seatCount === 0 ? (
                    <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700 ring-1 ring-inset ring-amber-200">
                      Needs seats
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200">
                      Ready
                    </span>
                  )}
                </Td>
              </ClickableRow>
            ))}
          </tbody>
        </TableCard>
      ) : null}
    </>
  );
}
