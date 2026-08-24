import { apiRequest } from './client';
import type { AuthResponse } from './types';

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
