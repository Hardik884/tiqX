import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, clearTokens, getAccessToken, setTokens } from './api';
import type { PublicUser } from './types';

const PROFILE_KEY = 'tiqx.profile';

interface LoginResponse {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

interface MeResponse {
  user: { id: string; role: PublicUser['role'] };
}

interface AuthState {
  user: PublicUser | null;
  status: 'loading' | 'authenticated' | 'anonymous';
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadCachedProfile(): PublicUser | null {
  const raw = localStorage.getItem(PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PublicUser;
  } catch {
    return null;
  }
}

function cacheProfile(user: PublicUser): void {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(user));
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<AuthState>({ user: null, status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function bootstrap(): Promise<void> {
      if (getAccessToken() === null) {
        if (!cancelled) setState({ user: null, status: 'anonymous' });
        return;
      }

      const cached = loadCachedProfile();

      // The role that matters is whatever the backend says right now, not
      // whatever was cached at login - a demotion or promotion since then
      // must take effect immediately, not just on the next login.
      try {
        const me = await api.get<MeResponse>('/auth/me');
        if (cancelled) return;
        const user: PublicUser =
          cached && cached.id === me.user.id
            ? { ...cached, role: me.user.role }
            : { id: me.user.id, role: me.user.role, email: '', name: '', createdAt: '' };
        cacheProfile(user);
        setState({ user, status: 'authenticated' });
      } catch {
        if (cancelled) return;
        clearTokens();
        localStorage.removeItem(PROFILE_KEY);
        setState({ user: null, status: 'anonymous' });
      }
    }

    void bootstrap();

    function onSessionExpired(): void {
      localStorage.removeItem(PROFILE_KEY);
      setState({ user: null, status: 'anonymous' });
    }
    window.addEventListener('tiqx:session-expired', onSessionExpired);

    return () => {
      cancelled = true;
      window.removeEventListener('tiqx:session-expired', onSessionExpired);
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.post<LoginResponse>('/auth/login', { email, password });
    setTokens(result.accessToken, result.refreshToken);
    cacheProfile(result.user);
    setState({ user: result.user, status: 'authenticated' });
  }, []);

  const logout = useCallback(() => {
    clearTokens();
    localStorage.removeItem(PROFILE_KEY);
    setState({ user: null, status: 'anonymous' });
  }, []);

  const value = useMemo(() => ({ ...state, login, logout }), [state, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
