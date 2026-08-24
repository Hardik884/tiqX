import { apiRequest } from './client';
import type { AuthResponse, UserRole } from './types';

export function login(email: string, password: string): Promise<AuthResponse> {
  return apiRequest<AuthResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password },
    anonymous: true,
  });
}

export function register(email: string, password: string, name?: string): Promise<{ user: unknown }> {
  return apiRequest('/api/v1/auth/register', {
    method: 'POST',
    body: { email, password, name },
    anonymous: true,
  });
}

export function logout(refreshToken: string): Promise<void> {
  return apiRequest('/api/v1/auth/logout', {
    method: 'POST',
    body: { refreshToken },
    anonymous: true,
  });
}

/**
 * Who the API currently thinks the caller is.
 *
 * Only the id and the role - and the role is the point: it is re-read from the
 * database on every request server-side, so an account promoted to organiser
 * (or demoted) while signed in has a stale role sitting in this browser's
 * stored session. Calling this on start-up is what makes the change show up in
 * the navigation without a sign-out; it never grants anything, since the API
 * would refuse a call the real role does not allow regardless.
 */
export function getMe(): Promise<{ user: { id: string; role: UserRole } }> {
  return apiRequest<{ user: { id: string; role: UserRole } }>('/api/v1/auth/me');
}
