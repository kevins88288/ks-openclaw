/**
 * Plugin Config Schema — Phase 3
 *
 * TypeBox-based runtime validation for the redis-orchestrator plugin config.
 * The loader calls configSchema.safeParse(entry.config) at load time and passes
 * the validated result as api.pluginConfig.
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
// NOTE: OpenClawPluginConfigSchema is not yet exported from openclaw/plugin-sdk.
// COUPLING: The inferred type of redisOrchestratorConfigSchema must remain structurally
// compatible with src/plugins/types.OpenClawPluginConfigSchema. If that type changes,
// update safeParse/jsonSchema shape accordingly.

export const RedisOrchestratorConfigType = Type.Object(
  {
    redis: Type.Optional(
      Type.Object(
        {
          host: Type.Optional(Type.String({ default: "127.0.0.1" })),
          port: Type.Optional(Type.Number({ default: 6379 })),
          password: Type.Optional(Type.String()),
          tls: Type.Optional(Type.Boolean({ default: false })),
        },
        { additionalProperties: false },
      ),
    ),
    circuitBreaker: Type.Optional(
      Type.Object(
        {
          failureThreshold: Type.Optional(Type.Number({ default: 5, minimum: 1 })),
          resetTimeout: Type.Optional(Type.Number({ default: 30000, minimum: 1000 })),
        },
        { additionalProperties: false },
      ),
    ),
    rateLimit: Type.Optional(
      Type.Object(
        {
          dispatchesPerMinute: Type.Optional(
            Type.Number({ default: 10, minimum: 0, description: "0 = unlimited" }),
          ),
          maxQueueDepth: Type.Optional(Type.Number({ default: 50, minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
    dlq: Type.Optional(
      Type.Object(
        {
          alertChannel: Type.Optional(Type.String({ default: "discord" })),
        },
        { additionalProperties: false },
      ),
    ),
    bullBoard: Type.Optional(
      Type.Object(
        {
          authToken: Type.Optional(
            Type.String({
              description: "Bearer token for Bull Board UI access. If unset, endpoint is disabled.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    retry: Type.Optional(
      Type.Object(
        {
          agentFailureAttempts: Type.Optional(
            Type.Number({
              default: 3,
              minimum: 1,
              description: "Total attempts including initial dispatch (default: 3)",
            }),
          ),
          agentFailureBaseDelayMs: Type.Optional(
            Type.Number({
              default: 300_000,
              minimum: 1000,
              description: "Base delay in ms for exponential backoff on agent failure (default: 300000 = 5min)",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    learnings: Type.Optional(
      Type.Object(
        {
          ttlDays: Type.Optional(
            Type.Number({
              default: 365,
              minimum: 1,
              description: "TTL in days for individual learning entries (default: 365)",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type RedisOrchestratorConfig = Static<typeof RedisOrchestratorConfigType>;

/**
 * safeParse wrapper that returns { success, data, error } as expected by the plugin loader.
 */
function safeParse(value: unknown): {
  success: boolean;
  data?: unknown;
  error?: { issues?: Array<{ path: Array<string | number>; message: string }> };
} {
  // Treat undefined/null as empty config (all defaults apply)
  const input = value ?? {};

  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      success: false,
      error: {
        issues: [{ path: [], message: "redis-orchestrator config must be an object" }],
      },
    };
  }

  // Use TypeBox Value.Check for validation, Value.Default + Value.Clean for defaults
  const cloned = JSON.parse(JSON.stringify(input));
  const errors = [...Value.Errors(RedisOrchestratorConfigType, cloned)];

  if (errors.length > 0) {
    return {
      success: false,
      error: {
        issues: errors.map((e) => ({
          path: e.path.split("/").filter(Boolean),
          message: `${e.path || "/"}: ${e.message}`,
        })),
      },
    };
  }

  // Apply defaults via Value.Default then clean extra properties
  Value.Default(RedisOrchestratorConfigType, cloned);
  Value.Clean(RedisOrchestratorConfigType, cloned);

  return { success: true, data: cloned };
}

/**
 * JSON Schema representation for the manifest (openclaw.plugin.json).
 * This is used by the loader for static validation before the TypeBox safeParse runs.
 */
const jsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    redis: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "number", default: 6379 },
        password: { type: "string" },
        tls: { type: "boolean", default: false },
      },
    },
    circuitBreaker: {
      type: "object",
      additionalProperties: false,
      properties: {
        failureThreshold: { type: "number", default: 5 },
        resetTimeout: { type: "number", default: 30000 },
      },
    },
    rateLimit: {
      type: "object",
      additionalProperties: false,
      properties: {
        dispatchesPerMinute: { type: "number", default: 10 },
        maxQueueDepth: { type: "number", default: 50 },
      },
    },
    dlq: {
      type: "object",
      additionalProperties: false,
      properties: {
        alertChannel: { type: "string", default: "discord" },
      },
    },
    bullBoard: {
      type: "object",
      additionalProperties: false,
      properties: {
        authToken: { type: "string" },
      },
    },
    retry: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentFailureAttempts: { type: "number", default: 3 },
        agentFailureBaseDelayMs: { type: "number", default: 300000 },
      },
    },
    learnings: {
      type: "object",
      additionalProperties: false,
      properties: {
        ttlDays: { type: "number", default: 365 },
      },
    },
  },
};

// Inferred type is structurally compatible with OpenClawPluginConfigSchema from src/plugins/types
export const redisOrchestratorConfigSchema = {
  safeParse,
  jsonSchema,
};
