# EdgeMneme Repository Guide

## Runtime and dependencies

- This repository is one private ESM pnpm workspace. Use Node.js 24 or newer;
  CI uses Node.js 24. Use the pinned `pnpm@10.18.0` and pnpm only.
- Install with `pnpm install --frozen-lockfile`. Keep direct dependencies
  exact-pinned, keep `pnpm-lock.yaml` synchronized with dependency-resolution
  changes, and do not upgrade runtimes or Cloudflare packages incidentally.
- Keep root dependency-resolution settings in `pnpm-workspace.yaml`. Do not
  install project dependencies globally.
- No formatter or general lint script is configured. Do not claim those checks
  ran or substitute a global tool. Preserve the established TypeScript style:
  two spaces, double quotes, semicolons, multiline trailing commas, kebab-case
  filenames, camelCase values and functions, PascalCase types and classes, and
  SCREAMING_SNAKE_CASE constants.

## Architecture and ownership

- D1 is the sole authority. R2 Markdown, FTS, and Vectorize are rebuildable
  projections and must never become authorization or consistency sources.
- `workers/memory-gateway/` owns the only public `/mcp` Worker and its request,
  authentication, origin, and rate-limit boundary.
- `workers/memory-orchestrator/` owns the Queue consumer, `ProjectCoordinator`
  Durable Object, `MemoryWorkflow`, formal writes, recovery, and projection
  publication.
- `workers/github-sync/` owns the private scheduled GitHub reader and its
  Workflow entrypoints. Preserve its disabled-by-default credential and
  schedule gates.
- The directories under `src/` own the shared domain named by the directory:
  contracts, security, storage, gateway, GitHub synchronization, quality,
  search, projection, and workflows. Worker entrypoints may depend on these
  domains; shared domains must not depend on Worker entrypoints.
- Preserve the hard project boundary and normalized repository context across
  D1, Durable Objects, Queue and Workflow payloads, Vectorize namespaces, and
  R2 prefixes.
- `scripts/` owns Node.js operational CLIs. `.github/workflows/` owns CI and
  protected production orchestration. Do not extend the already oversized
  Worker, workflow, gateway, or indexing files with a new responsibility;
  split only at a real domain boundary with focused tests.

## Database and generated artifacts

- `migrations/NNNN_description.sql` is forward-only authoritative D1 history;
  `migrations/search/NNNN_description.sql` is rebuildable search D1 history.
  Append a four-digit migration. Never reorder or rewrite an applied migration,
  and use roll-forward recovery rather than down migrations.
- Tracked `wrangler/*.jsonc` files are non-deployable templates with public
  placeholders. Despite the `.jsonc` suffix, keep them valid strict JSON
  because the deployment renderer parses them with `JSON.parse`. Never put
  real resource IDs or secrets in them.
- `scripts/render-wrangler-config.mjs` exclusively owns ignored mode-0600 files
  under `wrangler/.wrangler/`. Never hand-edit or commit generated configs,
  secret files, `coverage/`, `dist/`, `node_modules/`, or `.gitnexus/` output.
- Keep Wrangler bindings, the matching Worker `Env` shape, runtime access,
  renderer tests, and dry-run bundles synchronized. Secrets belong in Worker
  secrets or protected GitHub environments, never vars, source, fixtures,
  logs, D1, R2, Queue or Workflow payloads, or model input.

## Tests and validation

- Node-runtime tests are `tests/**/*.test.ts`. Workers-runtime tests are
  `tests/**/*.worker.test.ts` and use `vitest.workers.config.ts`. Reusable
  quality fixtures belong under `tests/quality/`.
- Add a focused regression test for every behavior change. Migration, Wrangler,
  deployment, security, authorization, and repository-isolation changes also
  require the matching contract tests and relevant documentation updates.
- Run the smallest relevant command first, then affected suites, then the full
  gate:
  - `git diff --check`
  - `pnpm test -- tests/<name>.test.ts`
  - `pnpm exec vitest run --config vitest.workers.config.ts tests/<name>.worker.test.ts`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm test:coverage`
  - `pnpm test:workers`
  - `pnpm wrangler:check`
  - `pnpm check`
- `pnpm check` is the CI gate: strict TypeScript, the configured 80% Istanbul
  thresholds over explicitly covered critical modules, Workers-runtime tests,
  and Wrangler dry-run bundles for all four Workers. There is no separate
  build, lint, or format command.

## Code Review Rules

- Flag any path that advances a formal-memory head, GitHub synchronization
  cursor, active projection, or terminal Workflow state without the matching
  guarded D1 batch, immutable receipt, fence, or idempotent recovery proof.
- Flag any read, write, search, projection, or evidence path that trusts client,
  GitHub, FTS, or Vectorize metadata as tenant identity or omits the project ACL
  and server-resolved canonical repository context.
- In Cloudflare Workflow code, flag side effects or nondeterministic branch
  decisions outside deterministic steps unless repetition is explicitly safe.
  Queue and Workflow delivery can repeat, so the safe path uses stable IDs,
  bounded retries, fenced D1 receipts, and fail-closed handling of unknown
  control-plane state.
