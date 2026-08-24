import { create } from 'zustand';
import type { PublicEventView, SeatMapEntry } from '../api/types';

interface ActiveHold {
  holdId: string;
  eventId: string;
  expiresAt: string;
  seats: SeatMapEntry[];
  event: PublicEventView;
}

interface BookingFlowState {
  hold: ActiveHold | null;
  setHold: (hold: ActiveHold) => void;
  clearHold: () => void;
}

/**
 * In-memory only, deliberately: a hold is short-lived (minutes) and scoped to
 * this tab's checkout flow. Losing it on a hard refresh is the correct
 * behaviour - the countdown and seat selection should not silently survive a
 * reload as if nothing happened, since the hold may have already expired
 * server-side by then anyway.
 */
export const useBookingFlow = create<BookingFlowState>((set) => ({
  hold: null,
  setHold: (hold) => set({ hold }),
  clearHold: () => set({ hold: null }),
}));
