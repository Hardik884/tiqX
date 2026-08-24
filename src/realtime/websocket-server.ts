import type { Server } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import { config } from '../config/index.js';
import type { AuthenticatedUser } from '../modules/auth/auth.types.js';
import { logger } from '../utils/logger.js';
import { canSubscribeToEvent } from './event-visibility.js';
import { clientMessageSchema } from './message-schema.js';
import type { ErrorMessage, ServerMessage, SubscribedMessage, UnsubscribedMessage } from './message-types.js';
import {
  configureBackpressureLimit,
  deregisterConnection,
  isSubscribed,
  registerConnection,
  startSubscriptionRegistry,
  stopSubscriptionRegistry,
  subscribeConnection,
  subscriptionCount,
  unsubscribeConnection,
} from './subscription-registry.js';
import { authenticateUpgrade } from './ws-auth.js';

/**
 * Real-time seat status over WebSocket - the push side of the seat map. The
 * REST endpoint (`GET /api/v1/events/:eventId/seats`) remains the
 * authoritative snapshot; this only delivers what changes after a client has
 * fetched one. See the module's top-level report for the full consistency
 * model and the reconnect race window.
 *
 * PostgreSQL decides seat state, a trigger turns every change into a durable
 * `seat_status_outbox` row in the same transaction, the real-time worker
 * publishes each one to Redis, and this module is the last hop: one Redis
 * subscription per event this process actually has a client for, fanned out
 * to whichever of those clients are still connected and not too far behind to
 * keep sending to - see subscription-registry.ts for the backpressure policy.
 *
 * Nothing here ever touches PostgreSQL or blocks on Redis while a customer's
 * hold/booking/cancellation request is in flight: those requests commit and
 * return long before the worker gets to publishing, so a slow or disconnected
 * WebSocket layer can never make a reservation wait.
 */

interface ConnectionMeta {
  /**
   * Resolves once, to whatever `authenticateUpgrade` decides. A message
   * handler awaits this rather than reading a plain field, because
   * authenticating involves a database round trip - see the module doc
   * comment - and a client can send its first message before that round
   * trip finishes. Listeners are attached synchronously in the `connection`
   * callback, before any `await`, precisely so a fast message is never
   * dropped for lack of a registered handler; only the *processing* of that
   * message waits on identity, not its receipt.
   */
  user: Promise<AuthenticatedUser | undefined>;
  isAlive: boolean;
}

const connectionMeta = new WeakMap<WebSocket, ConnectionMeta>();

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws: WebSocket, code: ErrorMessage['code'], message: string): void {
  send(ws, { type: 'ERROR', code, message });
}

async function handleSubscribe(ws: WebSocket, eventId: string): Promise<void> {
  const meta = connectionMeta.get(ws);
  if (meta === undefined) {
    return;
  }

  if (isSubscribed(ws, eventId)) {
    send(ws, { type: 'SUBSCRIBED', eventId } satisfies SubscribedMessage);
    return;
  }

  if (subscriptionCount(ws) >= config.realtime.maxSubscriptionsPerConnection) {
    sendError(ws, 'SUBSCRIPTION_LIMIT_EXCEEDED', 'Too many subscriptions on this connection');
    return;
  }

  // The exact rule GET /api/v1/events/:eventId (and its seat map) already
  // enforces - see event-visibility.ts. A hidden event and a nonexistent one
  // answer identically here too, for the same reason they do over REST.
  let allowed: boolean;
  try {
    const user = await meta.user;
    allowed = await canSubscribeToEvent(eventId, user);
  } catch (error) {
    logger.error('Subscription authorization check failed', {
      eventId,
      error: error instanceof Error ? error.message : String(error),
    });
    sendError(ws, 'NOT_FOUND', 'Event not found');
    return;
  }

  if (!allowed) {
    sendError(ws, 'NOT_FOUND', 'Event not found');
    return;
  }

  await subscribeConnection(ws, eventId);
  send(ws, { type: 'SUBSCRIBED', eventId } satisfies SubscribedMessage);
}

async function handleUnsubscribe(ws: WebSocket, eventId: string): Promise<void> {
  await unsubscribeConnection(ws, eventId);
  send(ws, { type: 'UNSUBSCRIBED', eventId } satisfies UnsubscribedMessage);
}

/**
 * Routes one decoded message. Never throws: every failure this function can
 * reach becomes an `ERROR` message to the client that sent it, not a closed
 * connection - a client mistake should not cost it every other subscription
 * already in place on the same socket.
 */
async function handleMessage(ws: WebSocket, raw: Buffer): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendError(ws, 'INVALID_MESSAGE', 'Message must be valid JSON');
    return;
  }

  const result = clientMessageSchema.safeParse(parsed);
  if (!result.success) {
    sendError(ws, 'INVALID_MESSAGE', 'Unrecognised message shape');
    return;
  }

  if (result.data.type === 'SUBSCRIBE_EVENT') {
    await handleSubscribe(ws, result.data.eventId);
  } else {
    await handleUnsubscribe(ws, result.data.eventId);
  }
}

/**
 * Detects a dead connection the TCP layer has not noticed yet - a laptop put
 * to sleep, a phone that lost signal, a NAT that silently dropped the mapping
 * - by pinging every open connection on an interval and terminating whichever
 * one has not ponged back since the last ping. Native `ws` ping/pong; nothing
 * application-level.
 */
function startHeartbeat(wss: WebSocketServer): NodeJS.Timeout {
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      const meta = connectionMeta.get(ws);
      if (meta === undefined) {
        continue;
      }
      if (!meta.isAlive) {
        ws.terminate();
        continue;
      }
      meta.isAlive = false;
      ws.ping();
    }
  }, config.realtime.heartbeatIntervalMs);
  interval.unref();
  return interval;
}

let wss: WebSocketServer | null = null;
let heartbeat: NodeJS.Timeout | null = null;

/**
 * Attaches the WebSocket server to the same `http.Server` the REST API
 * already listens on - `express`'s own `app.listen()` returns a genuine
 * `http.Server`, so no second port and no separate listener are needed.
 * Mounted at `/ws`.
 */
export async function attachWebSocketServer(server: Server): Promise<void> {
  configureBackpressureLimit(config.realtime.maxBufferedBytes);
  await startSubscriptionRegistry();

  wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: config.realtime.maxMessageBytes,
  });

  wss.on('connection', (ws: WebSocket, req) => {
    // Every listener is attached here, synchronously, before anything is
    // awaited - see the `user` field's own doc comment for why: a client can
    // send SUBSCRIBE_EVENT the instant the handshake completes, faster than
    // `authenticateUpgrade`'s database round trip resolves, and a listener
    // registered only after that round trip would simply never see it.
    const authPromise = authenticateUpgrade(req);
    authPromise.catch((error: unknown) => {
      logger.error('WebSocket authentication failed unexpectedly', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    connectionMeta.set(ws, { user: authPromise, isAlive: true });
    registerConnection(ws);

    ws.on('pong', () => {
      const meta = connectionMeta.get(ws);
      if (meta !== undefined) {
        meta.isAlive = true;
      }
    });

    ws.on('message', (data: Buffer) => {
      void handleMessage(ws, data);
    });

    ws.on('close', () => {
      void deregisterConnection(ws);
      connectionMeta.delete(ws);
    });

    ws.on('error', (error: Error) => {
      logger.warn('WebSocket connection error', { error: error.message });
    });
  });

  heartbeat = startHeartbeat(wss);

  logger.info('Real-time WebSocket server attached', {
    path: '/ws',
    heartbeatIntervalMs: config.realtime.heartbeatIntervalMs,
  });
}

/**
 * Closes every open connection and stops the Redis subscriber. Part of the
 * server's own shutdown sequence, called alongside `closeRedis()`/`closePool()`
 * - `server.close()` alone does not touch already-upgraded WebSocket
 * connections.
 */
export async function closeWebSocketServer(): Promise<void> {
  if (heartbeat !== null) {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  if (wss !== null) {
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => wss!.close(() => resolve()));
    wss = null;
  }

  await stopSubscriptionRegistry();
}
