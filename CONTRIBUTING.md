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
