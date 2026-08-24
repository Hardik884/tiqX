import { WebSocket } from 'ws';

import type { ClientMessage, ServerMessage } from '../../src/realtime/message-types.js';

/** A `ws` client dialled at the real-time endpoint, optionally authenticated. */
export function connectClient(baseUrl: string, token?: string): WebSocket {
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
  const headers = token === undefined ? undefined : { Authorization: `Bearer ${token}` };
  return new WebSocket(wsUrl, headers === undefined ? undefined : { headers });
}

export function waitForOpen(ws: WebSocket, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for open')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function waitForClose(ws: WebSocket, timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
    ws.once('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

export function send(ws: WebSocket, message: ClientMessage): void {
  ws.send(JSON.stringify(message));
}

/** Waits for the next parsed server message matching `predicate`, or a timeout. */
export function waitForMessage(
  ws: WebSocket,
  predicate: (message: ServerMessage) => boolean,
  timeoutMs = 5_000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`timed out waiting for a matching message`));
    }, timeoutMs);

    function onMessage(data: Buffer): void {
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(data.toString('utf8')) as ServerMessage;
      } catch {
        return;
      }
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(parsed);
      }
    }

    ws.on('message', onMessage);
  });
}

/** Collects every message received during `withinMs`, for a negative assertion. */
export function collectMessages(ws: WebSocket, withinMs: number): Promise<ServerMessage[]> {
  return new Promise((resolve) => {
    const collected: ServerMessage[] = [];
    function onMessage(data: Buffer): void {
      try {
        collected.push(JSON.parse(data.toString('utf8')) as ServerMessage);
      } catch {
        // ignore
      }
    }
    ws.on('message', onMessage);
    setTimeout(() => {
      ws.off('message', onMessage);
      resolve(collected);
    }, withinMs);
  });
}
