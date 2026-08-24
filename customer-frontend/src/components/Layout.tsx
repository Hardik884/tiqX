import { type ReactNode, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { logout as apiLogout } from '../api/auth';
import type { UserRole } from '../api/types';
import { Button } from './Button';
import { CloseIcon, MenuIcon, TicketIcon, UserIcon } from './icons';
import { CONTAINER } from '../lib/ui';

interface NavLink {
  to: string;
  label: string;
  /** Which roles see this link at all. `undefined` means everybody, signed in or not. */
  roles?: readonly UserRole[];
  /** Signed-in-only, for links every role gets once they have an account. */
  auth?: boolean;
}

/**
 * One navigation for one app.
 *
 * A customer sees only the customer links; an organiser additionally sees their
 * workspace; an admin sees both theirs and the organiser one, because an admin
 * genuinely can act on events. Nothing about a management link is rendered for
 * a role that does not have it - and the API would refuse the call anyway,
 * which is the check that actually matters.
 */
const NAV_LINKS: NavLink[] = [
  { to: '/', label: 'Events' },
  { to: '/bookings', label: 'My Tickets', auth: true },
  { to: '/waitlist', label: 'Waitlist', auth: true },
  { to: '/organiser/dashboard', label: 'Organiser', roles: ['organiser', 'admin'] },
  { to: '/admin/dashboard', label: 'Admin', roles: ['admin'] },
];

function visibleLinks(role: UserRole | null): NavLink[] {
  return NAV_LINKS.filter((link) => {
    if (link.roles !== undefined) {
      return role !== null && link.roles.includes(role);
    }
    return link.auth !== true || role !== null;
  });
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, refreshToken, clearSession } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  async function handleLogout() {
    if (refreshToken !== null) {
      try {
        await apiLogout(refreshToken);
      } catch {
        // Logout is best-effort client side regardless of server outcome.
      }
    }
    clearSession();
    setMenuOpen(false);
    navigate('/');
  }

  const links = visibleLinks(user?.role ?? null);

  function isActive(to: string): boolean {
    if (to === '/') {
      return location.pathname === '/' || location.pathname === '/events';
    }
    // A workspace link stays lit anywhere inside its section, not just on its
    // own path - /organiser/events/:id is still "Organiser".
    const section = to.split('/')[1];
    return location.pathname === to || location.pathname.startsWith(`/${section}/`);
  }

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 text-ink-900">
      <header className="sticky top-0 z-30 border-b border-ink-800 bg-ink-950">
        <div className={`${CONTAINER} flex h-16 items-center justify-between`}>
          <Link to="/" className="flex items-center gap-1.5 text-xl font-extrabold tracking-tight text-white">
            <span className="font-display">tiq</span>
            <span className="font-display text-brand-500">X</span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {links.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={`rounded-md px-3.5 py-2 text-sm font-medium transition-colors focus-ring ${
                  isActive(link.to) ? 'bg-white/10 text-white' : 'text-neutral-300 hover:bg-white/5 hover:text-white'
                }`}
              >
                {link.label}
              </Link>
            ))}
            {user ? (
              <div className="ml-3 flex items-center gap-2 border-l border-white/10 pl-3">
                <span className="flex items-center gap-1.5 text-sm text-neutral-300">
                  <UserIcon width={16} height={16} />
                  {user.email}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleLogout}
                  className="text-neutral-300 hover:bg-white/10 hover:text-white"
                >
                  Sign out
                </Button>
              </div>
            ) : (
              <Link to="/login" className="ml-2">
                <Button variant="primary" size="sm">
                  Sign in
                </Button>
              </Link>
            )}
          </nav>

          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-md p-2 text-white focus-ring md:hidden"
            aria-label="Toggle menu"
          >
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>

        {menuOpen && (
          <nav className="border-t border-white/10 bg-ink-950 md:hidden">
            <div className="flex flex-col gap-1 px-4 py-3">
              {links.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  onClick={() => setMenuOpen(false)}
                  className={`flex items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium ${
                    isActive(link.to) ? 'bg-white/10 text-white' : 'text-neutral-300'
                  }`}
                >
                  <TicketIcon width={16} height={16} />
                  {link.label}
                </Link>
              ))}
              {user ? (
                <button
                  onClick={handleLogout}
                  className="mt-1 flex items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm font-medium text-neutral-300"
                >
                  <UserIcon width={16} height={16} />
                  Sign out ({user.email})
                </button>
              ) : (
                <Link to="/login" onClick={() => setMenuOpen(false)} className="mt-1">
                  <Button variant="primary" size="sm" className="w-full">
                    Sign in
                  </Button>
                </Link>
              )}
            </div>
          </nav>
        )}
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-neutral-200 bg-white py-6">
        <div
          className={`${CONTAINER} flex flex-col items-center justify-between gap-2 text-xs text-neutral-400 sm:flex-row`}
        >
          <span>© {new Date().getFullYear()} tiqX. All rights reserved.</span>
          <span>Book with confidence.</span>
        </div>
      </footer>
    </div>
  );
}
