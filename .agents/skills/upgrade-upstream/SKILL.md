# Upgrade Upstream — Safe Fork Merge Workflow

Merge upstream OpenClaw changes into the ks-openclaw fork safely, preserving local customizations.

## Context

- **Fork:** `ks-openclaw` at `/home/ubuntu/workspace/ks-openclaw/`
- **Fork remote:** `origin` → `github.com/kevins88288/ks-openclaw`
- **Upstream remote:** `upstream` → `github.com/openclaw/openclaw`
- **Running install:** `openclaw` binary symlinked from `ks-openclaw/openclaw.mjs`
- **Gateway:** Runs from this fork. Restart required after upgrade — will disconnect all agent sessions temporarily.

## ⚠️ CRITICAL RULES

1. **Do NOT restart the gateway** until explicitly told to. The upgrade is code-only until Kevin confirms restart.
2. **Evaluate end-state, not individual commits.** Upstream uses AI-assisted vibe coding with high commit volume (hundreds of commits between versions). Reviewing individual commits is noise and wastes tokens. Always review the final file state on `upstream/main` via `git show upstream/main:<file>`, never the commit history or `git log` for upstream.
3. **Never force-push to origin/main.** Always merge, never rebase public history.
4. **Preserve all fork-specific commits.** Our customizations must survive the merge.
5. **Predict conflicts before merging** with `git merge-tree --write-tree origin/main upstream/main 2>&1 | grep "CONFLICT\|Auto-merging"`.

---

## Phase 1: Reconnaissance

### 1.1 Fetch & Assess Scale

```bash
cd /home/ubuntu/workspace/ks-openclaw
git fetch upstream main
git fetch origin main

# How far behind are we?
echo "=== Commits behind upstream ==="
git log --oneline origin/main..upstream/main | wc -l

# What are our fork-only commits?
echo "=== Fork-only commits ==="
git log --oneline origin/main..HEAD

# What files do our fork commits touch?
echo "=== Fork-modified files ==="
git diff --name-only origin/main..HEAD
```

### 1.2 Identify Fork Customizations

For each fork-modified file, understand what we changed and why:

```bash
# Show our changes
git diff origin/main..HEAD -- <file>
```

Document each customization:

- **What:** What the change does
- **Why:** Why we need it (feature, bugfix, config)
- **Conflict risk:** Does upstream likely touch the same file/area?

### 1.3 Check for Upstream Overlap

For each fork-modified file, check if upstream also changed it:

```bash
# Did upstream touch the same files we did?
for file in $(git diff --name-only origin/main..HEAD); do
  if git diff --name-only origin/main..upstream/main | grep -q "^${file}$"; then
    echo "⚠️  CONFLICT RISK: $file (both fork and upstream modified)"
  else
    echo "✅ SAFE: $file (only fork modified)"
  fi
done
```

---

## Phase 2: Security & Quality Review of Upstream End-State

**Review the final state of code, not the diff.** Upstream uses vibe coding with AI agents — commit volume is noise.

### 2.1 Identify Security-Critical Changes

```bash
# What security-related files changed upstream?
git diff --name-only origin/main..upstream/main | grep -iE 'security|ssrf|sandbox|guard|sanitiz|auth|gateway' | grep -v test
```

### 2.2 Read Final State of Security Files

For each security-critical file identified above, read the **final version** on `upstream/main`:

```bash
git show upstream/main:<path-to-file>
```

Evaluate:

- [ ] Input validation present and correct?
- [ ] Path traversal protection (no `../` escape)?
- [ ] SSRF guards (private IP blocking, DNS rebinding)?
- [ ] Auth checks (rate limiting, token validation)?
- [ ] No hardcoded credentials or backdoors?
- [ ] Sanitization of user input before shell exec?

### 2.3 Review Dependency Changes

```bash
# What changed in package.json?
git diff origin/main..upstream/main -- package.json | grep -E '^\+.*"[a-z@]'

# Any new dependencies?
git diff origin/main..upstream/main -- package.json | grep '^\+' | grep -v '^\+\+\+'
```

### 2.4 Check for Suspicious Patterns

```bash
# Look for eval, exec, or dynamic require in new/changed files
git diff origin/main..upstream/main -- '*.ts' '*.js' | grep '^\+' | grep -iE 'eval\(|exec\(|execSync\(|require\(' | grep -v test | head -20

# Any new network calls to unexpected hosts?
git diff origin/main..upstream/main -- '*.ts' '*.js' | grep '^\+' | grep -iE 'fetch\(|axios|http\.request' | grep -v test | head -20
```

### 2.5 Generate Security Assessment

After review, write a brief assessment:

```
## Security Assessment — Upstream v<VERSION>

**Reviewed:** <date>
**Upstream version:** <version> (<commit>)
**Security-critical files reviewed:** <count>

### Findings
- [PASS/WARN/FAIL] SSRF protection
- [PASS/WARN/FAIL] Path traversal guards
- [PASS/WARN/FAIL] Auth/rate limiting
- [PASS/WARN/FAIL] Dependency changes
- [PASS/WARN/FAIL] No suspicious patterns

### Recommendation
[PROCEED / HOLD — explain if hold]
```

---

## Phase 3: Merge

### 3.1 Pre-Merge Backup

```bash
cd /home/ubuntu/workspace/ks-openclaw

# Record current state
echo "Pre-merge HEAD: $(git rev-parse HEAD)"
echo "Pre-merge branch: $(git branch --show-current)"

# Ensure working tree is clean
git status --short
# If dirty: stash or commit first. Do NOT proceed with uncommitted changes.
```

### 3.2 Merge Upstream

```bash
# Merge upstream into our fork (creates merge commit)
git merge upstream/main --no-edit
```

**If conflicts occur:**

For each conflicted file:

1. Check if it's a file we customized:
   - **Yes:** Keep our changes, integrate upstream changes around them
   - **No:** Accept upstream version

2. For fork-customized files with conflicts:

   ```bash
   # See what upstream changed in this file
   git show upstream/main:<file> > /tmp/upstream-version

   # See our version
   git show HEAD:<file> > /tmp/our-version

   # Understand both changes, then resolve manually
   ```

3. Resolution priority:
   - **Security fixes from upstream:** Always accept
   - **Our feature additions:** Reapply on top of upstream
   - **Our bugfixes already fixed upstream:** Drop ours, keep upstream
   - **Conflicting approaches:** Prefer upstream structure, reapply our feature logic

4. After resolving all conflicts:
   ```bash
   git add -A
   git merge --continue
   ```

### 3.3 Post-Merge Verification

```bash
# Verify our fork commits survived
git log --oneline --all --graph | head -30

# Verify our customized files still have our changes
for file in $(cat /tmp/fork-files.txt); do
  echo "=== Checking: $file ==="
  # Verify our customization is present
  git diff upstream/main..HEAD -- "$file"
done
```

---

## Phase 4: Build & Test

### 4.1 Install Dependencies

```bash
cd /home/ubuntu/workspace/ks-openclaw
pnpm install
```

### 4.2 Build

```bash
pnpm build
```

If build fails:

- Check if our fork customizations reference APIs that upstream renamed/removed
- Fix compatibility issues in our fork files
- Rebuild and verify

### 4.3 Run Tests

```bash
pnpm test
```

Focus on:

- Tests for our customized files (e.g., `src/providers/gcp-adc-token.test.ts`)
- Any tests touching files we modified

### 4.4 Verify Version

```bash
# Check the new version
node -e "console.log(require('./package.json').version)"
```

---

## Phase 5: Deploy (ONLY when Kevin says go)

### 5.1 Push to Fork

```bash
git push origin main
```

### 5.2 Gateway Restart

⚠️ **This will disconnect all agent sessions for 10-30 seconds.**

```bash
openclaw gateway restart
```

### 5.3 Verify

```bash
openclaw gateway status
openclaw --version
```

---

## Rollback Plan

If anything goes wrong after merge:

```bash
# Find the pre-merge commit
git reflog | head -10

# Reset to pre-merge state
git reset --hard <pre-merge-commit>

# Rebuild
pnpm install && pnpm build

# If gateway was restarted, restart again on old code
openclaw gateway restart
```

---

## Current Fork Customizations Registry

Keep this updated after each merge. These are the files we've modified from upstream:

### GCP ADC Authentication

| File                                   | Customization                                    | Conflict Risk   |
| -------------------------------------- | ------------------------------------------------ | --------------- |
| `src/providers/gcp-adc-token.ts`       | GCP ADC token auth for Vertex AI MaaS            | None (new file) |
| `src/providers/gcp-adc-token.test.ts`  | Tests for GCP ADC token                          | None (new file) |
| `src/agents/model-auth.ts`             | Integration of GCP ADC auth into model auth flow | LOW             |
| `src/agents/pi-embedded-runner/run.ts` | GCP ADC support in Pi runner                     | MEDIUM          |
| `src/config/types.models.ts`           | Added `gcp-adc` auth type                        | LOW             |
| `src/config/zod-schema.core.ts`        | Schema for `gcp-adc` auth type                   | MEDIUM          |
| `docs/gateway/configuration.md`        | Docs for GCP ADC configuration                   | LOW             |
| `package.json`                         | Added `google-auth-library` dependency           | MEDIUM          |

### Redis Orchestrator Extension

| File                                          | Customization                              | Conflict Risk  |
| --------------------------------------------- | ------------------------------------------ | -------------- |
| `extensions/redis-orchestrator/**` (33 files) | Job queue, approvals, learning, monitoring | None (new dir) |

### Core SDK — reaction_add Hook

| File                               | Customization                             | Conflict Risk |
| ---------------------------------- | ----------------------------------------- | ------------- |
| `src/plugins/types.ts`             | `reaction_add` plugin hook types          | HIGH          |
| `src/plugins/hooks.ts`             | `reaction_add` hook dispatch              | MEDIUM        |
| `src/discord/monitor/listeners.ts` | Discord reaction listener for plugin hook | MEDIUM        |
| `src/plugin-sdk/index.ts`          | Plugin type exports                       | MEDIUM        |

### Subagent Announce — suppressExternalDelivery

| File                                    | Customization                                  | Conflict Risk |
| --------------------------------------- | ---------------------------------------------- | ------------- |
| `src/agents/subagent-announce.ts`       | suppressExternalDelivery + user notification   | **HIGH**      |
| `src/agents/subagent-announce-queue.ts` | suppressExternalDelivery in queue item         | MEDIUM        |
| `src/agents/subagent-registry.ts`       | suppressExternalDelivery in run record + spawn | MEDIUM        |

### Mattermost Thread Routing

| File                                        | Customization                         | Conflict Risk |
| ------------------------------------------- | ------------------------------------- | ------------- |
| `extensions/mattermost/src/channel.ts`      | Thread routing via threadId parameter | LOW           |
| `extensions/mattermost/src/channel.test.ts` | Thread routing tests                  | MEDIUM        |

### Other

| File                                   | Customization                                  | Conflict Risk |
| -------------------------------------- | ---------------------------------------------- | ------------- |
| `src/agents/openclaw-tools.ts`         | messageTo/agentThreadId in plugin tool context | MEDIUM        |
| `src/gateway/server-methods/send.ts`   | threadId handling for sub-agent routing        | MEDIUM        |
| `src/gateway/protocol/schema/agent.ts` | Merged threadId doc comment                    | LOW           |
| `Dockerfile.sandbox`                   | rtk bind-mount comment                         | LOW           |

**Recurring HIGH conflict risk files** (flag every merge):

- `src/agents/subagent-announce.ts` — upstream refactors heavily each release
- `package.json` / `pnpm-lock.yaml` — always conflicts on deps/version

**Untracked fork files (not committed, copy separately):**

- `test-gcp-adc.mjs` — manual test script
- `test-vertex-maas-config.json5` — test config

---

## Post-Upgrade Checklist

- [ ] Upstream merged successfully
- [ ] Security review passed
- [ ] All fork customizations preserved
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes (or known failures documented)
- [ ] Version number updated
- [ ] Pushed to origin
- [ ] Gateway restarted (when Kevin confirms)
- [ ] Gateway status healthy
- [ ] Agent sessions reconnected
- [ ] Fork customization registry updated above
