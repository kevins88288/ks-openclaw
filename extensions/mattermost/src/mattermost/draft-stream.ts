import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/mattermost";
import { createMattermostPost, deleteMattermostPost, patchMattermostPost } from "./client.js";
import type { MattermostClient } from "./client.js";

/** Mattermost posts cap at 16383 characters by default; we use 16000 with margin. */
const MATTERMOST_STREAM_MAX_CHARS = 16000;
const DEFAULT_THROTTLE_MS = 1000;

export type MattermostDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => string | undefined;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
};

export function createMattermostDraftStream(params: {
  client: MattermostClient;
  channelId: string;
  maxChars?: number;
  replyToId?: string | (() => string | undefined);
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): MattermostDraftStream {
  const maxChars = params.maxChars != null
    ? Math.min(params.maxChars, MATTERMOST_STREAM_MAX_CHARS)
    : MATTERMOST_STREAM_MAX_CHARS;
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const channelId = params.channelId;
  const client = params.client;
  const resolveReplyToId = () =>
    typeof params.replyToId === "function" ? params.replyToId() : params.replyToId;

  const streamState = { stopped: false, final: false };
  let streamPostId: string | undefined;
  let lastSentText = "";

  // Deletion safety guard: track all post IDs created by this stream.
  const createdPostIds = new Set<string>();

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    // Allow final flush even if stopped (e.g., after clear()).
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    if (trimmed.length > maxChars) {
      streamState.stopped = true;
      params.warn?.(
        `mattermost stream preview stopped (text length ${trimmed.length} > ${maxChars})`,
      );
      return false;
    }
    if (trimmed === lastSentText) {
      return true;
    }

    // Debounce first preview send for better push notification quality.
    if (streamPostId === undefined && minInitialChars != null && !streamState.final) {
      if (trimmed.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = trimmed;
    try {
      if (streamPostId !== undefined) {
        // Edit existing post
        await patchMattermostPost(client, streamPostId, { message: trimmed });
        return true;
      }
      // Create new post
      const rootId = resolveReplyToId()?.trim();
      const post = await createMattermostPost(client, {
        channelId,
        message: trimmed,
        rootId: rootId || undefined,
      });
      const postId = post.id;
      if (typeof postId !== "string" || !postId) {
        streamState.stopped = true;
        params.warn?.(
          "mattermost stream preview stopped (missing post id from create)",
        );
        return false;
      }
      streamPostId = postId;
      createdPostIds.add(postId);
      return true;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(
        `mattermost stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const readMessageId = () => streamPostId;
  const clearMessageId = () => {
    streamPostId = undefined;
  };
  const isValidStreamPostId = (value: unknown): value is string => typeof value === "string";
  const deleteStreamPost = async (postId: string) => {
    if (!createdPostIds.has(postId)) {
      params.warn?.(
        `mattermost draft stream: refusing to delete unknown post ${postId}`,
      );
      return;
    }
    await deleteMattermostPost(client, postId);
    createdPostIds.delete(postId);
  };

  const { loop, update, stop, clear } = createFinalizableDraftLifecycle({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
    readMessageId,
    clearMessageId,
    isValidMessageId: isValidStreamPostId,
    deleteMessage: deleteStreamPost,
    warn: params.warn,
    warnPrefix: "mattermost stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    streamPostId = undefined;
    lastSentText = "";
    loop.resetPending();
  };

  params.log?.(
    `mattermost stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`,
  );

  return {
    update,
    flush: loop.flush,
    messageId: () => streamPostId,
    clear,
    stop,
    forceNewMessage,
  };
}
