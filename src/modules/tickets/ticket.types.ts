import type { UserRole } from '../users/user.types.js';

export const TICKET_STATUSES = ['issued', 'used', 'void'] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * A ticket. Ownership is not a field here on purpose: a ticket belongs to a
 * booking, and a booking belongs to a user - see ticket.repository.ts for why
 * `user_id` is deliberately not duplicated onto this table.
 */
export interface TicketRecord {
  id: string;
  bookingId: string;
  bookingSeatId: string;
  ticketReference: string;
  status: TicketStatus;
  issuedAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueTicketsInput {
  /** Always the authenticated principal; never a value from the request body. */
  userId: string;
  userRole: UserRole;
  bookingId: string;
}

export interface IssueTicketsResult {
  bookingId: string;
  eventId: string;
  tickets: TicketRecord[];
}

export interface VerifyTicketInput {
  ticketId: string;
  /** Always the authenticated principal; never a value from the request body. */
  userId: string;
  userRole: UserRole;
}

export interface VerifyTicketResult {
  ticket: TicketRecord;
  eventId: string;
  showSeatId: string;
}

/**
 * The canonical shape a future QR code encodes. Identifies the ticket; it
 * does not authorise anything by itself - see ticket.service.ts.
 */
export interface TicketQrPayload {
  v: 1;
  ticketId: string;
  ticketReference: string;
}
