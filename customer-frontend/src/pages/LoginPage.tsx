import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { login } from '../api/auth';
import { ApiError } from '../api/client';
import { Button } from '../components/Button';
import { InlineNote } from '../components/Feedback';
import { AuthShell } from '../components/AuthShell';
import { useAuthStore } from '../store/auth';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setSession = useAuthStore((s) => s.setSession);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await login(email, password);
      setSession({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        user: result.user,
      });
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell tagline="Sign in to grab your seats before they're gone.">
      <h1 className="font-display text-2xl font-bold text-ink-900">Sign in</h1>
      <p className="mt-1 text-sm text-neutral-500">Access your bookings and tickets.</p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        {error && <InlineNote tone="error">{error}</InlineNote>}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink-800">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-neutral-300 px-3.5 py-2.5 text-sm focus-ring"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink-800">Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-neutral-300 px-3.5 py-2.5 text-sm focus-ring"
          />
        </label>
        <Button type="submit" loading={loading} size="lg" className="w-full">
          Sign in
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-neutral-500">
        Don't have an account?{' '}
        <Link to="/register" className="font-semibold text-brand-600 underline underline-offset-2">
          Create one
        </Link>
      </p>
    </AuthShell>
  );
}
