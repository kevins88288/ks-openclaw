# Upstream Changelog

Tracks new upstream commits vs local HEAD.

---

## 2026-03-19

**Upstream SHA:** `67da67b61a241efd63edb7153fc152fc01ec0ee7`
**Local HEAD SHA:** `06eacd86c82bfb454c668fa9bfe81db6c4818937`
**New upstream commits since last run (332 new, 864 total ahead of local HEAD):**

Notable new commits:

```
67da67b61a docs: fix tools nav A-Z, split plugin page, consolidate sandbox docs, add OpenShell page (#50055)
2661de384f Matrix: make onboarding status runtime-safe (#49995)
859889aae9 WhatsApp: stabilize inbound monitor and setup tests (#50007)
91d37ccfc3 fix(auth): lazy-load provider oauth helpers
6ebcd853be fix(plugin-sdk): isolate provider entry surfaces
089a43f5e8 fix(security): block build-tool and glibc env injection vectors in host exec sandbox (#49702)
f96ee99bbc Plugin SDK: harden provider auth seams
0ffcc308f2 Secrets: gate exec dry-run and preflight resolution behind --allow-exec (#49417)
2d3bcbfe08 CLI: skip exec SecretRef dry-run resolution unless explicitly allowed (#49322)
ef1346e503 Plugin SDK: route reply payload through public subpath
4b5487ee85 LINE: avoid runtime lookup during onboarding (#49960)
600f57c979 test: add architecture smell detector
... (332 new commits total — see git log bd21442f7e..upstream/main)
```

**Key themes:** Security: additional build-tool + glibc env injection vector blocking in host exec sandbox; auth seam hardening; exec SecretRef dry-run gated behind --allow-exec. Plugin SDK: continued public subpath routing for auth/providers/channels. Docs: major docs hub expansion (extensions, voice-call, provider pages). Matrix onboarding stability fix. WhatsApp inbound monitor stabilization.

**Security-relevant new commits:**

- `089a43f5e8` fix(security): block build-tool and glibc env injection vectors (#49702)
- `f96ee99bbc` Plugin SDK: harden provider auth seams
- `0ffcc308f2` Secrets: gate exec dry-run behind --allow-exec (#49417)
- `2d3bcbfe08` CLI: skip exec SecretRef dry-run unless explicitly allowed (#49322)

---

## 2026-03-18

**Upstream SHA:** `bd21442f7e606e1baf816ccf2e8fa8a4dc9bf9f4`
**Local HEAD SHA:** `03810195b38313a8659d29ae7c07b08098df79d8`
**New upstream commits since last run (268 total ahead of local HEAD):**

Notable new commits:

```
bd21442f7e Perf: add extension memory profiling command
af63b72901 Plugins: internalize nextcloud talk SDK imports
2f65ae1b80 fix: break Synology Chat plugin-sdk reexport cycle (#49281)
b31b681088 fix(zalouser): fix setup-only onboarding flow (#49219)
5a2a4abc12 CI: add built plugin singleton smoke (#48710)
a724bbce1a feat: add bundled Chutes extension (#49136)
ea15819ecf ACP: harden startup and move configured routing behind plugin seams (#48197)
f84a41dcb8 fix(security): block JVM, Python, and .NET env injection vectors in host exec sandbox (#49025)
2145eb5908 feat(mattermost): add retry logic and timeout handling for DM channel creation (#42398)
7b61b025ff fix(compaction): break safeguard cancel loop for sessions with no summarizable messages
6101c023bb fix(ui): restore control-ui query token compatibility (#43979)
916db21fe5 fix(ci): harden zizmor workflow diffing (+ image_generate tool added)
1eb810a5e3 Telegram: fix named-account DM topic session keys (#48773)
da34f81ce2 fix(secrets): scope message SecretRef resolution and harden doctor/status paths (#48728)
3aa4199ef0 agent: preemptive context overflow detection during tool loops (#29371)
f8bcfb9d73 feat(skills): preserve all skills in prompt via compact fallback before dropping (#47553)
6ba4d0ddc3 fix: remove orphaned tool_result blocks during compaction (#15691)
10ef58dd69 fix(whatsapp): restore implicit reply mentions for LID identities (#48494)
be2e6ca0f6 fix(macos): harden exec approval socket auth
be4fdb9222 feat: add bundled Chutes extension
... (268 total — see git log HEAD..upstream/main)
```

**Key themes:** Plugin SDK boundary hardening (internalized channel/provider imports), image generation capability added, security fixes (exec sandbox JVM/Python/.NET injection blocked, feishu webhook hardening), ACP startup hardening, compaction/context overflow fixes, Telegram DM topic session key fix, Mattermost DM retry logic.

---

## 2026-03-16

**Upstream SHA:** `4eee827dce6bb86e7f0c39a474da5d0aab517266`
**Local HEAD SHA:** `79ec53071c62855f07c668de4985a5b078a6f7a8`
**New upstream commits (134 total) ahead of local HEAD:**

```
4eee827dce Channels: use owned helper imports
8b001d6e4d Channels: move onboarding adapters into extensions
392ddb56e2 build(plugins): add bundled provider plugin manifests
4a0f72866b feat(plugins): move provider runtimes into bundled plugins
14137bef22 Plugins: clean stale bundled skill outputs
50a6902a9a Plugins: skip nested node_modules in bundled skills
1839bc0b1a Plugins: relocate bundled skill assets
b810e94a17 Commands: lazy-load non-interactive plugin provider runtime (#47593)
50c8934231 fix(dev): align gateway watch with tsdown wrapper (#47636)
5a7aba94a2 CLI: support package-manager installs from GitHub main (#47630)
3735156766 fix(ci): restore config baseline release-check output (#47629)
47fd8558cd fix(plugins): fix bundled plugin roots and skill assets (#47601)
7931f06c00 Plugins: harden context engine ownership
4fb0160309 Gateway: sync runtime post-build artifacts
b795ba1d02 Merge branch 'main' of https://github.com/openclaw/openclaw
... (134 commits total — see git log HEAD..upstream/main)
```

Note: Local branch is `fix/plugin-registry-divergence` (currently active).
