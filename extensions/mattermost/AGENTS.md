# Mattermost Extension — Agent Notes

## MaxPostSize Configuration (2026-02-23, updated 2026-02-26)

The Mattermost `posts.message` column and OpenClaw chunk limit have been raised to support long agent messages without splitting.

### What was changed

| Component                                | Before           | After             |
| ---------------------------------------- | ---------------- | ----------------- |
| Postgres `posts.message` column          | `VARCHAR(65535)` | `VARCHAR(200000)` |
| Mattermost `MaxPostSize` (server config) | 16383            | 16383 (unchanged) |
| `MATTERMOST_DEFAULT_CHUNK_LIMIT`         | `4000`           | `16000`           |

### Architecture: chunk limit resolution

There are **3 code paths** where Mattermost chunk limits are resolved, all using the single constant `MATTERMOST_DEFAULT_CHUNK_LIMIT` (16000) defined in `src/mattermost/accounts.ts`:

| #   | Path               | File                                           | How limit is used                                                         |
| --- | ------------------ | ---------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Outbound CLI/API   | `src/channel.ts` outbound config               | `textChunkLimit: MATTERMOST_DEFAULT_CHUNK_LIMIT`                          |
| 2   | Inbound auto-reply | `src/mattermost/monitor.ts`                    | `fallbackLimit: account.textChunkLimit ?? MATTERMOST_DEFAULT_CHUNK_LIMIT` |
| 3   | Block streaming    | Core `src/auto-reply/reply/block-streaming.ts` | Reads from channel dock outbound (path 1)                                 |

**Resolution priority** (from core `src/auto-reply/chunk.ts:resolveTextChunkLimit`):

1. Config override: `cfg.channels.mattermost.accounts[id].textChunkLimit`
2. Config base: `cfg.channels.mattermost.textChunkLimit`
3. Fallback param: `MATTERMOST_DEFAULT_CHUNK_LIMIT` (16000)
4. Hard default: `DEFAULT_CHUNK_LIMIT` (4000) — only if fallback is missing/0

### Why 16000

- Mattermost server `MaxPostSize` = 16383
- 16000 gives ~383 chars safety margin below the server limit
- Postgres column is `VARCHAR(200000)` — well above the limit

### DB backup

Pre-change backup saved at: `/home/ubuntu/mattermost_backup_20260223_073846.dump`

### Important: future changes

- If `MaxPostSize` changes, update `MATTERMOST_DEFAULT_CHUNK_LIMIT` in `src/mattermost/accounts.ts`, rebuild (`pnpm build` from repo root), and restart the gateway.
- The constant is the single source of truth — both `channel.ts` (outbound) and `monitor.ts` (inbound) reference it.
- `textChunkLimit` is **per-channel** — changing it here does NOT affect Telegram, Discord, Slack, or any other channel.
- The gateway in this deployment runs via nohup (no systemd); restart with: `pkill -f openclaw-gateway && nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`

### Channel limit reference (all channels)

| Value     | Channels                                                                       |
| --------- | ------------------------------------------------------------------------------ |
| 350       | IRC, iMessage (dock)                                                           |
| 500       | Twitch                                                                         |
| 2000      | Discord, Zalo                                                                  |
| 4000      | Telegram, Signal, WhatsApp, Slack, iMessage, MS Teams, Matrix, and most others |
| 5000      | LINE                                                                           |
| 10000     | Tlon                                                                           |
| **16000** | **Mattermost (this extension)**                                                |
