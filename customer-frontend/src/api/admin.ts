import { apiRequest, buildQuery } from './client';
import type { AdminUser, AdminUsersResult, UserRole } from './types';

/**
 * Account administration. Admin-only on the backend, and the only way an
 * organiser account comes into existence: registration deliberately never
 * accepts a role from the client, so everyone starts as a customer and an
 * admin promotes them from here.
 */
export function listUsers(params: {
  page?: number;
  limit?: number;
  q?: string;
}): Promise<AdminUsersResult> {
  return apiRequest<AdminUsersResult>(`/api/v1/admin/users${buildQuery(params)}`);
}

export function setUserRole(userId: string, role: UserRole): Promise<{ user: AdminUser }> {
  return apiRequest(`/api/v1/admin/users/${userId}/role`, { method: 'PATCH', body: { role } });
}
