import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

import { config } from '../../config/index.js';
import { USER_ROLES } from '../users/user.types.js';
import type { UserRole } from '../users/user.types.js';
import type { AuthenticatedUser } from './auth.types.js';

const signingKey = new TextEncoder().encode(config.auth.jwtSecret);

const JWT_ALGORITHM = 'HS256';

export interface SignedAccessToken {
  token: string;
  expiresIn: number;
}

/**
 * Mints a short-lived access token.
 *
 * The claim set is deliberately minimal - subject, role, and the registered
 * claims. A JWT is signed, not encrypted: whatever goes in is readable by
 * anyone holding the token, so email and other user detail stay out. `jti`
 * gives each token an identity that can be correlated in logs without ever
 * logging the token itself.
 *
 * `iss` and `aud` are always set, and always checked on the way back in, so a
 * token minted for another service or audience cannot be replayed here even if
 * it was signed with the same key.
 */
export async function signAccessToken(user: AuthenticatedUser): Promise<SignedAccessToken> {
  const expiresIn = config.auth.accessTokenTtlSeconds;

  const token = await new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setSubject(user.id)
    .setIssuer(config.auth.jwtIssuer)
    .setAudience(config.auth.jwtAudience)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .setJti(randomBytes(16).toString('hex'))
    .sign(signingKey);

  return { token, expiresIn };
}

function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Verifies a bearer token and returns the principal it names, or null if the
 * token is not one this server issued and still honours.
 *
 * `jwtVerify` checks the signature, `exp`, `nbf`, the issuer and the audience,
 * and - importantly - is pinned to a single algorithm. Without that pin a token
 * could arrive asking to be verified as `none`, or an RS256 public key could be
 * replayed as an HMAC secret; both are classic JWT forgeries that only work
 * when the verifier accepts the attacker's choice of algorithm.
 *
 * Every failure returns null rather than throwing: the caller answers all of
 * them with the same 401, and distinguishing "expired" from "bad signature" in
 * the response would only help someone probing.
 */
export async function verifyAccessToken(token: string): Promise<AuthenticatedUser | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey, {
      algorithms: [JWT_ALGORITHM],
      issuer: config.auth.jwtIssuer,
      audience: config.auth.jwtAudience,
    });

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      return null;
    }
    if (!isUserRole(payload.role)) {
      return null;
    }

    return { id: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}

/**
 * A refresh token: 32 random bytes, base64url encoded.
 *
 * Random rather than a JWT. A self-describing token would be honoured on its
 * contents alone, which is exactly what makes revocation impossible; this one
 * means nothing except as a lookup into a row the server controls, so revoking
 * that row revokes the token.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The digest stored for a refresh token.
 *
 * Plain SHA-256, not Argon2: the input is 256 bits of uniform randomness, so
 * there is no dictionary to grind through and no advantage in a slow KDF. What
 * matters is that the stored value cannot be presented as a credential, and
 * that the lookup stays a single indexed equality.
 */
export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests of equal length. */
export function digestsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
