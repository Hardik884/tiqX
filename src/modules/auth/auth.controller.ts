import type { Request, Response } from 'express';

import { BadRequestError } from '../../errors/app-error.js';
import { requireUser } from '../../middleware/authenticate.js';
import { loginSchema, refreshSchema, registerSchema } from './auth.schema.js';
import { login, logout, refresh, register } from './auth.service.js';
import type { IssuedTokens, PublicUser } from './auth.types.js';

interface FieldError {
  field: string;
  message: string;
}

function toFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]): FieldError[] {
  return issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/** The only user shape that ever reaches a response. No hash, ever. */
function publicUser(user: PublicUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

function tokenPayload(tokens: IssuedTokens): Record<string, unknown> {
  return {
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    expiresIn: tokens.expiresIn,
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
  };
}

export async function registerHandler(req: Request, res: Response): Promise<void> {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    // Strict schema: a client sending `role` lands here rather than having it
    // silently dropped, so an attempt to self-assign privilege is visible.
    throw new BadRequestError('Invalid registration payload', toFieldErrors(parsed.error.issues));
  }

  const user = await register(parsed.data);

  res.status(201).json({ user: publicUser(user) });
}

export async function loginHandler(req: Request, res: Response): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError('Invalid login payload', toFieldErrors(parsed.error.issues));
  }

  const { user, tokens } = await login(parsed.data);

  res.status(200).json({ user: publicUser(user), ...tokenPayload(tokens) });
}

export async function refreshHandler(req: Request, res: Response): Promise<void> {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError('Invalid refresh payload', toFieldErrors(parsed.error.issues));
  }

  const tokens = await refresh(parsed.data.refreshToken);

  res.status(200).json(tokenPayload(tokens));
}

/**
 * Revokes the presented refresh token. Deliberately answers 204 whether or not
 * the token existed, so it is safe to retry and tells an unauthenticated caller
 * nothing about which tokens are real.
 */
export async function logoutHandler(req: Request, res: Response): Promise<void> {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError('Invalid logout payload', toFieldErrors(parsed.error.issues));
  }

  await logout(parsed.data.refreshToken);

  res.status(204).send();
}

/** Echoes the authenticated principal; useful for clients and for testing. */
export function meHandler(req: Request, res: Response): void {
  const user = requireUser(req);
  res.status(200).json({ user: { id: user.id, role: user.role } });
}
