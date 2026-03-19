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

// ── Thread label ─────────────────────────────────────────────────────────────

const MATTERMOST_THREAD_LABEL_SNIPPET_MAX = 60;

/**
 * Builds a human-readable label for a Mattermost thread conversation.
 * Mirrors the pattern used by Slack ("Slack thread #channel: snippet...").
 *
 * Only call when `threadRootId` is present (i.e. inside a thread context).
 *
 * @param channelName - Channel display name (e.g. "general" or "deployments")
 * @param threadStarter - Resolved thread starter (from resolveMattermostThreadStarter), or null
 * @param threadRootId - Root post ID used as fallback when starter text is unavailable
 * @returns e.g. "Mattermost thread #general: Deploy the new release to prod"
 */
export function buildMattermostThreadLabel(params: {
  channelName: string;
  threadStarter: MattermostThreadStarter | null;
  threadRootId: string;
}): string {
  const { channelName, threadStarter, threadRootId } = params;
  const prefix = `Mattermost thread #${channelName}`;
  const rawSnippet = threadStarter?.text?.trim() || threadRootId;
  const snippet = rawSnippet.slice(0, MATTERMOST_THREAD_LABEL_SNIPPET_MAX);
  return `${prefix}: ${snippet}`;
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

// ── Reply context (Gap 2) ─────────────────────────────────────────────────────
// Surfaces the quoted post content when a user uses the "reply to" gesture in
// Mattermost (post.parent_id is set and differs from post.root_id).
//
// Uses a SEPARATE cache from the thread-starter cache:
//   - Same TTL/LRU pattern (5 min / 500 entries / 30s negative TTL)
//   - Shorter truncation limit (1000 chars) — replies are smaller context than
//     thread starters
// ─────────────────────────────────────────────────────────────────────────────

export type MattermostReplyContext = {
  body: string;
  sender: string;
};

const MATTERMOST_REPLY_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const MATTERMOST_REPLY_CONTEXT_CACHE_MAX = 500;
const MATTERMOST_REPLY_CONTEXT_NULL_CACHE_TTL_MS = 30 * 1000;
const MATTERMOST_REPLY_CONTEXT_MAX_TEXT = 1000;

type MattermostReplyContextCacheEntry = {
  value: MattermostReplyContext;
  updatedAt: number;
};

const MATTERMOST_REPLY_CONTEXT_CACHE = new Map<string, MattermostReplyContextCacheEntry>();
const MATTERMOST_REPLY_CONTEXT_NULL_CACHE = new Map<string, number>();

export function __resetMattermostReplyContextCacheForTest(): void {
  MATTERMOST_REPLY_CONTEXT_CACHE.clear();
  MATTERMOST_REPLY_CONTEXT_NULL_CACHE.clear();
}

function getCachedReplyContext(key: string, now: number): MattermostReplyContext | undefined {
  const entry = MATTERMOST_REPLY_CONTEXT_CACHE.get(key);
  if (!entry) return undefined;
  if (now - entry.updatedAt > MATTERMOST_REPLY_CONTEXT_CACHE_TTL_MS) {
    MATTERMOST_REPLY_CONTEXT_CACHE.delete(key);
    return undefined;
  }
  // Refresh LRU position
  MATTERMOST_REPLY_CONTEXT_CACHE.delete(key);
  MATTERMOST_REPLY_CONTEXT_CACHE.set(key, { ...entry, updatedAt: now });
  return entry.value;
}

function setCachedReplyContext(key: string, value: MattermostReplyContext, now: number): void {
  MATTERMOST_REPLY_CONTEXT_CACHE.delete(key);
  MATTERMOST_REPLY_CONTEXT_CACHE.set(key, { value, updatedAt: now });
  while (MATTERMOST_REPLY_CONTEXT_CACHE.size > MATTERMOST_REPLY_CONTEXT_CACHE_MAX) {
    const iter = MATTERMOST_REPLY_CONTEXT_CACHE.keys().next();
    if (iter.done) break;
    MATTERMOST_REPLY_CONTEXT_CACHE.delete(iter.value);
  }
}

function isReplyCachedNull(key: string, now: number): boolean {
  const ts = MATTERMOST_REPLY_CONTEXT_NULL_CACHE.get(key);
  if (ts === undefined) return false;
  if (now - ts > MATTERMOST_REPLY_CONTEXT_NULL_CACHE_TTL_MS) {
    MATTERMOST_REPLY_CONTEXT_NULL_CACHE.delete(key);
    return false;
  }
  return true;
}

function setReplyCachedNull(key: string, now: number): void {
  MATTERMOST_REPLY_CONTEXT_NULL_CACHE.set(key, now);
  while (MATTERMOST_REPLY_CONTEXT_NULL_CACHE.size > MATTERMOST_REPLY_CONTEXT_CACHE_MAX) {
    const iter = MATTERMOST_REPLY_CONTEXT_NULL_CACHE.keys().next();
    if (iter.done) break;
    MATTERMOST_REPLY_CONTEXT_NULL_CACHE.delete(iter.value);
  }
}

/**
 * Fetches the content of a specific parent post (the post being replied to via
 * Mattermost's "reply to" gesture) and surfaces it as ReplyToBody/ReplyToSender.
 *
 * Only called when post.parent_id is non-empty and differs from post.root_id.
 * Backed by a separate TTL+LRU cache (5min / 500 entries / 30s negative TTL).
 * Fail-safe: returns null on any API failure, timeouts, or missing content.
 */
export async function resolveMattermostReplyContext(params: {
  client: MattermostClient;
  parentPostId: string; // post.parent_id (the specific message being replied to)
  resolveUserInfo: (userId: string) => Promise<MattermostUser | null>;
  log?: { debug?: (msg: string) => void };
}): Promise<MattermostReplyContext | null> {
  const { client, parentPostId, resolveUserInfo, log } = params;
  const now = Date.now();

  // 1. Check positive cache
  const cached = getCachedReplyContext(parentPostId, now);
  if (cached) return cached;

  // 2. Check negative cache
  if (isReplyCachedNull(parentPostId, now)) return null;

  // 3. Fetch from API
  const post = await fetchMattermostPost(client, parentPostId);

  if (!post) {
    log?.debug?.(`mattermost: reply context fetch failed for parentPostId=${parentPostId}`);
    setReplyCachedNull(parentPostId, now);
    return null;
  }

  const text = post.message?.trim() ?? "";
  if (!text) {
    setReplyCachedNull(parentPostId, now);
    return null;
  }

  // 4. Resolve sender
  const userId = post.user_id ?? "";
  let sender = userId;
  if (userId) {
    try {
      const userInfo = await resolveUserInfo(userId);
      sender = userInfo?.username?.trim() || userId;
    } catch {
      // resolveUserInfo failed — keep userId as sender
    }
  }

  // 5. Truncate, cache, and return
  const body =
    text.length > MATTERMOST_REPLY_CONTEXT_MAX_TEXT
      ? text.slice(0, MATTERMOST_REPLY_CONTEXT_MAX_TEXT)
      : text;

  const result: MattermostReplyContext = { body, sender };
  setCachedReplyContext(parentPostId, result, now);
  return result;
}

/**
 * Convenience wrapper for monitor.ts.
 *
 * Mattermost only has specific "reply to" context when parentPostId is present
 * and differs from the thread root id. This helper enforces that guard and
 * ensures we do not fetch unnecessarily.
 */
export async function resolveMattermostReplyContextForPost(params: {
  client: MattermostClient;
  threadRootId: string | undefined;
  parentPostId: string | undefined;
  resolveUserInfo: (userId: string) => Promise<MattermostUser | null>;
  log?: { debug?: (msg: string) => void };
}): Promise<MattermostReplyContext | null> {
  const rootId = params.threadRootId?.trim();
  const parentId = params.parentPostId?.trim();
  if (!rootId || !parentId || parentId === rootId) {
    return null;
  }
  return await resolveMattermostReplyContext({
    client: params.client,
    parentPostId: parentId,
    resolveUserInfo: params.resolveUserInfo,
    log: params.log,
  });
}
