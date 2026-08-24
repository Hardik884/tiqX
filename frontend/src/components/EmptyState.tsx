import type { ReactNode } from 'react';

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="state-block">
      <h3>{title}</h3>
      {description ? <p className="text-sm">{description}</p> : null}
      {action}
    </div>
  );
}
