import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { login, register } from '../api/auth';
import { ApiError } from '../api/client';
import { Button } from '../components/Button';
import { InlineNote } from '../components/Feedback';
import { AuthShell } from '../components/AuthShell';
import { ChevronRightIcon } from '../components/icons';
import { useAuthStore } from '../store/auth';

export function RegisterPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setSession = useAuthStore((s) => s.setSession);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await register(email, password, name || undefined);
      const result = await login(email, password);
      setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken, user: result.user });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create your account. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell tagline="Create an account and book tickets in seconds.">
      <h1 className="font-display text-2xl font-bold text-ink-900">Create an account</h1>
      <p className="mt-1 text-sm text-neutral-500">Book tickets in seconds.</p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        {error && <InlineNote tone="error">{error}</InlineNote>}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink-800">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border border-neutral-300 px-3.5 py-2.5 text-sm focus-ring"
          />
        </label>
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
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-neutral-300 px-3.5 py-2.5 text-sm focus-ring"
          />
          <span className="text-xs text-neutral-400">At least 12 characters.</span>
        </label>
        <Button type="submit" loading={loading} size="lg" className="w-full">
          Create account
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-neutral-500">
        Already have an account?{' '}
        <Link to="/login" className="font-semibold text-brand-600 underline underline-offset-2">
          Sign in
        </Link>
      </p>

      {/*
        There is no separate organiser or admin sign-up, and deliberately so:
        registration never accepts a role from the client, so everyone starts
        with the account created above and an admin grants the rest. These are
        the way in to each workspace rather than a second form - signed out,
        both send you through sign-in first, and a customer who follows one is
        turned around at the door.
      */}
      <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-4">
        <p className="text-sm font-semibold text-ink-900">Are you an organiser?</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          Organisers and admins use the same tiqX account. Create one above, then an admin turns on your
          access — after that your workspace appears right here.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            to="/organiser"
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-semibold text-ink-800 transition-colors hover:border-ink-900 focus-ring"
          >
            Organiser workspace
            <ChevronRightIcon width={13} height={13} />
          </Link>
          <Link
            to="/admin"
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-semibold text-ink-800 transition-colors hover:border-ink-900 focus-ring"
          >
            Admin workspace
            <ChevronRightIcon width={13} height={13} />
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}
