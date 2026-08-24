import { useEffect, useState } from 'react';

function format(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** A live countdown to `expiresAt`. Calls `onExpire` once, the instant it hits zero. */
export function Countdown({ expiresAt, onExpire }: { expiresAt: string; onExpire?: () => void }) {
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
  const urgent = remaining < 60_000;

  return (
    <span className={`font-mono text-sm tabular-nums ${urgent ? 'font-semibold text-red-700' : 'text-black'}`}>
      {format(remaining)}
    </span>
  );
}
