import { Router } from 'express';

import { requireAuth } from '../../middleware/authenticate.js';
import {
  loginHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerHandler,
} from './auth.controller.js';

export const authRouter = Router();

// Public: these are how a caller obtains an identity in the first place.
authRouter.post('/register', registerHandler);
authRouter.post('/login', loginHandler);
// Authenticated by the refresh token in the body, not by a bearer token: the
// whole point is to be usable once the access token has expired.
authRouter.post('/refresh', refreshHandler);
authRouter.post('/logout', logoutHandler);

authRouter.get('/me', requireAuth, meHandler);
