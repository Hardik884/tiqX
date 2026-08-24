import { useEffect, useRef, useState } from 'react';
import { getSeatMap } from '../api/events';
import type { SeatMapEntry } from '../api/types';
import { seatSocket, type SeatStatusMessage } from './seatSocket';

interface State {
  seats: SeatMapEntry[];
  loading: boolean;
  error: string | null;
  connected: boolean;
}

/**
 * The seat map for one event: the REST snapshot, kept live by the WebSocket
 * feed. Each seat's `seatVersion` (absent from the REST payload, so treated as
 * 0 until a live message arrives) guards against a message that arrived out
 * of order or duplicated by a reconnect - only a strictly newer version is
 * ever applied, so a stale SEAT_HELD replayed after a SEAT_BOOKED can never
 * un-book a seat on screen.
 */
export function useSeatMap(eventId: string | undefined) {
  const [state, setState] = useState<State>({ seats: [], loading: true, error: null, connected: false });
  const versions = useRef(new Map<string, bigint>());

  async function load() {
    if (eventId === undefined) {
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const { seats } = await getSeatMap(eventId);
      versions.current = new Map(seats.map((s) => [s.id, 0n]));
      setState((s) => ({ ...s, seats, loading: false, error: null }));
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : 'Failed to load seats' }));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(() => {
    if (eventId === undefined) {
      return;
    }

    seatSocket.subscribe(eventId);
    const offConn = seatSocket.onConnectionChange((connected) => setState((s) => ({ ...s, connected })));
    const offMsg = seatSocket.onMessage((message: SeatStatusMessage) => {
      if (message.eventId !== eventId) {
        return;
      }
      const incomingVersion = BigInt(message.seatVersion);
      const known = versions.current.get(message.seatId) ?? -1n;
      if (incomingVersion <= known) {
        return; // stale or duplicate - discard
      }
      versions.current.set(message.seatId, incomingVersion);

      setState((s) => ({
        ...s,
        seats: s.seats.map((seat) => (seat.id === message.seatId ? { ...seat, status: message.status } : seat)),
      }));
    });

    return () => {
      seatSocket.unsubscribe(eventId);
      offConn();
      offMsg();
    };
  }, [eventId]);

  return { ...state, refetch: load };
}
