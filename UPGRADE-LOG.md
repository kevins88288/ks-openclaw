# Upgrade Log — ks-openclaw Fork

Track all upgrades and patch outcomes for Alfred's OpenClaw deployment.
For each upgrade, document: what changed, what broke, what we fixed, test results, and lessons learned.

---

## 2026-02-27 — Upstream merge (v2026.2.26 tail: Android/canvas cleanup + Discord thread bindings)

**Upstream range:** 11 commits merged (merge base `5c0255477` → `a7929abad`)
**Merge commit:** `ad16d2b44`
**Safety tag:** `pre-upgrade-2026.2.27`

### What changed

- Merged 11 upstream commits (10 planned + 1 new Discord thread bindings commit)
- 9 Android-only commits (no impact on Alfred's Linux deployment)
- 1 TypeScript fix: `src/media/mime.ts` — serve JS assets with `text/javascript` MIME type
- 1 Discord fix: thread bindings idle + max-age lifecycle (#27845)

### Conflicts resolved (2)

1. **`package.json`** — Kept our `google-auth-library` addition + upstream's grammy `^1.40.0` → `^1.40.1` bump
2. **`src/gateway/server-methods/send.ts`** — Kept both our `threadId` refactor and upstream's `buildOutboundSessionContext()` call

### Patch status

| Patch                                   | Status                                                                  | Action             |
| --------------------------------------- | ----------------------------------------------------------------------- | ------------------ |
| `openclaw-hook-runner-fix.patch`        | Fixed upstream (line 384 in `src/plugins/loader.ts`)                    | No re-apply needed |
| `openclaw-gcp-adc.patch`                | Already in merged code (line 237 in `zod-schema.core.ts`)               | No re-apply needed |
| `openclaw-failover-crash-fix.patch`     | Already in merged code (`isFailoverError` in `unhandled-rejections.ts`) | No re-apply needed |
| `openclaw-session-corruption-fix.patch` | Already in merged code (`session-tool-result-guard.ts`)                 | No re-apply needed |

### Test results

- **Build:** Clean (no TS errors)
- **Tests:** 13,763 passed, 10 failed, 3 pending (4,773 suites)
- 10 failures are pre-existing (timeout/config-dependent tests on this server)

### Post-deploy verification

- Gateway startup: clean (0 errors in log)
- Port 18789: listening
- Devices: all 4 paired and approved (no pending re-pair requests)
- Channels: all connected and working
  - Telegram: works (polling mode)
  - WhatsApp: connected
  - Discord (2 bots): works
  - Mattermost (9 bots): all connected
- Doctor migration suggestions: multi-account config migration for discord/mattermost/matrix (informational, run `openclaw doctor --fix` when ready)

### Notes

- All 4 patches from `~/workspace/openclaw/patches/` are now carried in the merged codebase — no manual patch application needed post-merge
- The delivery recovery queue had 39 deferred messages in backoff (expected — these will retry automatically)
- Discord cortex audit warning is pre-existing (channel permission issue)

---

## 2026-02-27 — Upstream merge + cherry-pick `689188994`

**Upstream range:** 10 commits merged (v2026.2.25 baseline)
**Strategy:** Drop redis-orchestrator, accept upstream announce pipeline (see `~/workspace/openclaw/UPGRADE-PLAN-2026.2.25.md`)

### What changed

- Cherry-picked `689188994` (upstream): fix Anthropic thinking block immutability
  - `sanitizeToolCallIds`: removed `isAnthropic` (was `isGoogle || isMistral || isAnthropic` -> `isGoogle || isMistral`)
  - `preserveSignatures`: changed from `false` -> `isAnthropic`
- Removed `redis-orchestrator` extension from source
- Removed `suppressExternalDelivery` from subagent announce pipeline
- Accepted upstream's refactored subagent announce pipeline

### Issues encountered

#### 1. Lucius session death loop (CRITICAL — required session reset)

**Symptom:** After gateway restart, Lucius returned empty responses to every message. 8 consecutive failures, including `/reset` command.

```
messages.11.content.1: thinking or redacted_thinking blocks in the latest assistant message cannot be modified
```

**Root cause (partially identified):** The cherry-pick changed `preserveSignatures` from `false` to `isAnthropic`. Before upgrade, thinking block signatures were stripped before sending (Anthropic never verified them). After upgrade, signatures were preserved — Anthropic started rejecting. The thinking blocks in the JSONL look clean (valid base64 signatures, no surrogates, correct structure). The exact mutation point between JSONL load and API call is still unidentified.

**Fix:** Archived the stuck session and restarted gateway.

```bash
mv ~/.openclaw/agents/lucius/sessions/39553337-...jsonl{,.bak}
```

**Lesson:** After any upgrade that changes thinking block handling, test with a multi-turn thinking session BEFORE deploying to production agents. Existing sessions may be incompatible when switching from signatures-stripped to signatures-preserved mode.

**Open investigation:** Exact reason Anthropic rejects needs further analysis. Suspect pi-ai serialization, field ordering, or content block pipeline mutation.

#### 2. Google Vertex thinking block immutability (code fix)

**Symptom:** Google Vertex (Gemini 2.5 Flash) also enforces thinking block immutability, but the cherry-pick only protected Anthropic.

**Fix:** Commit `2f23d3c29`:

- `preserveSignatures: isAnthropic || isGoogle`
- `sanitizeToolCallIds = isMistral` (removed `isGoogle`)
- Updated tests, test harness, transcript-hygiene docs

#### 3. Stale redis-orchestrator in runtime config

**Symptom:** Gateway startup warnings:

```
plugins.entries.redis-orchestrator: plugin not found (stale config entry ignored)
```

**Root cause:** Extension removed from source but `~/.openclaw/openclaw.json` still referenced it in `plugins.allow` and `plugins.entries`.

**Fix:** Removed both entries from `~/.openclaw/openclaw.json`.

**Lesson:** When removing a plugin/extension from source, also clean up runtime config. Add to upgrade checklist.

#### 4. Deployment boundary confusion

Initially tried `cd ~/workspace/openclaw && git pull` expecting code changes. The `openclaw` binary is symlinked to `ks-openclaw/openclaw.mjs` — code fixes only need `pnpm build` + gateway restart in `ks-openclaw/`.

**Fix:** Added deployment boundary docs to both `ks-openclaw/CLAUDE.md` and `openclaw/CLAUDE.md`.

#### 5. Pre-existing test failure (not upgrade-related)

`pi-embedded-runner.guard.test.ts` — "guardSessionManager integration persists synthetic toolResult" — already failing on `main` before changes.

### Test results

- `pnpm test` (agents): 2567 pass, 1 fail (pre-existing)
- `pnpm build`: clean
- transcript-policy tests: 7/7 pass

### Patches

| Patch                                   | Status                 |
| --------------------------------------- | ---------------------- |
| `openclaw-hook-runner-fix.patch`        | Survived merge         |
| `openclaw-gcp-adc.patch`                | Re-applied             |
| `openclaw-failover-crash-fix.patch`     | Survived merge         |
| `openclaw-session-corruption-fix.patch` | Superseded by upstream |

### Commits

- `2f23d3c29` — fix(agents): preserve Google Vertex thinking block immutability
- `6d7f62256` — fix(agents): preserve anthropic thinking blocks across retries (cherry-pick)

---

## Initial State (2026-02-24)

**Baseline:** Current deployed version with both patches applied.

**Patches Applied**
| Patch | Result | Notes |
|-------|--------|-------|
| openclaw-hook-runner-fix.patch | ✅ Applied | Fixes plugin registry cache-hit path |
| openclaw-gcp-adc.patch | ✅ Applied | Adds gcp-adc auth literal to zod schema |

**Status:** Patches applied, deployment stable. Ready for first structured upgrade.

### Post-Upgrade Checklist

- [x] Both patches applied cleanly
- [x] Plugin hooks firing (redis-events stream populating)
- [x] Gateway stable
- [ ] (Future upgrades: add checklist results here)

### Learnings

- Two local patches are required after every `git pull` — neither has been submitted upstream yet
- Patch re-application is manual; monitor upstream PRs for acceptance
