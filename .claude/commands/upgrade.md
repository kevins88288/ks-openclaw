# Upgrade OpenClaw (ks-openclaw fork)

Run from a Claude Code session in ~/workspace/ks-openclaw/. Never from within the gateway.

## Steps

1. Pull upstream changes

   ```bash
   git fetch origin main
   git pull origin main --ff-only
   ```

2. Install dependencies + build

   ```bash
   pnpm install
   pnpm build
   ```

3. Re-apply local patches (both required)

   ```bash
   git apply ~/workspace/openclaw/patches/openclaw-hook-runner-fix.patch
   git apply ~/workspace/openclaw/patches/openclaw-gcp-adc.patch
   pnpm build
   ```

   If a patch fails (upstream changed the file), see Local Patches section
   in ks-openclaw/CLAUDE.md for manual fallback instructions.

4. Update runtime config if needed
   - Check ~/.openclaw/openclaw.json for model/config changes
   - Check ~/.config/systemd/user/openclaw-gateway.service for version

5. Restart the gateway

   ```bash
   systemctl --user daemon-reload
   systemctl --user restart openclaw-gateway.service
   ```

6. Verify
   - Check logs: `tail -f ~/.openclaw/logs/gateway.log`
   - If subagent spawns fail with "pairing required":
     ```bash
     openclaw devices list
     openclaw devices approve <requestId>
     ```

7. Log the upgrade
   - Add an entry to `ks-openclaw/UPGRADE-LOG.md` with the date, version bump, patch status, and any issues
