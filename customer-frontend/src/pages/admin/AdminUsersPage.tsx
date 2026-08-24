import { useEffect, useState, type FormEvent } from 'react';
import { listUsers, setUserRole } from '../../api/admin';
import type { AdminUser, AdminUsersResult, UserRole } from '../../api/types';
import { Button } from '../../components/Button';
import { EmptyState, ErrorState, InlineNote, Spinner } from '../../components/Feedback';
import { SearchIcon } from '../../components/icons';
import { PageHeader } from '../../components/manage/PageHeader';
import { Pagination } from '../../components/manage/Pagination';
import { SelectInput, TextInput } from '../../components/manage/Field';
import { TableCard, Td, Th } from '../../components/manage/Table';
import { formatDateTime, messageOf } from '../../lib/manage';
import { useAuthStore } from '../../store/auth';

const ROLES: UserRole[] = ['customer', 'organiser', 'admin'];

const ROLE_STYLE: Record<UserRole, string> = {
  admin: 'bg-ink-950 text-white ring-ink-800',
  organiser: 'bg-brand-50 text-brand-700 ring-brand-200',
  customer: 'bg-neutral-100 text-neutral-600 ring-neutral-200',
};

/**
 * Who can do what.
 *
 * This screen exists because registration never accepts a role from the client
 * - everybody signs up as a customer - so promoting someone to organiser is an
 * administrative act with a named admin behind it, not something a form can
 * grant itself. The backend refuses an admin changing their own role, which is
 * why the current account's row has no control.
 *
 * A role change takes effect on that person's very next request: the API
 * re-reads the role from the database on every call rather than trusting a
 * token they already hold.
 */
export function AdminUsersPage() {
  const currentUser = useAuthStore((s) => s.user);
  const [result, setResult] = useState<AdminUsersResult | null>(null);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  async function load(nextPage: number, search: string) {
    setLoading(true);
    setError(null);
    try {
      setResult(await listUsers({ page: nextPage, limit: 20, q: search || undefined }));
    } catch (err) {
      setError(messageOf(err, 'Could not load accounts.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(page, submittedQuery);
  }, [page, submittedQuery]);

  function handleSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSubmittedQuery(query.trim());
  }

  async function handleRoleChange(user: AdminUser, role: UserRole) {
    setBusyUserId(user.id);
    setActionError(null);
    setNote(null);
    try {
      await setUserRole(user.id, role);
      setNote(`${user.email} is now ${/^[aeiou]/.test(role) ? 'an' : 'a'} ${role}.`);
      await load(page, submittedQuery);
    } catch (err) {
      setActionError(messageOf(err, 'Could not change this role.'));
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="People"
        description="Everyone with a tiqX account. Promote a customer to organiser so they can create events."
      />

      <form onSubmit={handleSearch} className="mb-5 flex max-w-md gap-2">
        <div className="relative flex-1">
          <SearchIcon
            width={16}
            height={16}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400"
          />
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email"
            className="pl-10"
          />
        </div>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {actionError && (
        <div className="mb-4">
          <InlineNote tone="error">{actionError}</InlineNote>
        </div>
      )}
      {note && (
        <div className="mb-4">
          <InlineNote tone="success">{note}</InlineNote>
        </div>
      )}

      {loading ? (
        <Spinner label="Loading accounts…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(page, submittedQuery)} />
      ) : result && result.users.length === 0 ? (
        <EmptyState
          title="No accounts match"
          description="Try a different name or email address."
          icon={<SearchIcon width={22} height={22} />}
        />
      ) : result ? (
        <TableCard>
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Role</Th>
              <Th>Joined</Th>
              <Th className="text-right">Change role</Th>
            </tr>
          </thead>
          <tbody>
            {result.users.map((user) => {
              const isSelf = currentUser?.id === user.id;
              return (
                <tr key={user.id} className="transition-colors hover:bg-neutral-50">
                  <Td>
                    <span className="block font-medium text-ink-900">{user.name}</span>
                    <span className="block text-xs text-neutral-500">{user.email}</span>
                  </Td>
                  <Td>
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset ${ROLE_STYLE[user.role]}`}
                    >
                      {user.role}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap text-neutral-600">{formatDateTime(user.createdAt)}</Td>
                  <Td className="text-right">
                    {isSelf ? (
                      <span className="text-xs text-neutral-400">Your own account</span>
                    ) : (
                      <SelectInput
                        aria-label={`Role for ${user.email}`}
                        className="ml-auto w-40"
                        value={user.role}
                        disabled={busyUserId === user.id}
                        onChange={(e) => handleRoleChange(user, e.target.value as UserRole)}
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </SelectInput>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} className="p-0">
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
