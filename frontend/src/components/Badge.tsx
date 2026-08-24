import type { ReactNode } from 'react';

import type { EventStatus } from '../lib/types';

const STATUS_STYLE: Record<EventStatus, string> = {
  draft: 'badge-neutral',
  published: 'badge-success',
  cancelled: 'badge-danger',
  completed: 'badge-outline',
};

export function StatusBadge({ status }: { status: EventStatus }): JSX.Element {
  return <span className={`badge ${STATUS_STYLE[status]}`}>{status}</span>;
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'danger' | 'outline'; children: ReactNode }): JSX.Element {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
