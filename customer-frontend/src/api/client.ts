import { useAuthStore } from '../store/auth';
import type { ApiErrorBody } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** A fresh key for every distinct booking action - never reused across retries of a *different* click. */
export function newIdempotencyKey(): string {
  return randomId();
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  /** Skips the auth header/refresh dance - only auth endpoints need this. */
  anonymous?: boolean;
}

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const { refreshToken, setSession, clearSession } = useAuthStore.getState();
  if (refreshToken === null) {
    return null;
  }

  if (refreshPromise === null) {
    refreshPromise = (async () => {
      try {
        const res = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) {
          clearSession();
          return null;
        }
        const data = await res.json();
        setSession({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          user: useAuthStore.getState().user,
        });
        return data.accessToken as string;
      } catch {
        clearSession();
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  }

  return refreshPromise;
}

async function parseErrorBody(res: Response): Promise<ApiErrorBody> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function errorFromBody(status: number, body: ApiErrorBody): ApiError {
  const code = body.error?.code ?? 'UNKNOWN_ERROR';
  const message = body.error?.message ?? 'Something went wrong. Please try again.';
  return new ApiError(status, code, message, body.error?.details);
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, idempotencyKey, anonymous = false } = options;

  const doFetch = async (): Promise<Response> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (idempotencyKey !== undefined) {
      headers['idempotency-key'] = idempotencyKey;
    }
    if (!anonymous) {
      const token = useAuthStore.getState().accessToken;
      if (token !== null) {
        headers.authorization = `Bearer ${token}`;
      }
    }
    return fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  let res = await doFetch();

  if (res.status === 401 && !anonymous && useAuthStore.getState().refreshToken !== null) {
    const newToken = await refreshAccessToken();
    if (newToken !== null) {
      res = await doFetch();
    }
  }

  if (!res.ok) {
    const errBody = await parseErrorBody(res);
    throw errorFromBody(res.status, errBody);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

export function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}
