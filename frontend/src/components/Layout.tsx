import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import { useAuth } from '../lib/auth';

const ORGANISER_LINKS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/events', label: 'Events' },
];

const ADMIN_LINKS = [
  { to: '/admin/events', label: 'All events' },
  { to: '/admin/venues', label: 'Venues' },
];

export function Layout({ children }: { children: ReactNode }): JSX.Element {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">tiqX</div>

        <nav className="sidebar-nav">
          <div className="sidebar-section-label">Organiser</div>
          {ORGANISER_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              {link.label}
            </NavLink>
          ))}

          {isAdmin ? (
            <>
              <div className="sidebar-section-label">Admin</div>
              {ADMIN_LINKS.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
                >
                  {link.label}
                </NavLink>
              ))}
            </>
          ) : null}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <span className="sidebar-user-name">{user?.name || user?.email || 'Account'}</span>
            <span className="sidebar-user-role">{user?.role}</span>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
