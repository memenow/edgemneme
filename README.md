# EdgeMneme

EdgeMneme is a Cloudflare-native project memory service for Codex, Claude Code,
subagents, multiple devices, and parallel worktrees. It exposes a remote
Streamable HTTP MCP endpoint while keeping D1 as the only authoritative store.
FTS, Vectorize, and immutable R2 Markdown snapshots are rebuildable projections.

An EdgeMneme project is a hard authorization boundary and may register multiple
repositories. Project memory is shared with every authorized repository in that
project. Repository memory is visible only to principals and sessions authorized
for that repository. Memory is never shared across projects.

## Status

The implementation includes the MCP contract, project and repository
authorization, repository-bound sessions and evidence, guarded formal-memory
commits, candidate review and session consolidation, hybrid FTS/Vectorize
retrieval and reranking, immutable R2 snapshots, durable recovery for dispatched
Workflow-backed outbox events, and a fail-closed scheduled GitHub reader. The
open-source repository keeps only non-deployable Wrangler templates. GitHub
Actions renders private deployment configuration from the protected
`production` environment.

The source is validated by strict type, test, coverage, migration, and Wrangler
bundle checks. A deployment requires provisioned Cloudflare resources, remote
migrations, Worker secrets, the isolated end-to-end synthetic canary, and the
quality gates in [Operations](docs/operations.md). GitHub synchronization remains disabled until
a separately approved credential and repository-access baseline are present.
The optional Claude conflict advisor is deliberately disabled and is never part
of the default deployment path.

## Architecture

- `memory-gateway` is the only public Worker. It authenticates a revocable
  project bearer token, creates a fresh `McpServer` for every request, serves
  `/mcp`, applies project and repository grants before reads or writes, accepts
  candidates, and dispatches formal changes to a project-scoped Durable Object.
- `memory-orchestrator` is the only Queue consumer. It owns the
  `ProjectCoordinator` Durable Object and `MemoryWorkflow`, commits formal
  changes through guarded D1 batches, and creates immutable R2 projections. Its
  one-minute maintenance pass reconciles dispatched ordinary outbox events even
  when Queue delivery reaches the dead-letter Queue before a Workflow starts.
  Unknown control-plane state is deferred without advancing a repair identity;
  explicit terminal failures may use the stable base Workflow ID plus three
  bounded repair IDs. Projection rebuilds retain a separate reconciliation
  protocol and immutable execution history.
- `github-sync` has only a six-hour UTC Scheduled Trigger. It is the only Worker
  that receives the GitHub credential, and its client permits only fixed-origin
  read requests. It verifies repository and owner numeric IDs, requires GitHub's
  token-expiration response header, and emits durable 14-, 7-, and 1-day expiry
  warnings without storing credential material. The 00:00 UTC poll reconciles
  every current tree even when its ref SHA is unchanged. Each successful pass
  atomically activates an immutable, checksummed D1 tree manifest; path deletions
  create bodyless maintainer-review items and never mutate formal memory. Safe
  text blobs no larger than 16 KiB become evidence-linked candidates. Secret, PII,
  prompt-transcript, raw-log, and sensitive-path inputs create only a bodyless
  tombstone with only a path digest in the manifest. Generated and binary blobs
  remain represented by excluded manifest entries. Larger text or an exhausted
  request budget fails the run with `GITHUB_PARTIAL_SYNC`; a failed staging
  manifest never advances the active head or synchronization cursor. Failed
  manifests and their immutable lifecycle events record only an enumerated code,
  timestamps, entry count, and checksum. After 30 days, fair scheduled retention
  removes entries in audited 500-entry transactions with persistent lane
  rotation and retry backoff, then atomically leaves a bodyless `purged`
  tombstone and terminal event. Complete and active manifests are never
  eligible.
- `claude-runner` is present as a disabled boundary only. It is not part of the
  default deployment path.

See [Architecture](docs/architecture.md), [MCP API](docs/mcp-api.md), and
[Security](docs/security.md).

The default model contract uses `@cf/zai-org/glm-5.2` for structured candidate
analysis and consolidation, `@cf/qwen/qwen3-embedding-0.6b` for 1,024-dimensional
embeddings, and `@cf/baai/bge-reranker-base` for reranking. Structured analysis
uses one forced GLM function call and has no silent model fallback. The model
receives server-generated opaque scope options instead of raw project or
repository IDs and must cite evidence bound to the selected option. A
single-repository claim may be proposed as reusable project memory, but that
proposal always requires maintainer review. Model output never grants access or
writes formal memory. It must pass local schema, scope, evidence, provenance, and
temporal checks before it can create a review candidate. Cloudflare advertises a
262,144-token GLM context window, while its Workers AI request path currently
enforces a 256,000-token combined input and requested-completion ceiling.
EdgeMneme assigns the largest safe completion allowance from that ceiling after
subtracting UTF-8 upper bounds for messages and the function contract plus fixed
chat-template overhead; it adds no smaller application output cap.

## Repository boundaries

- A project-wide principal can work across every registered repository in its
  project. A repository-scoped principal can open, submit to, close, search, and
  read memory only through an authorized repository context.
- A repository-bound search returns project memory plus memory from the
  authorized repository. Supplying `session_id` intersects search visibility
  with that session's repository.
- Project manifests and classification indexes represent the whole project and
  require a project-wide reader grant. Repository-scoped clients use authorized
  memory resources and search results instead.
- The model may recommend repository or project scope from trusted provenance,
  but only server validation and an authorized maintainer can promote a formal
  revision.
- Corrections, invalidations, and rollbacks derive repository ownership from the
  target memory. The gateway supplies that server-derived context to the project
  coordinator, which reloads and verifies it before writing target-bound
  evidence. Project-memory changes remain free of repository provenance.

All projects share one Cloudflare deployment, but project IDs, grants, D1
predicates, Vectorize namespaces, repository partitions, R2 prefixes, and
project-scoped Durable Objects provide logical isolation. This is not a separate
physical deployment per repository or project.

## Requirements

- Node.js 24 or later
- pnpm 10
- A Cloudflare account with Workers, D1, R2, Queues, Workflows, Vectorize, and
  Workers AI
- A separately approved, expiring GitHub PAT (classic) if private-repository
  sync is enabled

## Install and verify

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs strict TypeScript, Vitest, and a dry-run bundle for every
Worker. Local D1 migrations can be verified without contacting Cloudflare:

```bash
pnpm exec wrangler d1 migrations apply MEMORY_DB \
  --local --config wrangler/memory-gateway.jsonc
pnpm exec wrangler d1 migrations apply SEARCH_DB \
  --local --config wrangler/memory-gateway.jsonc
```

## Configuration

The committed Wrangler files contain non-deployable resource placeholders.
Never replace them in tracked files. `scripts/render-wrangler-config.mjs`
creates ignored, mode-`0600` configuration under `wrangler/.wrangler/` from the
GitHub `production` environment.

Configure these environment variables for deployment:

- `CF_D1_MEMORY_DATABASE_ID`
- `CF_D1_SEARCH_DATABASE_ID`
- `CF_RATE_LIMIT_NAMESPACE_EDGE`
- `CF_RATE_LIMIT_NAMESPACE_CLIENT`
- `CF_RATE_LIMIT_NAMESPACE_PRINCIPAL`
- `ENABLE_GITHUB_SYNC` (`false` until explicitly approved)
- `MEMORY_GATEWAY_PUBLIC_URL` (required HTTPS `/mcp` endpoint for the production canary)
- `MEMORY_GATEWAY_EXPECTED_HOST` (required hostname-only pin for the production canary)
- `MEMORY_GATEWAY_ALLOWED_ORIGINS` (optional comma-separated HTTPS origins)
- `MEMORY_GATEWAY_CUSTOM_DOMAIN` (optional route only; an empty value uses `workers.dev`)
- `SYNC_CREDENTIAL_VERSION` (required only when GitHub sync is enabled)

The public URL and expected host must identify the same endpoint. The expected
host remains required when `MEMORY_GATEWAY_CUSTOM_DOMAIN` is empty and the
gateway uses its `workers.dev` hostname. It is passed only to deployment
validation and the canary; the Wrangler renderer never treats it as a route.

Configure `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`TOKEN_DIGEST_PEPPER`, and `PAGE_TOKEN_HMAC_KEY` as protected environment
secrets. `GITHUB_CLASSIC_TOKEN` is required only for an approved GitHub sync
deployment. Never place secret values in tracked files, D1, R2, Queue messages,
logs, artifacts, or issue comments.

After rendering a deployment config locally, an operator can also rotate Worker
secrets interactively on an existing Worker:

```bash
pnpm exec wrangler secret put TOKEN_DIGEST_PEPPER \
  --config wrangler/.wrangler/memory-gateway.generated.jsonc
pnpm exec wrangler secret put PAGE_TOKEN_HMAC_KEY \
  --config wrangler/.wrangler/memory-gateway.generated.jsonc
pnpm exec wrangler secret put GITHUB_CLASSIC_TOKEN \
  --config wrangler/.wrangler/github-sync.generated.jsonc
```

The deploy workflow validates source templates, renders ignored configuration,
deploys `memory-orchestrator` before `memory-gateway`, and reconciles
`github-sync` to the explicit lifecycle gate. Enabling sync installs exactly one
six-hour Cron Trigger and its Worker secret. Disabling sync leaves an absent
Worker absent; an existing Worker is redeployed inert, stripped of Cron
Triggers, and stripped of its Cloudflare secret. Production D1 migrations use
the separate manual workflow and require the exact confirmation value `APPLY`.

Each device or agent receives a separate random project token. Store only its
HMAC digest in `principals.token_digest`; the plaintext token is shown once to
the operator and is never persisted by EdgeMneme.

## Project layout

```text
migrations/                  Authoritative and search D1 migrations
src/                         Shared contracts, security, storage, and projection logic
tests/                       Deterministic unit and security contract tests
workers/memory-gateway/      Public Streamable HTTP MCP Worker
workers/memory-orchestrator/ Queue, Workflow, and Durable Object Worker
workers/github-sync/         Scheduled-only GitHub reader
workers/claude-runner/       Disabled optional escalation boundary
wrangler/                    One source-of-truth configuration per Worker
.github/workflows/           Validation, deployment, and manual migration workflows
docs/                        Architecture, API, security, and operations
```

## Contributing

Keep real account and resource identifiers out of tracked files. Run
`pnpm check` before opening a change and update the relevant contract tests and
documentation when behavior changes.

## License

EdgeMneme is licensed under the GNU General Public License v3.0. See
[LICENSE](LICENSE).
