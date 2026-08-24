import type { ReactNode } from 'react';
import { TicketIcon } from './icons';

/** Split-panel shell for auth pages: a decorative brand panel on desktop, form always on top/right. */
export function AuthShell({ tagline, children }: { tagline: string; children: ReactNode }) {
  return (
    <div className="grid min-h-[calc(100vh-4rem-3.5rem)] grid-cols-1 lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-ink-950 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 20%, rgba(220,47,67,0.35), transparent 40%), radial-gradient(circle at 80% 70%, rgba(220,47,67,0.2), transparent 45%)',
          }}
        />
        <div className="relative flex items-center gap-1.5 text-2xl font-extrabold text-white">
          <span className="font-display">tiq</span>
          <span className="font-display text-brand-500">X</span>
        </div>
        <div className="relative">
          <TicketIcon width={40} height={40} className="text-brand-500" />
          <p className="font-display mt-6 max-w-sm text-2xl font-bold leading-snug text-white">{tagline}</p>
        </div>
        <p className="relative text-xs text-neutral-500">Live seat holds · instant tickets · zero hassle</p>
      </div>

      <div className="flex items-center justify-center bg-neutral-50 px-4 py-12 sm:px-6">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
