import { useMemo } from 'react';
import type { SeatMapEntry } from '../api/types';
import { CheckIcon } from './icons';

interface Props {
  seats: SeatMapEntry[];
  selected: Set<string>;
  onToggle: (seat: SeatMapEntry) => void;
  disabled?: boolean;
  currency: string;
}

const TIER_NAMES = ['Premium', 'Standard', 'Economy'];
const TIER_DOTS = ['bg-amber-500', 'bg-sky-500', 'bg-neutral-400'];

function tierLabel(index: number, total: number): string {
  if (total <= TIER_NAMES.length) return TIER_NAMES[index];
  return `Category ${index + 1}`;
}

function seatClasses(status: SeatMapEntry['status'], isSelected: boolean, disabled: boolean): string {
  if (isSelected) {
    return 'border-brand-600 bg-brand-600 text-white shadow-pop animate-seatPop';
  }
  if (status === 'booked') {
    return 'cursor-not-allowed border-neutral-300 bg-neutral-300 text-neutral-500';
  }
  if (status === 'held') {
    return 'cursor-not-allowed border-amber-300 bg-amber-100 text-amber-700';
  }
  return `border-neutral-300 bg-white text-neutral-600 ${
    disabled
      ? 'cursor-not-allowed opacity-50'
      : 'cursor-pointer hover:-translate-y-0.5 hover:border-brand-500 hover:text-brand-600 hover:shadow-card'
  }`;
}

export function SeatMap({ seats, selected, onToggle, disabled = false, currency }: Props) {
  const { rowLabels, rows, rowTier, tierCount } = useMemo(() => {
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

    // Price tiers, derived purely from the prices already on the seats -
    // highest price reads as "Premium", down to "Economy".
    const distinctPrices = [...new Set(seats.map((s) => Number(s.price)))].sort((a, b) => b - a);
    const priceTier = new Map(distinctPrices.map((price, i) => [price, i]));

    // Each row is assigned the tier of its most common seat price, so a
    // front-row / back-row layout reads as contiguous price bands.
    const rowTier = new Map<string, number>();
    for (const [label, list] of rows) {
      const counts = new Map<number, number>();
      for (const seat of list) {
        const t = priceTier.get(Number(seat.price)) ?? 0;
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      let best = 0;
      let bestCount = -1;
      for (const [t, count] of counts) {
        if (count > bestCount) {
          best = t;
          bestCount = count;
        }
      }
      rowTier.set(label, best);
    }

    return { rowLabels, rows, rowTier, tierCount: distinctPrices.length, tiers: distinctPrices };
  }, [seats]);

  const tierPrice = useMemo(() => {
    const map = new Map<number, number>();
    for (const seat of seats) {
      const t = rowTier.get(seat.rowLabel);
      if (t === undefined) continue;
      if (!map.has(t)) map.set(t, Number(seat.price));
    }
    return map;
  }, [seats, rowTier]);

  let lastTier: number | null = null;

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 sm:p-8">
      {/* Screen / stage indicator */}
      <div className="mb-10 flex flex-col items-center gap-2">
        <div className="h-2 w-3/4 max-w-md rounded-b-full bg-gradient-to-b from-neutral-300 to-neutral-100 [box-shadow:0_8px_20px_-4px_rgba(0,0,0,0.15)]" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.3em] text-neutral-400">Screen / Stage this way</span>
      </div>

      <div className="flex flex-col items-center gap-3 overflow-x-auto pb-2 scrollbar-none">
        {rowLabels.map((rowLabel) => {
          const tier = rowTier.get(rowLabel) ?? 0;
          const showTierHeader = tierCount > 1 && tier !== lastTier;
          lastTier = tier;
          return (
            <div key={rowLabel} className="flex w-full flex-col items-center">
              {showTierHeader && (
                <div className="my-2 flex w-full items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  <span className={`h-2 w-2 rounded-full ${TIER_DOTS[tier] ?? 'bg-neutral-400'}`} />
                  {tierLabel(tier, tierCount)}
                  {tierPrice.has(tier) && <span className="text-neutral-300">· {currency} {tierPrice.get(tier)}</span>}
                  <span className="h-px flex-1 bg-neutral-100" />
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-right text-xs font-semibold text-neutral-400">{rowLabel}</span>
                <div className="flex gap-1.5 sm:gap-2">
                  {rows.get(rowLabel)!.map((seat) => {
                    const isSelected = selected.has(seat.id);
                    const isSelectable = seat.status === 'available' && !disabled;
                    return (
                      <div key={seat.id} className="group/seat relative">
                        <button
                          type="button"
                          disabled={!isSelectable && !isSelected}
                          onClick={() => onToggle(seat)}
                          aria-label={`Row ${rowLabel} seat ${seat.seatNumber}, ${seat.status}, ${currency} ${seat.price}`}
                          className={`focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-t-md rounded-b-[3px] border text-[10px] font-semibold transition-all duration-150 sm:h-8 sm:w-8 ${seatClasses(seat.status, isSelected, disabled)}`}
                        >
                          {isSelected ? <CheckIcon width={13} height={13} /> : seat.seatNumber}
                        </button>
                        <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-ink-950 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover/seat:opacity-100">
                          {rowLabel}
                          {seat.seatNumber} · {currency} {seat.price}
                          {seat.status !== 'available' && !isSelected ? ` · ${seat.status}` : ''}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <span className="w-5 shrink-0 text-left text-xs font-semibold text-neutral-400">{rowLabel}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 border-t border-neutral-100 pt-5 text-xs font-medium text-neutral-500">
        <Legend swatch="border border-neutral-300 bg-white" label="Available" />
        <Legend swatch="bg-brand-600" label="Selected" />
        <Legend swatch="bg-amber-100 border border-amber-300" label="Held" />
        <Legend swatch="bg-neutral-300" label="Booked" />
      </div>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-3.5 w-3.5 rounded-[3px] ${swatch}`} />
      {label}
    </div>
  );
}
