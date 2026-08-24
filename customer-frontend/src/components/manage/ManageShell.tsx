import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../store/auth';
import { CONTAINER } from '../../lib/ui';

interface Section {
  to: string;
  label: string;
  /**
   * Paths this section owns beyond its own, so a chip stays lit on a child
   * screen. `/organiser/events` deliberately does not claim
   * `/organiser/events/new` - that is its sibling's - which is why this is a
   * list rather than a plain prefix match.
   */
  owns?: readonly string[];
}

const ORGANISER_SECTIONS: Section[] = [
  { to: '/organiser/dashboard', label: 'Dashboard' },
  { to: '/organiser/events', label: 'My events', owns: ['/organiser/events/'] },
  { to: '/organiser/events/new', label: 'Create event' },
];

const ADMIN_SECTIONS: Section[] = [
  { to: '/admin/dashboard', label: 'Dashboard' },
  { to: '/admin/venues', label: 'Venues', owns: ['/admin/venues/'] },
  { to: '/admin/events', label: 'Events' },
  { to: '/admin/users', label: 'People' },
];

/**
 * The chrome shared by every organiser and admin screen: a dark section bar
 * under the main header, then the page. It exists so management never feels
 * like a different product - same header, same footer, same container width as
 * the customer pages, with one strip that says which workspace you are in.
 *
 */
export function ManageShell({
  workspace,
  children,
}: {
  workspace: 'organiser' | 'admin';
  children: ReactNode;
}) {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  const sections = workspace === 'admin' ? ADMIN_SECTIONS : ORGANISER_SECTIONS;

  function isActive(section: Section): boolean {
    if (location.pathname === section.to) {
      return true;
    }
    // A child screen lights its parent - but not when another chip claims the
    // path outright, or "Create event" and "My events" would both be lit on
    // /organiser/events/new.
    if (sections.some((other) => other !== section && other.to === location.pathname)) {
      return false;
    }
    return (section.owns ?? []).some((prefix) => location.pathname.startsWith(prefix));
  }

  return (
    <div className="min-h-full bg-neutral-50">
      <div className="border-b border-ink-800 bg-ink-900">
        <div className={`${CONTAINER} flex flex-wrap items-center gap-x-5 gap-y-2 py-3`}>
          <span className="text-[11px] font-bold uppercase tracking-widest text-neutral-500">
            {workspace === 'admin' ? 'Admin' : 'Organiser'}
          </span>
          <nav className="flex flex-1 gap-1 overflow-x-auto scrollbar-none">
            {sections.map((section) => (
              <Link
                key={section.to}
                to={section.to}
                className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-ring ${
                  isActive(section)
                    ? 'bg-white/10 text-white'
                    : 'text-neutral-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                {section.label}
              </Link>
            ))}
          </nav>
          {user && <span className="hidden text-xs text-neutral-500 sm:block">{user.email}</span>}
        </div>
      </div>

      <div className={`${CONTAINER} py-8 pb-16`}>{children}</div>
    </div>
  );
}
