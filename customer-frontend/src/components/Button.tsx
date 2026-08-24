import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark';
type Size = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-all duration-150 focus-ring disabled:cursor-not-allowed disabled:opacity-40 active:scale-[0.98]';

const sizes: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2.5 text-sm',
  lg: 'px-6 py-3.5 text-[15px]',
};

const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white shadow-card hover:bg-brand-700 hover:shadow-card-hover',
  dark: 'bg-ink-900 text-white shadow-card hover:bg-ink-800 hover:shadow-card-hover',
  secondary: 'border border-neutral-300 bg-white text-ink-900 hover:border-ink-900',
  ghost: 'text-ink-700 hover:bg-neutral-100',
  danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className = '',
  children,
  disabled,
  ...rest
}: Props) {
  return (
    <button
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}
