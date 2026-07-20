# Repository instructions

## Commands

- `npm ci` installs the exact dependency tree; use Node.js 24 (`.nvmrc`).
- `npm run lint` runs ESLint.
- `npm test` runs lint and all backend/static guardrail tests.
- `npm run coverage` enforces 90% lines, 70% branches, and 90% functions for `src/**`.
- `npm run test:e2e` runs the Playwright critical flows.
- `npm run test:scale` and `npm run test:fault` run the dedicated scale and recovery subsets.

## Active user decisions

- Ticket printing remains the console stub in `src/printer.js` until a printer product is selected. Do not add hardware or network printing implicitly.
- Treat `docs/audit-debito-tecnico-2026-07.md` as the technical-debt backlog and update its current-status section when closing findings.

## Testing

- Add or update tests for every behavior change. Run the smallest relevant test first, then `npm test` and `npm run coverage`.
- Run `npm run test:e2e` after frontend navigation, modal, retry, checkout, backup, or restore changes.
- Use temporary databases in tests. Never mutate `pos.sqlite` or its WAL/SHM files.
- Verify SQLite performance claims with `EXPLAIN QUERY PLAN` and the scale tests.

## Project structure

- `src/routes/` contains thin HTTP routers; domain logic belongs in the adjacent `src/products/`, `src/sales/`, `src/sessions/`, `src/carts/`, or `src/reporting/` modules.
- `src/schema.sql` is the canonical SQLite schema; `src/db.js` owns versioned migration, backup recovery, and restore canonicalization.
- `public/` is a dependency-free vanilla JavaScript SPA with no build step.
- `test/` contains `node:test` integration/unit tests; `test/e2e/` contains Playwright flows.

## Hard constraints

| Forbidden | Use instead |
|---|---|
| Floating-point monetary persistence | Integer cents with validation |
| Retrying a mutation with a new request ID | Persist and replay the exact idempotency key and payload |
| Trusting a restored schema or derived FTS tables | Canonicalize into the current schema and rebuild derived data |
| Holding SQLite statements across restore | Prepare statements when used against the current connection |
| Adding logic to already-large routers | Extract a focused domain/service module and keep architecture ratchets green |
| Binding outside loopback without authentication | Require `APP_PIN`; use HTTPS at the deployment boundary on untrusted networks |

## Working boundaries

- Preserve unrelated worktree changes and stage explicit paths.
- Do not raise architecture ratchets to fit new code; extract a focused module instead.
- Do not commit `pos.sqlite`, `pos.sqlite-wal`, `pos.sqlite-shm`, backups, or restore/migration markers.
- Keep historical sale snapshots immutable; product edits must not rewrite sold items.
- Keep comments concise and focused on invariants, hazards, or non-obvious intent.
