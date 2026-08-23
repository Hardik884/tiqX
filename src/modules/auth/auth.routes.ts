import { Router } from 'express';

import { config } from '../../config/index.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import {
  loginHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerHandler,
} from './auth.controller.js';

export const authRouter = Router();

/**
 * Rate limiting runs before the handler, and before any authentication, because
 * these are the endpoints a caller uses to *become* authenticated - there is no
 * principal to key on yet, and the work being protected (an Argon2 verification,
 * a token rotation) happens inside the handler.
 *
 * Only these three are limited for now. They are the credential surface: the
 * endpoints where guessing pays off, where each attempt costs the server real
 * CPU, and where abuse is cheap for the attacker.
 *
 * Limits and windows come from config so a deployment can tighten them without
 * a release; the defaults are in .env.example with the reasoning.
 */
authRouter.post('/register', rateLimit(config.rateLimit.register, 'ip'), registerHandler);
authRouter.post('/login', rateLimit(config.rateLimit.login, 'email-and-ip'), loginHandler);
// Authenticated by the refresh token in the body, not by a bearer token: the
// whole point is to be usable once the access token has expired.
authRouter.post('/refresh', rateLimit(config.rateLimit.refresh, 'ip'), refreshHandler);

// Logout is deliberately unlimited: it must always be possible to end a
// session, and it neither guesses a credential nor costs anything to serve.
authRouter.post('/logout', logoutHandler);

authRouter.get('/me', requireAuth, meHandler);
