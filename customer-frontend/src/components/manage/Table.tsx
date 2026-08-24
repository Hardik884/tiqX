import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react';

/**
 * Table primitives rather than a configurable DataTable: every management
 * table here has a different cell (a badge, a two-line customer, a row of seat
 * chips), and a column config would have ended up as a prop for each of them.
 *
 * The wrapper scrolls horizontally on its own so a wide table never makes the
 * page scroll sideways on a phone.
 */
export function TableCard({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">{children}</table>
      </div>
    </div>
  );
}

export function Th({ className = '', children, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={`border-b border-neutral-200 bg-neutral-50 px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-neutral-500 ${className}`}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({ className = '', children, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`border-b border-neutral-100 px-4 py-3 align-middle text-ink-800 ${className}`} {...rest}>
      {children}
    </td>
  );
}

export function ClickableRow({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <tr
      onClick={onClick}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="cursor-pointer transition-colors hover:bg-neutral-50 focus-ring"
    >
      {children}
    </tr>
  );
}
