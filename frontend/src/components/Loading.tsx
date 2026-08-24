export function Loading({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div className="center-loading flex-col items-center gap-2">
      <div className="spinner" />
      <span className="text-sm text-muted">{label}</span>
    </div>
  );
}
