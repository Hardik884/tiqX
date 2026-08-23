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
