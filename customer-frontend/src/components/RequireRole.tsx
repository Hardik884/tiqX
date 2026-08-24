import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import type { UserRole } from '../api/types';

/**
 * Keeps organiser/admin screens out of a customer's way.
 *
 * This is presentation only, and deliberately so: every endpoint behind these
 * routes re-checks the caller's role server-side (`requireAuth` +
 * `requireRole`), and re-reads the role from the database on every request
 * rather than trusting the token. Editing this component - or the session in
 * localStorage - changes which screens render, never what the API will do.
 *
 * A signed-out visitor is sent to sign in and returned here afterwards; a
 * signed-in visitor without the role is sent home rather than to a login form
 * they have already satisfied.
 */
export function RequireRole({ roles, children }: { roles: readonly UserRole[]; children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();

  if (user === null) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  if (!roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
