/**
 * The roles the database already recognises - see the `users_role_check`
 * constraint in the initial migration. This list mirrors it rather than
 * extending it: authorisation must not be able to name a role the database
 * would reject.
 */
export const USER_ROLES = ['customer', 'organiser', 'admin'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** Registration never accepts a role from the client; everyone starts here. */
export const DEFAULT_USER_ROLE: UserRole = 'customer';

/**
 * An account as the admin user list shows it. No password hash, and no
 * refresh-token state: this view exists to answer "who is this, and what may
 * they do?", nothing more.
 */
export interface AdminUserView {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: Date;
}

export interface ListUsersResult {
  users: AdminUserView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
