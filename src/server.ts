import type { Server } from 'node:http';

import { createApp } from './app.js';
import { config } from './config/index.js';
import { closePool, verifyDatabaseConnection } from './db/pool.js';
import { logger } from './utils/logger.js';

let shuttingDown = false;

async function shutdown(server: Server, reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info('Shutting down', { reason });

  // Last resort: never hang forever on a stuck connection.
  const forceExit = setTimeout(() => {
    logger.error('Forced shutdown after timeout', { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        // Not listening (for example a failed bind) is fine; nothing to close.
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await closePool();
    logger.info('Shutdown complete');
    process.exit(exitCode);
  } catch (error) {
    logger.error('Error during shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

async function start(): Promise<void> {
  try {
    await verifyDatabaseConnection();
    logger.info('Connected to PostgreSQL');
  } catch (error) {
    logger.error('Unable to reach PostgreSQL, aborting startup', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  const server = createApp().listen(config.port, () => {
    logger.info('Server listening', { port: config.port, env: config.env });
  });

  // Bind failures (for example EADDRINUSE) surface here, not as a throw.
  server.on('error', (error: NodeJS.ErrnoException) => {
    logger.error('HTTP server error', { error: error.message, code: error.code });
    void shutdown(server, 'serverError', 1);
  });

  process.on('SIGTERM', () => void shutdown(server, 'SIGTERM', 0));
  process.on('SIGINT', () => void shutdown(server, 'SIGINT', 0));

  process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    void shutdown(server, 'uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
    void shutdown(server, 'unhandledRejection', 1);
  });
}

void start();
