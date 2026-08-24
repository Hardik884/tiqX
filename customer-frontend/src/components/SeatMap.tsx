import type { SeatMapEntry } from '../api/types';

interface Props {
  seats: SeatMapEntry[];
  selected: Set<string>;
  onToggle: (seat: SeatMapEntry) => void;
  disabled?: boolean;
}

function seatClass(status: SeatMapEntry['status'], isSelected: boolean, disabled: boolean): string {
  if (isSelected) {
    return 'bg-black text-white border-black';
  }
  if (status === 'booked') {
    return 'bg-neutral-800 text-neutral-500 border-neutral-800 cursor-not-allowed';
  }
  if (status === 'held') {
    return 'bg-neutral-200 text-neutral-400 border-neutral-200 cursor-not-allowed';
  }
  return `bg-white text-neutral-700 border-neutral-300 ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-black hover:text-black cursor-pointer'}`;
}

export function SeatMap({ seats, selected, onToggle, disabled = false }: Props) {
  const rows = new Map<string, SeatMapEntry[]>();
  for (const seat of seats) {
    const list = rows.get(seat.rowLabel) ?? [];
    list.push(seat);
    rows.set(seat.rowLabel, list);
  }
  for (const list of rows.values()) {
    list.sort((a, b) => a.seatNumber - b.seatNumber);
  }
  const rowLabels = [...rows.keys()].sort();

  return (
    <div className="rounded border border-neutral-200 bg-white p-4 sm:p-8">
      <div className="mb-8 flex flex-col items-center gap-1">
        <div className="h-1.5 w-2/3 rounded-full bg-neutral-900" />
        <span className="text-[11px] uppercase tracking-[0.2em] text-neutral-400">Screen / Stage</span>
      </div>

      <div className="flex flex-col items-center gap-2 overflow-x-auto pb-2">
        {rowLabels.map((rowLabel) => (
          <div key={rowLabel} className="flex items-center gap-2">
            <span className="w-5 shrink-0 text-right text-xs font-medium text-neutral-400">{rowLabel}</span>
            <div className="flex gap-1.5">
              {rows.get(rowLabel)!.map((seat) => {
                const isSelected = selected.has(seat.id);
                const isSelectable = seat.status === 'available' && !disabled;
                return (
                  <button
                    key={seat.id}
                    type="button"
                    disabled={!isSelectable && !isSelected}
                    onClick={() => onToggle(seat)}
                    title={`${rowLabel}${seat.seatNumber} · ${seat.status} · ${seat.price}`}
                    className={`focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border text-[10px] font-medium transition-colors sm:h-8 sm:w-8 ${seatClass(seat.status, isSelected, disabled)}`}
                  >
                    {seat.seatNumber}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 border-t border-neutral-200 pt-4 text-xs text-neutral-500">
        <Legend swatch="bg-white border border-neutral-300" label="Available" />
        <Legend swatch="bg-black" label="Selected" />
        <Legend swatch="bg-neutral-200" label="Held" />
        <Legend swatch="bg-neutral-800" label="Booked" />
      </div>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-3 w-3 rounded-sm ${swatch}`} />
      {label}
    </div>
  );
}
