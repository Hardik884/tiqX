import { getMe } from '../api/auth';
import { useAuthStore } from '../store/auth';

/**
 * Reconciles the stored role with what the API says it is now.
 *
 * The session in localStorage is a snapshot from sign-in time. An admin can
 * promote someone to organiser - or demote them - while they are signed in,
 * and until this runs their navigation would still offer the old set of
 * links. Failures are swallowed on purpose: this is a cosmetic
 * reconciliation, not a gate. The API re-reads the real role from the
 * database on every request, so nothing here can grant access, and a request
 * the true role does not allow is refused whatever this browser believes.
 *
 * Lives here rather than in the store so the store stays free of any
 * dependency on the API layer - `api/client` already reads the store, and the
 * reverse edge would close a cycle.
 */
export async function syncSessionRole(): Promise<void> {
  const { accessToken, user, setRole } = useAuthStore.getState();
  if (accessToken === null || user === null) {
    return;
  }

  try {
    const me = await getMe();
    if (me.user.id === user.id) {
      setRole(me.user.role);
    }
  } catch {
    // A dropped network or an expired session is for the next real request to
    // notice, not this one.
  }
}
