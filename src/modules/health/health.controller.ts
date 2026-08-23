import type { Request, Response } from 'express';

import { verifyDatabaseConnection } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

/**
 * Liveness: confirms the process is up and serving requests. Deliberately does
 * not touch dependencies, and exposes no configuration or credentials.
 */
export function getHealth(_req: Request, res: Response): void {
  res.status(200).json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Readiness: confirms the process can reach PostgreSQL. Failure details are
 * logged, never returned, so connection strings cannot leak.
 */
export async function getReadiness(_req: Request, res: Response): Promise<void> {
  try {
    await verifyDatabaseConnection();
    res.status(200).json({
      status: 'ok',
      dependencies: { database: 'up' },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Readiness check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(503).json({
      status: 'unavailable',
      dependencies: { database: 'down' },
      timestamp: new Date().toISOString(),
    });
  }
}
