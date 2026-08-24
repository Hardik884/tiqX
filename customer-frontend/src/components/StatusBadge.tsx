const styles: Record<string, string> = {
  confirmed: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200',
  cancelled: 'bg-neutral-100 text-neutral-500 ring-1 ring-inset ring-neutral-200',
  issued: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200',
  used: 'bg-neutral-100 text-neutral-500 ring-1 ring-inset ring-neutral-200',
  void: 'bg-neutral-100 text-neutral-500 ring-1 ring-inset ring-neutral-200',
  waiting: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200',
  offered: 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200',
  accepted: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200',
  expired: 'bg-neutral-100 text-neutral-500 ring-1 ring-inset ring-neutral-200',
  published: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200',
  draft: 'bg-neutral-100 text-neutral-500 ring-1 ring-inset ring-neutral-200',
};

export function StatusBadge({ status }: { status: string }) {
  const style = styles[status] ?? 'bg-neutral-100 text-neutral-600 ring-1 ring-inset ring-neutral-200';
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${style}`}>
      {status}
    </span>
  );
}
