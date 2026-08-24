import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const CONTROL =
  'w-full rounded-md border bg-white px-3.5 py-2.5 text-sm text-ink-900 transition-colors focus-ring placeholder:text-neutral-400 disabled:bg-neutral-50 disabled:text-neutral-400';

function controlClass(error?: string): string {
  return `${CONTROL} ${error ? 'border-red-300' : 'border-neutral-300 hover:border-neutral-400'}`;
}

/** Label + control + hint/error, so every management form lines up the same way. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5" htmlFor={htmlFor}>
      <span className="text-sm font-medium text-ink-800">{label}</span>
      {children}
      {error ? (
        <span className="text-xs font-medium text-red-600">{error}</span>
      ) : hint ? (
        <span className="text-xs text-neutral-500">{hint}</span>
      ) : null}
    </label>
  );
}

export function TextInput({
  error,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { error?: string }) {
  return <input className={`${controlClass(error)} ${className}`} {...rest} />;
}

export function SelectInput({
  error,
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { error?: string }) {
  return (
    <select className={`${controlClass(error)} ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function TextArea({
  error,
  className = '',
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { error?: string }) {
  return <textarea className={`${controlClass(error)} ${className}`} rows={3} {...rest} />;
}

/** Two fields side by side on desktop, stacked on mobile. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>;
}

export function FormCard({ children, onSubmit }: { children: ReactNode; onSubmit: (e: React.FormEvent) => void }) {
  return (
    <form
      onSubmit={onSubmit}
      className="flex max-w-3xl flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5 shadow-card sm:p-6"
    >
      {children}
    </form>
  );
}
