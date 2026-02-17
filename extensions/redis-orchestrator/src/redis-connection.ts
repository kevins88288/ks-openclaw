/**
 * Redis Connection Management
 * 
 * Manages the shared Redis connection for BullMQ
 */

import Redis from 'ioredis';
import type { PluginLogger } from "openclaw/plugin-sdk";

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
}

export function createRedisConnection(config: RedisConfig, logger: PluginLogger): Redis {
  const connection = new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    retryStrategy: (times: number) => {
      if (times > 10) {
        logger.error('redis: max connection retries exceeded');
        return null; // Stop retrying
      }
      const delay = Math.min(times * 100, 3000);
      return delay;
    },
  });

  connection.on('error', (err) => {
    logger.warn(`redis: connection error: ${err.message}`);
  });

  connection.on('connect', () => {
    logger.info('redis: connected');
  });

  connection.on('ready', () => {
    logger.info('redis: ready');
  });

  connection.on('close', () => {
    logger.warn('redis: connection closed');
  });

  connection.on('reconnecting', () => {
    logger.info('redis: reconnecting...');
  });

  return connection;
}

export async function closeRedisConnection(connection: Redis, logger: PluginLogger): Promise<void> {
  try {
    await connection.quit();
    logger.info('redis: connection closed gracefully');
  } catch (err) {
    logger.warn(`redis: error during close: ${err instanceof Error ? err.message : String(err)}`);
  }
}
