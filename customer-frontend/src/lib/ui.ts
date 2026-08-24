import type { EventCategory } from '../api/types';

/** Shared max-width/padding for boxed page sections, so full-bleed heroes and bands can sit outside it. */
export const CONTAINER = 'mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8';

const CATEGORY_LABELS: Record<EventCategory, string> = {
  music: 'Music',
  comedy: 'Comedy',
  sports: 'Sports',
  theatre: 'Theatre',
  movies: 'Movies',
  other: 'Other',
};

export function categoryLabel(category: EventCategory | string): string {
  return CATEGORY_LABELS[category as EventCategory] ?? category;
}

/** Deterministic accent (matched header-band + badge) per category, so cards stay visually distinct without images. */
const CATEGORY_STYLES: Record<EventCategory, { band: string; text: string; dot: string }> = {
  music: { band: 'from-violet-600 to-fuchsia-700', text: 'text-violet-700', dot: 'bg-violet-600' },
  comedy: { band: 'from-amber-500 to-orange-600', text: 'text-amber-700', dot: 'bg-amber-500' },
  sports: { band: 'from-emerald-600 to-teal-700', text: 'text-emerald-700', dot: 'bg-emerald-600' },
  theatre: { band: 'from-sky-600 to-indigo-700', text: 'text-sky-700', dot: 'bg-sky-600' },
  movies: { band: 'from-rose-600 to-red-700', text: 'text-rose-700', dot: 'bg-rose-600' },
  other: { band: 'from-ink-700 to-ink-900', text: 'text-ink-700', dot: 'bg-ink-700' },
};

export function categoryStyle(category: EventCategory | string) {
  return CATEGORY_STYLES[category as EventCategory] ?? CATEGORY_STYLES.other;
}

export function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatMoney(currency: string, amount: string | number): string {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  return `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
