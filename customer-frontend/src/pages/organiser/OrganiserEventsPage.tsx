import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listOrganiserEvents } from '../../api/organiser';
import type { OrganiserEventsResult } from '../../api/types';
import { Button } from '../../components/Button';
import { EmptyState, ErrorState, Spinner } from '../../components/Feedback';
import { StatusBadge } from '../../components/StatusBadge';
import { PageHeader } from '../../components/manage/PageHeader';
import { Pagination } from '../../components/manage/Pagination';
import { ClickableRow, TableCard, Td, Th } from '../../components/manage/Table';
import { formatDateTime, messageOf } from '../../lib/manage';
import { categoryLabel } from '../../lib/ui';

/** Every event the signed-in organiser owns - the backend scopes this by principal, not by a query. */
export function OrganiserEventsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<OrganiserEventsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(nextPage: number) {
    setLoading(true);
    setError(null);
    try {
      setResult(await listOrganiserEvents({ page: nextPage, limit: 20 }));
    } catch (err) {
      setError(messageOf(err, 'Could not load your events.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(page);
  }, [page]);

  return (
    <>
      <PageHeader
        eyebrow="Manage"
        title="My events"
        description="Everything you have created, draft or live."
        actions={
          <Link to="/organiser/events/new">
            <Button variant="primary">Create event</Button>
          </Link>
        }
      />

      {loading ? (
        <Spinner label="Loading your events…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(page)} />
      ) : result && result.events.length === 0 ? (
        <EmptyState
          title="No events yet"
          description="Create your first event, pick a venue and set your seat prices."
          action={
            <Link to="/organiser/events/new">
              <Button variant="primary">Create event</Button>
            </Link>
          }
        />
      ) : result ? (
        <TableCard>
          <thead>
            <tr>
              <Th>Event</Th>
              <Th>Venue</Th>
              <Th>Status</Th>
              <Th>Starts</Th>
              <Th className="text-right">Seats left</Th>
            </tr>
          </thead>
          <tbody>
            {result.events.map((event) => (
              <ClickableRow key={event.id} onClick={() => navigate(`/organiser/events/${event.id}`)}>
                <Td>
                  <span className="font-semibold text-ink-900">{event.title}</span>
                  <span className="mt-0.5 block text-xs text-neutral-500">{categoryLabel(event.category)}</span>
                </Td>
                <Td className="text-neutral-600">
                  {event.venue.name}
                  {event.venue.city ? `, ${event.venue.city}` : ''}
                </Td>
                <Td>
                  <StatusBadge status={event.status} />
                </Td>
                <Td className="whitespace-nowrap text-neutral-600">{formatDateTime(event.startsAt)}</Td>
                <Td className="text-right font-medium">{event.availableSeats}</Td>
              </ClickableRow>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} className="p-0">
                <Pagination
                  page={result.page}
                  totalPages={result.totalPages}
                  total={result.total}
                  onChange={setPage}
                />
              </td>
            </tr>
          </tfoot>
        </TableCard>
      ) : null}
    </>
  );
}
