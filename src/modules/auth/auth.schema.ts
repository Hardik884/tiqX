import { z } from 'zod';

/**
 * Long enough to resist offline guessing, capped so a multi-megabyte "password"
 * cannot be used to make the server burn Argon2 memory on demand. Length is the
 * only rule: composition requirements push people towards predictable
 * substitutions without adding real entropy.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Emails are lowercased and trimmed at the edge so storage, lookup and the
 * existing lower(email) unique index all agree on one form.
 */
const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email('must be a valid email address')
  .transform((value) => value.toLowerCase());

const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH);

/**
 * `.strict()` throughout: an unknown field is an error, not something to ignore.
 * That is what turns a client still sending `role` - or a stale `userId` - into
 * a visible 400 instead of a silently dropped field that looks like it worked.
 */
export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    // Optional because `users.name` is NOT NULL in the existing schema while
    // the registration contract is email + password. Defaulted server-side
    // rather than by relaxing a column that other code relies on.
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  })
  .strict();

export const refreshSchema = z
  .object({
    refreshToken: z.string().min(1).max(512),
  })
  .strict();

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;
