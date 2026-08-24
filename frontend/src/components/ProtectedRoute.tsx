import type { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';

import { useAuth } from '../lib/auth';
import type { UserRole } from '../lib/types';
import { Layout } from './Layout';
import { Loading } from './Loading';

interface ProtectedRouteProps {
  children: ReactElement;
  roles?: UserRole[];
}

export function ProtectedRoute({ children, roles }: ProtectedRouteProps): JSX.Element {
  const { user, status } = useAuth();

  if (status === 'loading') {
    return <Loading label="Checking your session…" />;
  }

  if (status === 'anonymous' || user === null) {
    return <Navigate to="/login" replace />;
  }

  // The role check here is a UI convenience only - every route it gates
  // calls an API that re-checks role and, where relevant, resource
  // ownership on the server, under `requireRole`/`requireAuth` and the
  // service's own ownership checks. This never substitutes for that.
  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return <Layout>{children}</Layout>;
}
