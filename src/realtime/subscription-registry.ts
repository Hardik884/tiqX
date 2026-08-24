import type { WebSocket } from 'ws';
import type { Redis } from 'ioredis';

import { getRedis } from '../redis/client.js';
import { seatEventsChannel } from '../redis/keys.js';
import { logger } from '../utils/logger.js';
import type { ServerMessage } from './message-types.js';

/**
 * Local, per-process fan-out from Redis Pub/Sub to connected WebSocket
 * clients - the "worker -> WebSocket clients" half of the pipeline described
 * in the real-time worker's doc comment. The worker publishes; every API
 * instance running this module independently decides which of its own
 * sockets to forward a message to.
 *
 * ONE DEDICATED SUBSCRIBER CONNECTION. `ioredis` cannot mix subscribe-mode
 * commands with ordinary ones on the same connection, and the process's main
 * Redis client (`getRedis()`) is already busy with rate limiting - so this
 * duplicates it into a connection used for nothing but SUBSCRIBE/UNSUBSCRIBE.
 *
 * PER-EVENT, REFERENCE-COUNTED CHANNELS. An instance subscribes to
 * `seatEventsChannel(eventId)` only while at least one of its own clients
 * cares about that event, and unsubscribes the moment the last one leaves -
 * see `seatEventsChannel`'s own doc comment for why a channel per event
 * (rather than one global channel every instance always listens to) is worth
 * the bookkeeping: an instance with no subscribers for `eventId` does zero
 * work for it, not even deserializing messages meant for someone else's
 * clients.
 */

interface ConnectionState {
  subscriptions: Set<string>;
}

const connections = new Map<WebSocket, ConnectionState>();
const eventSubscribers = new Map<string, Set<WebSocket>>();

let subscriber: Redis | null = null;

/** Starts the dedicated Pub/Sub connection. Called once, from websocket-server.ts. */
export async function startSubscriptionRegistry(): Promise<void> {
  if (subscriber !== null) {
    return;
  }

  subscriber = getRedis().duplicate({ lazyConnect: true, connectionName: 'tiqx-realtime-subscriber' });
  subscriber.on('error', (error: Error) => {
    logger.error('Realtime Redis subscriber error', { error: error.message });
  });
  subscriber.on('message', (channel: string, raw: string) => {
    forwardToLocalSubscribers(channel, raw);
  });

  await subscriber.connect();
}

export async function stopSubscriptionRegistry(): Promise<void> {
  if (subscriber === null) {
    return;
  }
  try {
    await subscriber.quit();
  } catch {
    subscriber.disconnect();
  } finally {
    subscriber = null;
  }
  connections.clear();
  eventSubscribers.clear();
}

export function registerConnection(ws: WebSocket): void {
  connections.set(ws, { subscriptions: new Set() });
}

/** How many events this connection is currently subscribed to. */
export function subscriptionCount(ws: WebSocket): number {
  return connections.get(ws)?.subscriptions.size ?? 0;
}

export function isSubscribed(ws: WebSocket, eventId: string): boolean {
  return connections.get(ws)?.subscriptions.has(eventId) ?? false;
}

/**
 * Adds `ws` as a local subscriber of `eventId`, opening the Redis channel for
 * this process if it was not already listening to it.
 */
export async function subscribeConnection(ws: WebSocket, eventId: string): Promise<void> {
  const state = connections.get(ws);
  if (state === undefined || state.subscriptions.has(eventId)) {
    return;
  }
  state.subscriptions.add(eventId);

  let subscribers = eventSubscribers.get(eventId);
  const isFirstLocalSubscriber = subscribers === undefined;
  if (subscribers === undefined) {
    subscribers = new Set();
    eventSubscribers.set(eventId, subscribers);
  }
  subscribers.add(ws);

  if (isFirstLocalSubscriber && subscriber !== null) {
    await subscriber.subscribe(seatEventsChannel(eventId));
  }
}

/** Removes `ws` as a local subscriber of `eventId`, closing the Redis channel if it was the last one. */
export async function unsubscribeConnection(ws: WebSocket, eventId: string): Promise<void> {
  const state = connections.get(ws);
  if (state === undefined || !state.subscriptions.has(eventId)) {
    return;
  }
  state.subscriptions.delete(eventId);
  await removeLocalSubscriber(ws, eventId);
}

/** Cleans up everything a closed connection was subscribed to. */
export async function deregisterConnection(ws: WebSocket): Promise<void> {
  const state = connections.get(ws);
  connections.delete(ws);
  if (state === undefined) {
    return;
  }

  await Promise.all([...state.subscriptions].map((eventId) => removeLocalSubscriber(ws, eventId)));
}

async function removeLocalSubscriber(ws: WebSocket, eventId: string): Promise<void> {
  const subscribers = eventSubscribers.get(eventId);
  if (subscribers === undefined) {
    return;
  }
  subscribers.delete(ws);

  if (subscribers.size === 0) {
    eventSubscribers.delete(eventId);
    if (subscriber !== null) {
      await subscriber.unsubscribe(seatEventsChannel(eventId));
    }
  }
}

/**
 * Parses one Redis Pub/Sub message and forwards it to every locally connected
 * subscriber of the event it names, applying backpressure per connection.
 *
 * A message that fails to parse, or whose channel names an event nobody here
 * is actually listening to any more (a benign race with `unsubscribe`, not an
 * error), is dropped silently - there is nobody to tell and nothing to retry.
 */
function forwardToLocalSubscribers(channel: string, raw: string): void {
  const eventIdFromChannel = channel.split(':').at(-1);
  const subscribers = eventIdFromChannel === undefined ? undefined : eventSubscribers.get(eventIdFromChannel);
  if (subscribers === undefined || subscribers.size === 0) {
    return;
  }

  let message: ServerMessage;
  try {
    message = JSON.parse(raw) as ServerMessage;
  } catch (error) {
    logger.error('Discarding unparseable realtime message', {
      channel,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const ws of subscribers) {
    sendWithBackpressure(ws, message);
  }
}

/**
 * Sends one message, or drops it, for a client whose outgoing buffer is
 * already too full to keep up. Dropping rather than queuing without bound is
 * the deliberate choice: a slow client falling behind on live updates loses
 * nothing it cannot recover the same way a fresh connection would - a REST
 * re-fetch of the seat map - and never gets to make the server hold
 * unbounded memory on its behalf. See the module doc comment on
 * websocket-server.ts.
 */
function sendWithBackpressure(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState !== ws.OPEN) {
    return;
  }
  if (ws.bufferedAmount > maxBufferedBytes) {
    logger.warn('Dropping realtime message for a slow client', {
      eventId: 'eventId' in message ? message.eventId : undefined,
      bufferedAmount: ws.bufferedAmount,
    });
    return;
  }
  ws.send(JSON.stringify(message));
}

let maxBufferedBytes = 1_048_576;

/** Set once at startup from config - kept out of the hot path's import graph. */
export function configureBackpressureLimit(bytes: number): void {
  maxBufferedBytes = bytes;
}
