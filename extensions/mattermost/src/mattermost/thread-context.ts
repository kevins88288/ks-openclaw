// Mattermost plugin module implements thread-context (thread starter + reply-to)
// prompt-context injection.
//
// Two related, independently-cached pieces of context are built here:
//  - Thread starter: on the first agent turn inside a Mattermost thread, fetch
//    the thread root post so the agent knows what the thread is about
//    (ThreadStarterBody / IsFirstThreadTurn / ThreadLabel).
//  - Reply-to: when a user uses Mattermost's "reply to" gesture on a specific
//    message (post.parent_id set and different from post.root_id), fetch that
//    specific message so the agent can see what is being quoted
//    (ReplyToBody / ReplyToSender).
import { fetchMattermostPost, type MattermostClient, type MattermostUser } from "./client.js";

// ── Thread starter ──────────────────────────────────────────────────────────

export type MattermostThreadStarter = {
  text: string;
  author: string;
  timestamp?: number;
};

// Mirrors Discord's established TTL+LRU cache pattern: 5-minute TTL, max 500
// entries with LRU eviction, plus a short negative cache to avoid hammering
// the API for deleted/inaccessible posts.
const MATTERMOST_THREAD_STARTER_CACHE_TTL_MS = 5 * 60 * 1000;
const MATTERMOST_THREAD_STARTER_CACHE_MAX = 500;
const MATTERMOST_THREAD_STARTER_NULL_CACHE_TTL_MS = 30 * 1000;
const MATTERMOST_THREAD_STARTER_MAX_TEXT = 2000;

type MattermostThreadStarterCacheEntry = {
  value: MattermostThreadStarter;
  updatedAt: number;
};

const MATTERMOST_THREAD_STARTER_CACHE = new Map<string, MattermostThreadStarterCacheEntry>();
const MATTERMOST_THREAD_STARTER_NULL_CACHE = new Map<string, number>();

export function __resetMattermostThreadStarterCacheForTest(): void {
  MATTERMOST_THREAD_STARTER_CACHE.clear();
  MATTERMOST_THREAD_STARTER_NULL_CACHE.clear();
}

function getCachedThreadStarter(key: string, now: number): MattermostThreadStarter | undefined {
  const entry = MATTERMOST_THREAD_STARTER_CACHE.get(key);
  if (!entry) {
    return undefined;
  }
  if (now - entry.updatedAt > MATTERMOST_THREAD_STARTER_CACHE_TTL_MS) {
    MATTERMOST_THREAD_STARTER_CACHE.delete(key);
    return undefined;
  }
  // Refresh LRU position by re-inserting (Map maintains insertion order).
  MATTERMOST_THREAD_STARTER_CACHE.delete(key);
  MATTERMOST_THREAD_STARTER_CACHE.set(key, { ...entry, updatedAt: now });
  return entry.value;
}

function setCachedThreadStarter(key: string, value: MattermostThreadStarter, now: number): void {
  MATTERMOST_THREAD_STARTER_CACHE.delete(key);
  MATTERMOST_THREAD_STARTER_CACHE.set(key, { value, updatedAt: now });
  while (MATTERMOST_THREAD_STARTER_CACHE.size > MATTERMOST_THREAD_STARTER_CACHE_MAX) {
    const iter = MATTERMOST_THREAD_STARTER_CACHE.keys().next();
    if (iter.done) {
      break;
    }
    MATTERMOST_THREAD_STARTER_CACHE.delete(iter.value);
  }
}

function isThreadStarterNullCached(key: string, now: number): boolean {
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

function setThreadStarterNullCached(key: string, now: number): void {
  MATTERMOST_THREAD_STARTER_NULL_CACHE.set(key, now);
  while (MATTERMOST_THREAD_STARTER_NULL_CACHE.size > MATTERMOST_THREAD_STARTER_CACHE_MAX) {
    const iter = MATTERMOST_THREAD_STARTER_NULL_CACHE.keys().next();
    if (iter.done) {
      break;
    }
    MATTERMOST_THREAD_STARTER_NULL_CACHE.delete(iter.value);
  }
}

/**
 * Fetches and caches the content of a thread's root post.
 * Fail-safe: returns null on any API failure, missing post, or empty message.
 */
export async function resolveMattermostThreadStarter(params: {
  client: MattermostClient;
  rootPostId: string;
  resolveUserInfo: (userId: string) => Promise<MattermostUser | null>;
  log?: { debug?: (msg: string) => void };
}): Promise<MattermostThreadStarter | null> {
  const { client, rootPostId, resolveUserInfo, log } = params;
  const now = Date.now();

  const cached = getCachedThreadStarter(rootPostId, now);
  if (cached) {
    return cached;
  }
  if (isThreadStarterNullCached(rootPostId, now)) {
    return null;
  }

  const post = await fetchMattermostPost(client, rootPostId);
  if (!post) {
    log?.debug?.(`mattermost: thread starter fetch failed for rootPostId=${rootPostId}`);
    setThreadStarterNullCached(rootPostId, now);
    return null;
  }

  const text = post.message?.trim() ?? "";
  if (!text) {
    setThreadStarterNullCached(rootPostId, now);
    return null;
  }

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

/**
 * Computes the ThreadStarterBody and IsFirstThreadTurn context fields.
 * Thread starter content is only injected on the first agent turn in a
 * thread session (no prior session timestamp) — subsequent turns already
 * have the thread context via the running session/history.
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

const MATTERMOST_THREAD_LABEL_SNIPPET_MAX = 60;

/**
 * Builds a human-readable label for a Mattermost thread conversation.
 * Mirrors the pattern used by Slack ("Slack thread #channel: snippet...").
 * Only call when `threadRootId` is present (i.e. inside a thread context).
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

// ── Reply-to context ────────────────────────────────────────────────────────
// Surfaces the quoted post content when a user uses the "reply to" gesture on
// a specific message in Mattermost (post.parent_id set and different from
// post.root_id). Uses a separate cache from the thread-starter cache above
// (same TTL/LRU shape, shorter truncation — replies are smaller context than
// thread starters).

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

function isReplyContextNullCached(key: string, now: number): boolean {
  const ts = MATTERMOST_REPLY_CONTEXT_NULL_CACHE.get(key);
  if (ts === undefined) return false;
  if (now - ts > MATTERMOST_REPLY_CONTEXT_NULL_CACHE_TTL_MS) {
    MATTERMOST_REPLY_CONTEXT_NULL_CACHE.delete(key);
    return false;
  }
  return true;
}

function setReplyContextNullCached(key: string, now: number): void {
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
 * Only call when post.parent_id is non-empty and differs from post.root_id —
 * callers should use `resolveMattermostSpecificReplyParentId` to compute that.
 *
 * `expectedChannelId` guards against cross-channel information leakage: if the
 * fetched parent post belongs to a different channel than the inbound message,
 * the context is discarded (fail closed).
 *
 * Fail-safe: returns null on any API failure, timeout, or missing content.
 */
export async function resolveMattermostReplyContext(params: {
  client: MattermostClient;
  parentPostId: string;
  expectedChannelId: string;
  resolveUserInfo: (userId: string) => Promise<MattermostUser | null>;
  log?: { debug?: (msg: string) => void };
}): Promise<MattermostReplyContext | null> {
  const { client, parentPostId, expectedChannelId, resolveUserInfo, log } = params;
  const now = Date.now();

  const cached = getCachedReplyContext(parentPostId, now);
  if (cached) return cached;

  if (isReplyContextNullCached(parentPostId, now)) return null;

  const post = await fetchMattermostPost(client, parentPostId);
  if (!post) {
    log?.debug?.(`mattermost: reply context fetch failed for parentPostId=${parentPostId}`);
    setReplyContextNullCached(parentPostId, now);
    return null;
  }

  // Channel binding check: discard the post if it belongs to a different
  // channel than the message that referenced it. Prevents cross-channel
  // context leakage if an attacker can influence the parent_id value.
  if (post.channel_id && post.channel_id !== expectedChannelId) {
    log?.debug?.(
      `mattermost: reply context post ${parentPostId} channel ${post.channel_id} !== expected ${expectedChannelId}, skipping`,
    );
    setReplyContextNullCached(parentPostId, now);
    return null;
  }

  const text = post.message?.trim() ?? "";
  if (!text) {
    setReplyContextNullCached(parentPostId, now);
    return null;
  }

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

  const body =
    text.length > MATTERMOST_REPLY_CONTEXT_MAX_TEXT
      ? text.slice(0, MATTERMOST_REPLY_CONTEXT_MAX_TEXT)
      : text;

  const result: MattermostReplyContext = { body, sender };
  setCachedReplyContext(parentPostId, result, now);
  return result;
}
