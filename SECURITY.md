# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report privately to
the maintainers (open a GitHub Security Advisory, or email the address listed in
the repository profile) with:

- affected version (`/api/config` → `version`, or the container tag)
- reproduction steps and impact
- how the instance is exposed (loopback only, VPC, behind a reverse proxy)

You can expect an acknowledgement within 72 hours and a fix or mitigation plan
within 14 days for confirmed issues.

## Security model

QuanHeng-Bench is designed to run on a trusted network or behind an authenticating
reverse proxy. It ships **no authentication** on purpose — the API is meant to be
called directly by scripts and AI agents. Out of the box:

- it binds `0.0.0.0:3000`;
- the dashboard and every `/api/*` endpoint are **open** to anyone who can reach
  the port;
- `POST /api/run-test`, `/api/run-model` and `/api/cancel` trigger real load
  against the configured upstream — never expose them to untrusted users;
- CORS is disabled (same-origin only) unless `CORS_ORIGINS` is configured;
- responses carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`.

Recommended deployment:

1. keep port 3000 on loopback/VPC, or bind `HOST=127.0.0.1` and reverse-proxy it;
2. terminate TLS and authentication at that reverse proxy;
3. keep `CORS_ORIGINS` empty unless you really need cross-origin access.

## Supported versions

The latest minor release receives security fixes. Pre-1.0 releases may include
breaking changes between minors.
