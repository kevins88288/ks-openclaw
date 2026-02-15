import { GoogleAuth } from "google-auth-library";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";

export type CachedGcpAdcToken = {
  token: string;
  /** milliseconds since epoch */
  expiresAt: number;
  /** milliseconds since epoch */
  updatedAt: number;
};

function resolveGcpAdcTokenCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "credentials", "gcp-adc.token.json");
}

function isTokenUsable(cache: CachedGcpAdcToken, now = Date.now()): boolean {
  // Keep 5-minute safety margin (GCP tokens typically have 1hr TTL)
  return cache.expiresAt - now > 5 * 60 * 1000;
}

export async function resolveGcpAdcToken(params?: {
  env?: NodeJS.ProcessEnv;
  scopes?: string[];
}): Promise<{
  token: string;
  expiresAt: number;
  source: string;
}> {
  const env = params?.env ?? process.env;
  const cachePath = resolveGcpAdcTokenCachePath(env);
  const cached = loadJsonFile(cachePath) as CachedGcpAdcToken | undefined;

  // Return cached token if still valid
  if (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
    if (isTokenUsable(cached)) {
      return {
        token: cached.token,
        expiresAt: cached.expiresAt,
        source: `cache:${cachePath}`,
      };
    }
  }

  // Fetch fresh token via ADC
  const auth = new GoogleAuth({
    scopes: params?.scopes ?? ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const accessTokenResponse = await client.getAccessToken();

  const token =
    typeof accessTokenResponse === "string" ? accessTokenResponse : accessTokenResponse?.token;

  if (!token) {
    throw new Error("Failed to obtain GCP ADC access token");
  }

  // GCP tokens typically expire in 1 hour (default since we can't get exact expiry from the response)
  const expiresAt = Date.now() + 60 * 60 * 1000;

  const payload: CachedGcpAdcToken = {
    token,
    expiresAt,
    updatedAt: Date.now(),
  };

  saveJsonFile(cachePath, payload);

  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    source: "gcp-adc",
  };
}
