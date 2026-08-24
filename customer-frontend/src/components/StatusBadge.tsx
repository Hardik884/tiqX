const styles: Record<string, string> = {
  confirmed: 'bg-black text-white',
  cancelled: 'bg-neutral-200 text-neutral-500',
  issued: 'bg-black text-white',
  used: 'bg-neutral-200 text-neutral-500',
  void: 'bg-neutral-200 text-neutral-500',
  waiting: 'border border-neutral-300 text-neutral-700',
  offered: 'bg-black text-white',
  accepted: 'bg-black text-white',
  expired: 'bg-neutral-200 text-neutral-500',
  published: 'bg-black text-white',
  draft: 'border border-neutral-300 text-neutral-500',
};

export function StatusBadge({ status }: { status: string }) {
  const style = styles[status] ?? 'border border-neutral-300 text-neutral-600';
  return (
    <span className={`inline-flex items-center rounded-sm px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${style}`}>
      {status}
    </span>
  );
}
