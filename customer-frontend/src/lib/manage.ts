import { ApiError } from '../api/client';
import type { FieldError } from '../api/types';

/**
 * Pulls the per-field messages out of a backend validation error.
 *
 * The API answers a 400 with `error.details` as a list of `{field, message}`
 * (see the controllers' `toFieldErrors`), which is what lets a form point at
 * the input that is actually wrong instead of showing one banner for
 * everything.
 */
export function fieldErrorsOf(error: unknown): FieldError[] {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) {
    return [];
  }
  return error.details.filter(
    (entry): entry is FieldError =>
      typeof entry === 'object' && entry !== null && 'field' in entry && 'message' in entry,
  );
}

export function fieldMessage(errors: readonly FieldError[], field: string): string | undefined {
  return errors.find((entry) => entry.field === field)?.message;
}

export function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * ISO instant -> the `YYYY-MM-DDTHH:mm` a `datetime-local` input wants, in the
 * browser's own timezone. An organiser thinks in local wall-clock time; the API
 * only ever speaks UTC with an offset, and `toIsoInstant` converts back.
 */
export function toLocalInputValue(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The inverse: a local `datetime-local` value as an ISO-8601 instant with offset. */
export function toIsoInstant(localValue: string): string {
  return new Date(localValue).toISOString();
}

/** Money for management screens - the same "CUR 1,234" shape the customer pages use. */
export function formatAmount(currency: string, amount: string): string {
  const value = Number(amount);
  if (Number.isNaN(value)) return `${currency} ${amount}`;
  return `${currency} ${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
