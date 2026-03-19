import { fetchMattermostPost, type MattermostClient, type MattermostUser } from "./client.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type MattermostThreadStarter = {
  text: string;
  author: string;
  timestamp?: number;
};

// ── Cache configuration ───────────────────────────────────────────────────────
// Mirrors Discord's established TTL+LRU pattern exactly.
// 5-minute TTL, max 500 entries with LRU eviction.

const MATTERMOST_THREAD_STARTER_CACHE_TTL_MS = 5 * 60 * 1000;
const MATTERMOST_THREAD_STARTER_CACHE_MAX = 500;

// Negative cache: null results TTL 30s to avoid hammering API on deleted/inaccessible posts
const MATTERMOST_THREAD_STARTER_NULL_CACHE_TTL_MS = 30 * 1000;

type MattermostThreadStarterCacheEntry = {
  value: MattermostThreadStarter;
  updatedAt: number;
};

const MATTERMOST_THREAD_STARTER_CACHE = new Map<string, MattermostThreadStarterCacheEntry>();
// Negative cache: stores timestamp of when the null result was recorded
const MATTERMOST_THREAD_STARTER_NULL_CACHE = new Map<string, number>();

export function __resetMattermostThreadStarterCacheForTest(): void {
  MATTERMOST_THREAD_STARTER_CACHE.clear();
  MATTERMOST_THREAD_STARTER_NULL_CACHE.clear();
}

// Get cached entry with TTL check; refresh LRU position on hit
function getCachedThreadStarter(key: string, now: number): MattermostThreadStarter | undefined {
  const entry = MATTERMOST_THREAD_STARTER_CACHE.get(key);
  if (!entry) {
    return undefined;
  }
  // Check TTL expiry
  if (now - entry.updatedAt > MATTERMOST_THREAD_STARTER_CACHE_TTL_MS) {
    MATTERMOST_THREAD_STARTER_CACHE.delete(key);
    return undefined;
  }
  // Refresh LRU position by re-inserting (Map maintains insertion order)
  MATTERMOST_THREAD_STARTER_CACHE.delete(key);
  MATTERMOST_THREAD_STARTER_CACHE.set(key, { ...entry, updatedAt: now });
  return entry.value;
}

// Set cached entry with LRU eviction when max size exceeded
function setCachedThreadStarter(key: string, value: MattermostThreadStarter, now: number): void {
  // Remove existing entry first (to update LRU position)
  MATTERMOST_THREAD_STARTER_CACHE.delete(key);
  MATTERMOST_THREAD_STARTER_CACHE.set(key, { value, updatedAt: now });
  // Evict oldest entries (first in Map) when over max size
  while (MATTERMOST_THREAD_STARTER_CACHE.size > MATTERMOST_THREAD_STARTER_CACHE_MAX) {
    const iter = MATTERMOST_THREAD_STARTER_CACHE.keys().next();
    if (iter.done) {
      break;
    }
    MATTERMOST_THREAD_STARTER_CACHE.delete(iter.value);
  }
}

// Check if the null result is still within its negative-cache TTL
function isNullCached(key: string, now: number): boolean {
  const ts = MATTERMOST_THREAD_STARTER_NULL_CACHE.get(key);
  if (ts === undefined) {
    return false;
  }
  if (now - ts > MATTERMOST_THREAD_STARTER_NULL_CACHE_TTL_MS) {
    MATTERMOST_THREAD_STARTER_NULL_CACHE.delete(key);
    return false;
  }
  return true;
}

function setNullCached(key: string, now: number): void {
  MATTERMOST_THREAD_STARTER_NULL_CACHE.set(key, now);
  while (MATTERMOST_THREAD_STARTER_NULL_CACHE.size > MATTERMOST_THREAD_STARTER_CACHE_MAX) {
    const iter = MATTERMOST_THREAD_STARTER_NULL_CACHE.keys().next();
    if (iter.done) break;
    MATTERMOST_THREAD_STARTER_NULL_CACHE.delete(iter.value);
  }
}

// ── Context field builder ─────────────────────────────────────────────────────

/**
 * Computes the ThreadStarterBody and IsFirstThreadTurn fields for ctxPayload.
 * Exported for unit testing without requiring full monitorMattermostProvider setup.
 */
export function buildThreadStarterContextFields(params: {
  threadRootId: string | undefined;
  threadStarter: MattermostThreadStarter | null;
  sessionPreviousTimestamp: number | undefined;
}): { ThreadStarterBody?: string; IsFirstThreadTurn?: true } {
  const isNewSession = !params.sessionPreviousTimestamp;
  const isThread = Boolean(params.threadRootId);
  return {
    ThreadStarterBody: isThread && isNewSession ? params.threadStarter?.text : undefined,
    IsFirstThreadTurn: isThread && isNewSession ? (true as const) : undefined,
  };
}

// ── Max text length ───────────────────────────────────────────────────────────

const MATTERMOST_THREAD_STARTER_MAX_TEXT = 2000;

// ── Resolver ─────────────────────────────────────────────────────────────────

export async function resolveMattermostThreadStarter(params: {
  client: MattermostClient;
  rootPostId: string;
  resolveUserInfo: (userId: string) => Promise<MattermostUser | null>;
  log?: { debug?: (msg: string) => void };
}): Promise<MattermostThreadStarter | null> {
  const { client, rootPostId, resolveUserInfo, log } = params;
  const now = Date.now();

  // 1. Check positive cache
  const cached = getCachedThreadStarter(rootPostId, now);
  if (cached) {
    return cached;
  }

  // 2. Check negative cache
  if (isNullCached(rootPostId, now)) {
    return null;
  }

  // 3. Fetch from API
  const post = await fetchMattermostPost(client, rootPostId);

  if (!post) {
    log?.debug?.(`mattermost: thread starter fetch failed for rootPostId=${rootPostId}`);
    setNullCached(rootPostId, now);
    return null;
  }

  const text = post.message?.trim() ?? "";
  if (!text) {
    setNullCached(rootPostId, now);
    return null;
  }

  // 4. Resolve author
  const userId = post.user_id ?? "";
  let author = userId;
  if (userId) {
    try {
      const userInfo = await resolveUserInfo(userId);
      author = userInfo?.username?.trim() || userId;
    } catch {
      // resolveUserInfo failed — keep userId as author
    }
  }

  // 5. Truncate text, cache, and return
  const truncatedText =
    text.length > MATTERMOST_THREAD_STARTER_MAX_TEXT
      ? text.slice(0, MATTERMOST_THREAD_STARTER_MAX_TEXT)
      : text;

  const result: MattermostThreadStarter = {
    text: truncatedText,
    author,
    timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
  };

  setCachedThreadStarter(rootPostId, result, now);
  return result;
}
