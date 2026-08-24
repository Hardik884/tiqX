import { create } from 'zustand';
import type { UserRole } from '../api/types';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: SessionUser | null;
  setSession: (session: { accessToken: string; refreshToken: string; user: SessionUser | null }) => void;
  /** Applies a role the server just reported - see `syncSessionRole`. */
  setRole: (role: UserRole) => void;
  clearSession: () => void;
}

const STORAGE_KEY = 'tiqx.session';

function loadInitial(): Pick<AuthState, 'accessToken' | 'refreshToken' | 'user'> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return { accessToken: null, refreshToken: null, user: null };
    }
    const parsed = JSON.parse(raw);
    return {
      accessToken: parsed.accessToken ?? null,
      refreshToken: parsed.refreshToken ?? null,
      user: parsed.user ?? null,
    };
  } catch {
    return { accessToken: null, refreshToken: null, user: null };
  }
}

function persist(state: Pick<AuthState, 'accessToken' | 'refreshToken' | 'user'>): void {
  try {
    if (state.accessToken === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } catch {
    // Private browsing / storage disabled - the session simply won't survive a reload.
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  ...loadInitial(),
  setSession: (session) => {
    const user = session.user ?? get().user;
    const next = { accessToken: session.accessToken, refreshToken: session.refreshToken, user };
    persist(next);
    set(next);
  },
  setRole: (role) => {
    const { user, accessToken, refreshToken } = get();
    if (user === null || user.role === role) {
      return;
    }
    const next = { accessToken, refreshToken, user: { ...user, role } };
    persist(next);
    set(next);
  },
  clearSession: () => {
    persist({ accessToken: null, refreshToken: null, user: null });
    set({ accessToken: null, refreshToken: null, user: null });
  },
}));
