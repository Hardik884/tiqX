import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Argon2id at the OWASP-recommended baseline: 19 MiB of memory, 2 passes, 1
 * lane.
 *
 * Argon2id rather than a general-purpose hash because SHA-256 and friends are
 * built to be fast, which is precisely wrong here - speed is the attacker's
 * budget. The memory cost is the part that matters: it is what makes GPU and
 * ASIC cracking expensive rather than merely tedious.
 *
 * The parameters are recorded inside the digest string, so raising them later
 * does not invalidate existing hashes; old passwords keep verifying under the
 * settings they were created with.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A valid Argon2id digest of a value nobody can present, used to spend the same
 * work on a login for an unknown email as on a real one. Without it, "no such
 * user" would return noticeably faster than "wrong password" and the response
 * time alone would reveal which addresses are registered.
 *
 * Computed once, lazily, so the cost is paid at first use rather than at import.
 */
let decoyDigest: Promise<string> | undefined;

function getDecoyDigest(): Promise<string> {
  decoyDigest ??= hash('a password that is never anyone\'s', ARGON2_OPTIONS);
  return decoyDigest;
}

/** Salting is handled by the library; every call yields a different digest. */
export async function hashPassword(plainPassword: string): Promise<string> {
  return hash(plainPassword, ARGON2_OPTIONS);
}

/**
 * Verifies a password against a stored digest using the library's own
 * comparison, which reads the parameters out of the digest and compares in
 * constant time. A malformed or truncated digest is a failed verification, not
 * an exception to leak upwards.
 */
export async function verifyPassword(digest: string, plainPassword: string): Promise<boolean> {
  try {
    return await verify(digest, plainPassword);
  } catch {
    return false;
  }
}

/**
 * Burns roughly one verification's worth of work and always fails. Call it on
 * the "user not found" branch of login so that branch costs what the real one
 * costs.
 */
export async function verifyPasswordAgainstDecoy(plainPassword: string): Promise<false> {
  await verifyPassword(await getDecoyDigest(), plainPassword);
  return false;
}
