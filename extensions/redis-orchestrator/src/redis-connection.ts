/**
 * Redis Connection Management
 *
 * Manages the shared Redis connection for BullMQ
 */

import type { ConnectionOptions } from "bullmq";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { Redis } from "ioredis";

/** Redis instance type — use this for all parameter/field annotations */
export type RedisConnection = Redis;

/** Cast a Redis instance to BullMQ's ConnectionOptions (same class, different TS resolution) */
export function asBullMQConnection(conn: Redis): ConnectionOptions {
  return conn as unknown as ConnectionOptions;
}

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
    retryStrategy: (times: number) => Math.min(times * 500, 30_000),
  });

  connection.on("error", (err: Error) => {
    logger.warn(`redis: connection error: ${err.message}`);
  });

  connection.on("connect", () => {
    logger.info("redis: connected");
  });

  connection.on("ready", () => {
    logger.info("redis: ready");
  });

  connection.on("close", () => {
    logger.warn("redis: connection closed");
  });

  connection.on("reconnecting", () => {
    logger.info("redis: reconnecting...");
  });

  return connection;
}

export async function closeRedisConnection(connection: Redis, logger: PluginLogger): Promise<void> {
  try {
    await connection.quit();
    logger.info("redis: connection closed gracefully");
  } catch (err) {
    logger.warn(`redis: error during close: ${err instanceof Error ? err.message : String(err)}`);
  }
}
