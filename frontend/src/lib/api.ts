import type { ApiErrorBody, FieldError } from './types';

const API_BASE = '/api/v1';

const ACCESS_TOKEN_KEY = 'tiqx.accessToken';
const REFRESH_TOKEN_KEY = 'tiqx.refreshToken';

export class ApiError extends Error {
  status: number;
  code: string;
  fieldErrors: FieldError[] | undefined;

  constructor(status: number, code: string, message: string, fieldErrors?: FieldError[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Exchanges the stored refresh token for a new pair. De-duplicated behind a
 * single in-flight promise so several requests failing with 401 at once
 * trigger one refresh call, not a stampede of them.
 */
async function tryRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (refreshToken === null) {
    return false;
  }

  if (refreshInFlight !== null) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) {
        return false;
      }
      const body = (await response.json()) as { accessToken: string; refreshToken: string };
      setTokens(body.accessToken, body.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Skip the automatic 401 -> refresh -> retry cycle (used by the refresh call itself and login/logout). */
  skipAuthRetry?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.pathname + url.search;
}

async function parseErrorBody(response: Response): Promise<{ code: string; message: string; fieldErrors?: FieldError[] }> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    const fieldErrors = Array.isArray(body.error.details) ? (body.error.details as FieldError[]) : undefined;
    return { code: body.error.code, message: body.error.message, fieldErrors };
  } catch {
    return { code: 'UNKNOWN', message: response.statusText || 'Request failed' };
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const accessToken = getAccessToken();
  const headers: Record<string, string> = {};
  if (accessToken !== null) {
    headers.authorization = `Bearer ${accessToken}`;
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 401 && !options.skipAuthRetry && getRefreshToken() !== null) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return request<T>(path, { ...options, skipAuthRetry: true });
    }
    clearTokens();
    window.dispatchEvent(new CustomEvent('tiqx:session-expired'));
    const err = await parseErrorBody(response);
    throw new ApiError(401, err.code, 'Your session has expired. Please sign in again.');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  if (!response.ok) {
    const err = await parseErrorBody(response);
    throw new ApiError(response.status, err.code, err.message, err.fieldErrors);
  }

  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
