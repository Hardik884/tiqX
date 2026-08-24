import type { SeatEventType } from '../modules/realtime/seat-status-outbox.repository.js';

/**
 * The WebSocket wire contract for real-time seat status.
 *
 * Client -> server: SUBSCRIBE_EVENT / UNSUBSCRIBE_EVENT.
 * Server -> client: the three seat events, plus SUBSCRIBED/UNSUBSCRIBED
 * acknowledgements and ERROR.
 *
 * Every server -> client message a client acts on carries `version: 1` - the
 * event *schema* version, distinct from `seatVersion`, the monotonic counter
 * on the seat itself. Bumping `version` here is how the shape of a message
 * could change later without every connected client needing to guess.
 */

export interface SubscribeEventMessage {
  type: 'SUBSCRIBE_EVENT';
  eventId: string;
}

export interface UnsubscribeEventMessage {
  type: 'UNSUBSCRIBE_EVENT';
  eventId: string;
}

export type ClientMessage = SubscribeEventMessage | UnsubscribeEventMessage;

/**
 * One seat's status transition, exactly as published by the real-time worker
 * and re-broadcast verbatim to every subscribed client.
 *
 * Deliberately narrow, matching `PublicSeatMapEntry` (the REST snapshot this
 * complements): no user id, hold id, or booking id. A seat's status and its
 * version are the whole of what a subscriber is ever told.
 */
export interface SeatStatusMessage {
  type: SeatEventType;
  version: 1;
  eventId: string;
  seatId: string;
  status: 'available' | 'held' | 'booked';
  seatVersion: string;
  occurredAt: string;
}

export interface SubscribedMessage {
  type: 'SUBSCRIBED';
  eventId: string;
}

export interface UnsubscribedMessage {
  type: 'UNSUBSCRIBED';
  eventId: string;
}

export interface ErrorMessage {
  type: 'ERROR';
  code: 'INVALID_MESSAGE' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'SUBSCRIPTION_LIMIT_EXCEEDED';
  message: string;
}

export type ServerMessage =
  | SeatStatusMessage
  | SubscribedMessage
  | UnsubscribedMessage
  | ErrorMessage;
