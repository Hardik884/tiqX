import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { logout as apiLogout } from '../api/auth';
import { Button } from './Button';

export function Layout({ children }: { children: ReactNode }) {
  const { user, refreshToken, clearSession } = useAuthStore();
  const navigate = useNavigate();

  async function handleLogout() {
    if (refreshToken !== null) {
      try {
        await apiLogout(refreshToken);
      } catch {
        // Logout is best-effort client side regardless of server outcome.
      }
    }
    clearSession();
    navigate('/');
  }

  return (
    <div className="min-h-screen bg-white text-black">
      <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            tiqX
          </Link>
          <nav className="flex items-center gap-1 sm:gap-2">
            <Link
              to="/"
              className="rounded px-3 py-2 text-sm text-neutral-600 hover:text-black focus-ring"
            >
              Events
            </Link>
            {user && (
              <>
                <Link
                  to="/bookings"
                  className="rounded px-3 py-2 text-sm text-neutral-600 hover:text-black focus-ring"
                >
                  My Tickets
                </Link>
                <Link
                  to="/waitlist"
                  className="rounded px-3 py-2 text-sm text-neutral-600 hover:text-black focus-ring"
                >
                  Waitlist
                </Link>
              </>
            )}
            {user ? (
              <Button variant="ghost" onClick={handleLogout} className="ml-2">
                Sign out
              </Button>
            ) : (
              <Link to="/login">
                <Button variant="primary" className="ml-2">
                  Sign in
                </Button>
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
