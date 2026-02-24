# Mattermost Extension — Agent Notes

## MaxPostSize Configuration (2026-02-23)

The Mattermost `posts.message` column and OpenClaw chunk limit have been raised to support long agent messages without splitting.

### What was changed

| Component                                | Before           | After             |
| ---------------------------------------- | ---------------- | ----------------- |
| Postgres `posts.message` column          | `VARCHAR(65535)` | `VARCHAR(200000)` |
| Mattermost `MaxPostSize` (server config) | 16383            | 50000             |
| `textChunkLimit` in `src/channel.ts:256` | `4000`           | `50000`           |

### Why

Default Mattermost limits caused long agent responses (>4000 chars) to be split into multiple posts. Raising the column to 200k gives headroom; the Mattermost server enforces 50k as its own limit via `MaxPostSize`, so messages up to 50k now arrive as a single post.

### DB backup

Pre-change backup saved at: `/home/ubuntu/mattermost_backup_20260223_073846.dump`

### Important: future changes

- If `MaxPostSize` ever needs to change again, also update `textChunkLimit` in `src/channel.ts` to match, then rebuild OpenClaw (`pnpm build` from repo root) and restart the gateway.
- The Postgres column is set to `VARCHAR(200000)` — well above the 50k Mattermost limit — so column changes are not needed unless the Mattermost limit is raised above 200k.
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
| **50000** | **Mattermost (this extension)**                                                |
