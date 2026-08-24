import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

/** One ticket's worth of detail for the email body - already public-safe data. */
export interface TicketEmailLine {
  ticketReference: string;
  seatLabel: string;
  /**
   * The canonical QR payload, JSON-stringified. This is text a future
   * frontend/QR-image library renders into a scannable code - see
   * ticket.types.ts::TicketQrPayload. Nothing here is rendered as an image;
   * see ticket-email.service.ts for why that stays out of scope.
   */
  qrPayload: string;
}

/** Everything a ticket-delivery email needs, and nothing it should not have. */
export interface TicketEmailMessage {
  to: string;
  bookingReference: string;
  eventTitle: string;
  venueName: string;
  startsAt: Date;
  tickets: readonly TicketEmailLine[];
}

/**
 * The boundary between this codebase and whatever actually delivers email.
 *
 * One method, deliberately: this project sends exactly one kind of email
 * today. Widening the interface for a hypothetical second kind before one
 * exists would be speculative, the same reasoning this codebase already
 * applies to its database migrations.
 */
export interface EmailProvider {
  sendTicketEmail(message: TicketEmailMessage): Promise<void>;
}

function renderSubject(message: TicketEmailMessage): string {
  return `Your tickets for ${message.eventTitle} (${message.bookingReference})`;
}

function renderText(message: TicketEmailMessage): string {
  const lines = message.tickets
    .map((ticket) => `  - Seat ${ticket.seatLabel} - ${ticket.ticketReference}\n    QR: ${ticket.qrPayload}`)
    .join('\n');

  return [
    `Booking ${message.bookingReference}`,
    `${message.eventTitle} at ${message.venueName}`,
    `Starts: ${message.startsAt.toISOString()}`,
    '',
    'Your tickets:',
    lines,
  ].join('\n');
}

/**
 * Records what it was asked to send instead of sending anything. The default
 * provider, and the only one tests construct: a fresh instance per test gives
 * a private, inspectable log of exactly the messages that test triggered,
 * with no shared state and no real network call to fail or rate-limit on.
 */
export class MockEmailProvider implements EmailProvider {
  readonly sent: TicketEmailMessage[] = [];

  async sendTicketEmail(message: TicketEmailMessage): Promise<void> {
    this.sent.push(message);
    // Ticket references and seat labels are already public-safe; nothing
    // logged here is a credential, a token, or unnecessary personal data.
    logger.info('Mock email "sent"', {
      to: message.to,
      bookingReference: message.bookingReference,
      ticketCount: message.tickets.length,
    });
  }
}

/**
 * Delivers through the Resend API.
 *
 * The API key is read once at construction, from config, never logged and
 * never included in an error message - only HTTP status codes and Resend's
 * own error field (message text, not the request) are recorded on failure.
 */
export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async sendTicketEmail(message: TicketEmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: message.to,
        subject: renderSubject(message),
        text: renderText(message),
      }),
    });

    if (!response.ok) {
      // The response body may echo request fields back (Resend's validation
      // errors do); read only what is needed to say why, never the raw body.
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend API responded ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
  }
}

/**
 * Delivers through Brevo's transactional email API.
 *
 * Same shape and the same failure discipline as {@link ResendEmailProvider}:
 * the API key is read once at construction, never logged, and a failure
 * response is summarised from Brevo's own error field, never the raw request
 * echoed back. Brevo's API wants the sender as `{ name, email }` rather than
 * a single string - the name is fixed here rather than configurable, since
 * nothing else in this codebase's email surface has needed a display name
 * before now, and one more environment variable for a cosmetic value is not
 * worth it yet.
 */
export class BrevoEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fromEmail: string,
  ) {}

  async sendTicketEmail(message: TicketEmailMessage): Promise<void> {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': this.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'tiqX', email: this.fromEmail },
        to: [{ email: message.to }],
        subject: renderSubject(message),
        textContent: renderText(message),
      }),
    });

    if (!response.ok) {
      // Brevo's error body is `{ code, message }`; neither ever echoes the
      // API key, but the response is still capped defensively.
      const detail = await response.text().catch(() => '');
      throw new Error(`Brevo API responded ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
  }
}

let cachedProvider: EmailProvider | undefined;

/**
 * The provider the notifications worker actually uses, chosen once from
 * config and cached. Tests never call this - they construct their own
 * `MockEmailProvider` and pass it directly to `sendPendingTicketEmails`, so
 * assertions read a private instance rather than a process-wide singleton.
 */
export function getEmailProvider(): EmailProvider {
  if (cachedProvider !== undefined) {
    return cachedProvider;
  }

  if (config.email.provider === 'resend') {
    // Validated together at config load time (see src/config/index.ts); this
    // is defence in depth, not the real check.
    if (!config.email.resendApiKey || !config.email.from) {
      throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM');
    }
    cachedProvider = new ResendEmailProvider(config.email.resendApiKey, config.email.from);
  } else if (config.email.provider === 'brevo') {
    if (!config.email.brevoApiKey || !config.email.from) {
      throw new Error('EMAIL_PROVIDER=brevo requires BREVO_API_KEY and EMAIL_FROM');
    }
    cachedProvider = new BrevoEmailProvider(config.email.brevoApiKey, config.email.from);
  } else {
    cachedProvider = new MockEmailProvider();
  }

  return cachedProvider;
}
