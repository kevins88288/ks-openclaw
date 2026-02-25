# Mattermost Extension — Agent Notes

## MaxPostSize Configuration (2026-02-23, updated 2026-02-25)

The Mattermost `posts.message` column and OpenClaw chunk limit have been raised to support long agent messages without splitting.

### What was changed

| Component                                 | Before           | After                                    | Date       |
| ----------------------------------------- | ---------------- | ---------------------------------------- | ---------- |
| Postgres `posts.message` column           | `VARCHAR(65535)` | `VARCHAR(200000)`                        | 2026-02-23 |
| Mattermost `MaxPostSize` (server config)  | 16383            | 50000                                    | 2026-02-23 |
| `textChunkLimit` in `src/channel.ts:262`  | `4000`           | `50000`                                  | 2026-02-23 |
| `fallbackLimit` in `monitor.ts:740`       | `4000`           | `MATTERMOST_DEFAULT_CHUNK_LIMIT` (50000) | 2026-02-25 |
| `MATTERMOST_DEFAULT_CHUNK_LIMIT` constant | —                | `50000` in `accounts.ts`                 | 2026-02-25 |

### Why (2026-02-25 fix)

The 2026-02-23 change only updated the **outbound** path (`channel.ts` → `deliver.ts`). The **inbound auto-reply** path (`monitor.ts:740`) still had a hardcoded `?? 4000` fallback, so all bot replies were still chunked at 4000 chars. Fix: introduced `MATTERMOST_DEFAULT_CHUNK_LIMIT = 50000` in `accounts.ts` as the single source of truth, used by both `channel.ts:262` and `monitor.ts:740`.

### DB backup

Pre-change backup saved at: `/home/ubuntu/mattermost_backup_20260223_073846.dump`

### Important: future changes

- If `MaxPostSize` ever needs to change again, update **`MATTERMOST_DEFAULT_CHUNK_LIMIT`** in `src/mattermost/accounts.ts` — this is the single source of truth used by both the outbound channel config and the inbound monitor. Also rebuild (`pnpm build`) and restart the gateway.
- The Postgres column is set to `VARCHAR(200000)` — well above the 50k Mattermost limit — so column changes are not needed unless the Mattermost limit is raised above 200k.
- `textChunkLimit` is **per-channel** — changing it here does NOT affect Telegram, Discord, Slack, or any other channel.
- The gateway in this deployment runs via nohup (no systemd); restart with: `pkill -f openclaw-gateway && nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`

### Architecture note: two send paths

There are two paths that send replies to Mattermost — both now use `MATTERMOST_DEFAULT_CHUNK_LIMIT`:

| Path               | File                                               | Limit source                                                              |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------- |
| Outbound (CLI/API) | `src/infra/outbound/deliver.ts` → `channel.ts:262` | `textChunkLimit: MATTERMOST_DEFAULT_CHUNK_LIMIT`                          |
| Inbound auto-reply | `monitor.ts:740`                                   | `fallbackLimit: account.textChunkLimit ?? MATTERMOST_DEFAULT_CHUNK_LIMIT` |

### Channel limit reference (all channels)

| Value     | Channels                                                                       |
| --------- | ------------------------------------------------------------------------------ |
| 350       | IRC, iMessage (dock)                                                           |
| 500       | Twitch                                                                         |
| 2000      | Discord, Zalo                                                                  |
| 4000      | Telegram, Signal, WhatsApp, Slack, iMessage, MS Teams, Matrix, and most others |
| 5000      | LINE                                                                           |
| 10000     | Tlon                                                                           |
| **50000** | **Mattermost (this extension)**                                                |
