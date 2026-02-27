# Upgrade OpenClaw (ks-openclaw fork)

Run from a Claude Code session in ~/workspace/ks-openclaw/. Never from within the gateway.

## Steps

1. Read the upgrade log first

   ```bash
   cat ~/workspace/ks-openclaw/UPGRADE-LOG.md
   ```

   Review past upgrades for recurring issues and lessons learned.

2. Snapshot current state

   ```bash
   git log --oneline -5
   pnpm test 2>&1 | tail -5   # Record pre-upgrade test baseline
   ```

3. Pull upstream changes

   ```bash
   git fetch origin main
   git pull origin main --ff-only
   ```

4. Install dependencies + build

   ```bash
   pnpm install
   pnpm build
   ```

5. Re-apply local patches (check CLAUDE.md Local Patches section for current list)

   ```bash
   git apply ~/workspace/openclaw/patches/openclaw-hook-runner-fix.patch
   git apply ~/workspace/openclaw/patches/openclaw-gcp-adc.patch
   git apply ~/workspace/openclaw/patches/openclaw-failover-crash-fix.patch
   pnpm build
   ```

   If a patch fails (upstream changed the file), see Local Patches section
   in ks-openclaw/CLAUDE.md for manual fallback instructions.

6. Analyze gateway and security changes

   Before testing, thoroughly review what changed in gateway, subagent security,
   device pairing, and scope enforcement. These are the #1 source of post-upgrade breakage.

   ```bash
   # Find the merge-base (last commit before this upgrade)
   MERGE_BASE=$(git log --oneline -20 | grep -m1 'Merge\|fork:\|chore:' | awk '{print $1}')

   # Review gateway, auth, pairing, scope, and security changes
   git diff $MERGE_BASE..HEAD --stat -- \
     src/gateway/ src/devices/ src/pairing/ src/auth/ src/security/ \
     src/agents/spawn* src/agents/subagent* src/agents/operator* \
     src/routing/ src/channels/ src/infra/

   # Read the actual diffs for breaking changes
   git diff $MERGE_BASE..HEAD -- \
     src/gateway/ src/devices/ src/pairing/ src/auth/ src/security/ \
     src/agents/spawn* src/agents/subagent* src/agents/operator* \
     src/routing/ src/channels/ src/infra/ | head -500
   ```

   **What to look for:**
   - **Scope changes:** New required scopes in `resolveLeastPrivilegeOperatorScopesForMethod()` or
     scope validation. These break existing device pairings (devices must re-pair to get new scopes).
   - **Pairing hardening:** Changes to auto-approval logic, loopback trust, or silent pairing.
     Past issue: `silent: isLocalClient` changed to require `reason === "not-paired"`, breaking
     scope upgrades on loopback.
   - **Subagent security:** New restrictions on subagent spawn, queue dispatch, or operator permissions.
     These break multi-agent workflows silently (1008 websocket close, "pairing required" errors).
   - **Config schema changes:** New required fields, removed config keys, renamed options.
     These cause startup failures or silent behavior changes.
   - **Channel auth changes:** Token validation, webhook signature verification, or connection
     handshake changes that could break Telegram/Discord/web integrations.
   - **Rate limiting / abuse prevention:** New limits on API calls, message frequency, or
     concurrent connections that could affect normal agent operation.

   If breaking changes are found, document them and plan mitigations before proceeding.

7. Run tests and record results

   ```bash
   pnpm test 2>&1 | tail -20
   ```

   Note any new failures vs the pre-upgrade baseline from step 2.

8. Clean up runtime config

   Check `~/.openclaw/openclaw.json` for stale plugin references, removed features,
   or config keys that no longer exist. Past issue: redis-orchestrator was removed
   from source but left in runtime config, causing startup warnings.

9. Restart the gateway

   ```bash
   pkill -9 -f openclaw-gateway || true
   nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
   ```

10. Verify

```bash
sleep 5 && ss -ltnp | grep 18789
tail -30 /tmp/openclaw-gateway.log
```

- Check for startup warnings/errors in logs
- If subagent spawns fail with "pairing required":
  ```bash
  openclaw devices list
  openclaw devices approve <requestId>
  ```
- Test a multi-turn conversation with a thinking-enabled agent (Lucius) to verify thinking blocks work

11. Log the upgrade in `UPGRADE-LOG.md`

    Add an entry to `~/workspace/ks-openclaw/UPGRADE-LOG.md` with:
    - Date and upstream version/range
    - What changed (key commits, features, removals)
    - Issues encountered (with root cause, fix, and lesson for each)
    - Test results (pass/fail counts, any new failures)
    - Patch status (applied/survived/superseded)
    - Commits made during the upgrade

    **This is mandatory.** The upgrade log is how we avoid repeating mistakes.

## Important reminders

- **Deployment boundary:** Code lives in `~/workspace/ks-openclaw/`. The `openclaw` binary is symlinked here. `pnpm build` + gateway restart deploys changes. Never `git pull` in `~/workspace/openclaw/` expecting code changes.
- **Thinking block changes:** If the upgrade touches thinking block handling (preserveSignatures, sanitizeToolCallIds, stripThoughtSignatures), existing agent sessions may become incompatible. Test before deploying. If sessions break, archive the stuck session JSONL.
- **Gateway/security hardening:** The most common post-upgrade breakage is security tightening in gateway, pairing, or scope enforcement. Always do the step 6 analysis before testing — finding these in logs after restart wastes time.
- **Runtime config:** Always check `~/.openclaw/openclaw.json` for stale entries after removing plugins/features.
