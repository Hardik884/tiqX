import { useEffect } from 'react';
import { Button } from '../Button';

/**
 * A modal for the two actions that cannot be undone from the UI: publishing an
 * event (it becomes visible to customers and can no longer be deleted) and
 * deleting a draft. Escape and a click on the backdrop both cancel, so the
 * safe way out is always the easy one.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = 'Confirm',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4 backdrop-blur-sm"
      role="presentation"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md animate-fadeUp rounded-lg border border-neutral-200 bg-white p-6 shadow-card-hover"
      >
        <h2 id="confirm-title" className="font-display text-lg font-bold text-ink-900">
          {title}
        </h2>
        <p className="mt-2 text-sm text-neutral-500">{description}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'dark'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
