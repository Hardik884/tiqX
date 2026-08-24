import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftIcon } from '../icons';

/**
 * The heading block every management screen opens with: a small eyebrow for
 * context, the title, and the actions that belong to this screen. Same
 * display typeface and neutral palette as the customer pages, so an organiser
 * moving between the two never crosses a visual seam.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  backTo,
  backLabel,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <div className="mb-6 border-b border-neutral-200 pb-5">
      {backTo && (
        <Link
          to={backTo}
          className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-ink-900 focus-ring"
        >
          <ArrowLeftIcon width={15} height={15} />
          {backLabel ?? 'Back'}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {eyebrow && (
            <span className="text-[11px] font-bold uppercase tracking-widest text-brand-600">{eyebrow}</span>
          )}
          <h1 className="font-display mt-1 text-2xl font-bold text-ink-900 sm:text-[28px]">{title}</h1>
          {description && <p className="mt-1.5 max-w-2xl text-sm text-neutral-500">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
