export interface PendingTicketEmailRow {
  id: string;
  bookingId: string;
  attempts: number;
}

/** Everything needed to compose one booking's ticket email, read at send time. */
export interface TicketEmailContext {
  to: string;
  bookingReference: string;
  eventTitle: string;
  venueName: string;
  startsAt: Date;
  tickets: {
    ticketReference: string;
    seatLabel: string;
    qrPayload: { v: 1; ticketId: string; ticketReference: string };
  }[];
}

export interface SendPendingTicketEmailsResult {
  claimed: number;
  sent: number;
  failed: number;
}
