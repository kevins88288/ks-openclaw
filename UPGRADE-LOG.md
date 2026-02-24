# Upgrade Log — ks-openclaw Fork

Track all upgrades and patch outcomes for Alfred's OpenClaw deployment.

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
