import { useEffect, useState } from 'react';
import { ClockIcon } from './icons';

function format(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

interface Props {
  expiresAt: string;
  onExpire?: () => void;
  /** `prominent` renders a large pill with a clock icon, for hold/offer countdowns that must grab attention. */
  variant?: 'inline' | 'prominent';
}

/** A live countdown to `expiresAt`. Calls `onExpire` once, the instant it hits zero. */
export function Countdown({ expiresAt, onExpire, variant = 'inline' }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const target = new Date(expiresAt).getTime();

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (now >= target) {
      onExpire?.();
    }
  }, [now, target, onExpire]);

  const remaining = target - now;
  const critical = remaining < 60_000;
  const urgent = remaining < 120_000;

  if (variant === 'prominent') {
    return (
      <span
        className={`inline-flex items-center gap-2 rounded-full px-4 py-2 font-mono text-lg font-bold tabular-nums transition-colors ${
          critical
            ? 'animate-glowPulse bg-brand-600 text-white'
            : urgent
              ? 'bg-amber-100 text-amber-800'
              : 'bg-ink-900 text-white'
        }`}
      >
        <ClockIcon width={18} height={18} />
        {format(remaining)}
      </span>
    );
  }

  return (
    <span className={`font-mono text-sm font-semibold tabular-nums ${critical ? 'text-brand-600' : 'text-ink-900'}`}>
      {format(remaining)}
    </span>
  );
}
