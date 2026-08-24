import type { ReactNode } from 'react';

/**
 * One headline number. Every value shown in these comes straight from a
 * backend aggregate - nothing on a management screen is totalled in the
 * browser, so what an organiser reads here is what the database says.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  tone?: 'default' | 'accent';
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border p-4 shadow-card ${
        tone === 'accent' ? 'border-ink-800 bg-ink-950 text-white' : 'border-neutral-200 bg-white'
      }`}
    >
      <span
        className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${
          tone === 'accent' ? 'text-neutral-400' : 'text-neutral-500'
        }`}
      >
        {icon}
        {label}
      </span>
      <span
        className={`font-display text-2xl font-bold ${tone === 'accent' ? 'text-white' : 'text-ink-900'}`}
      >
        {value}
      </span>
      {hint && (
        <span className={`text-xs ${tone === 'accent' ? 'text-neutral-500' : 'text-neutral-400'}`}>{hint}</span>
      )}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">{children}</div>;
}
