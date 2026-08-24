import type { ReactNode } from 'react';
import { AlertIcon, TicketIcon } from './icons';

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-16 text-sm text-neutral-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-brand-600" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-neutral-300 bg-white px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 text-neutral-400">
        {icon ?? <TicketIcon width={22} height={22} />}
      </div>
      <p className="text-sm font-semibold text-ink-900">{title}</p>
      {description && <p className="max-w-sm text-sm text-neutral-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-red-200 bg-red-50 px-6 py-12 text-center">
      <AlertIcon className="text-red-600" width={24} height={24} />
      <p className="text-sm font-medium text-red-800">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 focus-ring"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function InlineNote({ tone = 'neutral', children }: { tone?: 'neutral' | 'error' | 'success' | 'warning'; children: ReactNode }) {
  const styles = {
    neutral: 'border-neutral-200 bg-neutral-50 text-neutral-700',
    error: 'border-red-200 bg-red-50 text-red-700',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
  }[tone];
  return <div className={`rounded-md border px-3.5 py-2.5 text-sm ${styles}`}>{children}</div>;
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-md ${className}`} />;
}

export function EventCardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <Skeleton className="h-28 w-full rounded-none" />
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-3 w-2/5" />
        <div className="mt-3 flex items-center justify-between border-t border-neutral-100 pt-3">
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>
    </div>
  );
}
