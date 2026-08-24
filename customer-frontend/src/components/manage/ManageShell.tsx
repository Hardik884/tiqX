import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuthStore } from '../../store/auth';
import { CONTAINER } from '../../lib/ui';

interface Section {
  to: string;
  label: string;
  /** Only `/organiser` and `/admin` themselves need an exact match; the rest own their subtrees. */
  end?: boolean;
}

const ORGANISER_SECTIONS: Section[] = [
  { to: '/organiser/dashboard', label: 'Dashboard' },
  { to: '/organiser/events', label: 'My events' },
  { to: '/organiser/events/new', label: 'Create event' },
];

const ADMIN_SECTIONS: Section[] = [
  { to: '/admin/dashboard', label: 'Dashboard' },
  { to: '/admin/venues', label: 'Venues' },
  { to: '/admin/events', label: 'Events' },
  { to: '/admin/users', label: 'People' },
];

/**
 * The chrome shared by every organiser and admin screen: a dark section bar
 * under the main header, then the page. It exists so management never feels
 * like a different product - same header, same footer, same container width as
 * the customer pages, with one strip that says which workspace you are in.
 *
 * `/organiser/events/new` is listed before `/organiser/events/:id` would ever
 * match it in the router; here the ordering only affects which chip highlights.
 */
export function ManageShell({
  workspace,
  children,
}: {
  workspace: 'organiser' | 'admin';
  children: ReactNode;
}) {
  const user = useAuthStore((s) => s.user);
  const sections = workspace === 'admin' ? ADMIN_SECTIONS : ORGANISER_SECTIONS;

  return (
    <div className="min-h-full bg-neutral-50">
      <div className="border-b border-ink-800 bg-ink-900">
        <div className={`${CONTAINER} flex flex-wrap items-center gap-x-5 gap-y-2 py-3`}>
          <span className="text-[11px] font-bold uppercase tracking-widest text-neutral-500">
            {workspace === 'admin' ? 'Admin' : 'Organiser'}
          </span>
          <nav className="flex flex-1 gap-1 overflow-x-auto scrollbar-none">
            {sections.map((section) => (
              <NavLink
                key={section.to}
                to={section.to}
                end={section.end ?? section.to.endsWith('/new')}
                className={({ isActive }) =>
                  `shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-ring ${
                    isActive ? 'bg-white/10 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-white'
                  }`
                }
              >
                {section.label}
              </NavLink>
            ))}
          </nav>
          {user && <span className="hidden text-xs text-neutral-500 sm:block">{user.email}</span>}
        </div>
      </div>

      <div className={`${CONTAINER} py-8 pb-16`}>{children}</div>
    </div>
  );
}
