# Contributing

Thanks for taking the time to contribute.

## Development loop

```bash
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
cargo build --release
```

CI runs exactly these commands; please make sure they pass locally first.

The dashboard is plain ES modules — no bundler, no npm. Edit `assets/js`,
`assets/css` or `templates/` and rebuild (`cargo build --release`); templates are
embedded into the binary at build time by `build.rs`.

## Pull requests

- Keep changes focused; one concern per PR.
- Add a test when you fix a bug (especially around SSE parsing, aggregation,
  auth, or DB migrations).
- Update `AGENTS.md` / `README.md` when behaviour or configuration changes.
- Do not commit `data/`, `dist/` tarballs, or local build artefacts.

## Reporting performance results

If you publish numbers produced with QuanHeng-Bench, include:

- QuanHeng-Bench version (visible in `/api/config`)
- endpoint type and model name
- concurrency levels, requests per level, `MAX_TOKENS`, prompt source
- whether tokens came from `usage` or the character estimate

Never benchmark third-party services without permission.

## Commit style

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`).

## Releasing

Releases are **semantic-version driven and tag-triggered**; nothing is generated from
commit counts, and the release workflow never pushes back to `main`.

```bash
# 1. bump the version (single source of truth for the image tag)
sed -i -E 's/^version = "[^"]+"/version = "0.3.1"/' Cargo.toml
cargo build --release            # refresh Cargo.lock
git add Cargo.toml Cargo.lock
git commit -m "chore: release v0.3.1"
git push origin main             # CI builds + pushes the multi-arch image

# 2. tag exactly the commit you verified, then release
git tag v0.3.1
git push origin v0.3.1
```

What each workflow does:

| Trigger | Workflow | Result |
|---|---|---|
| push / PR to `main` | `ci.yml` | fmt, clippy `-D warnings`, tests; on `main` also builds the image on native amd64 + arm64 runners and merges a multi-arch manifest at `ghcr.io/timemobius/quanheng-bench:v<Cargo version>` and `:latest` |
| push of a `v*` tag | `release.yml` | builds both offline tarballs via `build.sh`, then creates a GitHub Release with `quanheng-bench-<tag>-{amd64,arm64}.tar.gz` + `SHA256SUMS` |

Notes:

- The tag must start with `v`; it is compared against `Cargo.toml` (a mismatch only warns,
  but keep them equal so `docker pull …:v0.3.1` matches the release you tagged).
- `latest` tracks the head of `main`. Pin a version tag if you need reproducibility.
- Verify a release locally before announcing it:
  ```bash
  gh release download v0.3.1 --dir /tmp/rel && cd /tmp/rel && sha256sum -c SHA256SUMS
  ```
- Do not hand-edit `dist/使用手册.md`'s checksums or tag names without also bumping the
  version above; the manual tracks the current release.
