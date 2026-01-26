# Security Policy

If you believe you've found a security issue in Clawdbot, please report it privately.

## Reporting

- Email: `steipete@gmail.com`
- What to include: reproduction steps, impact assessment, and (if possible) a minimal PoC.

## Operational Guidance

For threat model + hardening guidance (including `clawdbot security audit --deep` and `--fix`), see:

- `https://docs.clawd.bot/gateway/security`

## Runtime Requirements

### Node.js Version

Clawdbot requires **Node.js 22.12.0 or later** (LTS). Keep Node updated for
security patches and compatibility fixes.

Verify your Node.js version:

```bash
node --version  # Should be v22.12.0 or later
```

### Docker Security

When running Clawdbot in Docker:

1. The official image runs as a non-root user (`node`) for reduced attack surface
2. Use `--read-only` when possible and provide a writable state volume
3. Limit container capabilities with `--cap-drop=ALL`

Example secure Docker run:

```bash
docker run --read-only --cap-drop=ALL \
  --tmpfs /tmp \
  -e CLAWDBOT_STATE_DIR=/data \
  -v clawdbot-data:/data \
  clawdbot/clawdbot:latest
```

## Security Scanning

This project uses `detect-secrets` for automated secret detection in CI/CD.
See `.detect-secrets.cfg` for configuration and `.secrets.baseline` for the baseline.

Run locally:

```bash
pip install detect-secrets==1.5.0
detect-secrets scan --baseline .secrets.baseline
```
