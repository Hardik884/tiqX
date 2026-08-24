export type SeatEventType = 'SEAT_HELD' | 'SEAT_RELEASED' | 'SEAT_BOOKED';

export interface SeatStatusMessage {
  type: SeatEventType;
  version: 1;
  eventId: string;
  seatId: string;
  status: 'available' | 'held' | 'booked';
  seatVersion: string;
  occurredAt: string;
}

type Listener = (message: SeatStatusMessage) => void;

/**
 * One shared WebSocket connection to /ws for the whole app, matching the
 * server's connection-scoped subscription model. Reconnects with backoff on
 * drop and re-subscribes to whatever the caller last asked for, so a caller
 * component never has to think about the socket's own lifecycle - only about
 * which event it currently cares about.
 */
class SeatSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subscribed = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private connectionListeners = new Set<(connected: boolean) => void>();

  private url(): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }

  connect(): void {
    if (this.ws !== null && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const ws = new WebSocket(this.url());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.notifyConnection(true);
      for (const eventId of this.subscribed) {
        this.send({ type: 'SUBSCRIBE_EVENT', eventId });
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SeatStatusMessage | { type: string };
        if (data.type === 'SEAT_HELD' || data.type === 'SEAT_RELEASED' || data.type === 'SEAT_BOOKED') {
          for (const listener of this.listeners) {
            listener(data as SeatStatusMessage);
          }
        }
      } catch {
        // Malformed frame - ignore rather than crash the connection.
      }
    };

    ws.onclose = () => {
      this.notifyConnection(false);
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 15000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(message: { type: string; eventId: string }): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  subscribe(eventId: string): void {
    this.subscribed.add(eventId);
    this.connect();
    this.send({ type: 'SUBSCRIBE_EVENT', eventId });
  }

  unsubscribe(eventId: string): void {
    this.subscribed.delete(eventId);
    this.send({ type: 'UNSUBSCRIBE_EVENT', eventId });
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    if (this.ws !== null) {
      listener(this.ws.readyState === WebSocket.OPEN);
    }
    return () => this.connectionListeners.delete(listener);
  }

  private notifyConnection(connected: boolean): void {
    for (const listener of this.connectionListeners) {
      listener(connected);
    }
  }
}

export const seatSocket = new SeatSocket();
