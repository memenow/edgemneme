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
Workflow-backed outbox events, and a fail-closed Workflow-backed GitHub reader. The
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
  Authenticated POST bodies are limited to 2 MiB of request-body bytes visible
  to the Worker and may use only the identity content coding before the MCP
  transport parses them.
- `memory-orchestrator` is the only Queue consumer. It owns the
  `ProjectCoordinator` Durable Object and `MemoryWorkflow`, commits formal
  changes through guarded D1 batches, and creates immutable R2 projections. Its
  one-minute maintenance pass reconciles dispatched ordinary outbox events even
  when Queue delivery reaches the dead-letter Queue before a Workflow starts.
  Unknown control-plane state is deferred without advancing a repair identity;
  explicit terminal failures may use the stable base Workflow ID plus three
  bounded repair IDs. Projection rebuilds retain a separate reconciliation
  protocol and immutable execution history.
- `github-sync` exposes no public route. Its six-hour UTC Scheduled Trigger only
  creates or recovers stable dispatch and retention Workflow instances. The
  dispatcher validates the credential and repository-access baseline,
  materializes every due ref as a durable D1 item, and creates bounded per-ref
  Workflow children in batches of at most 100. A D1 credential lane serializes
  PAT access across Workflow isolates with claim and epoch fencing. Access
  discovery is bounded to 900 GitHub requests; each ref attempt is independently
  bounded to 2,005 requests, 2,000 inspected text files, and 16 MiB of retrieved
  content. Every due ref is durably scheduled, but GitHub's shared PAT limits mean
  completion within the same six-hour slot is not guaranteed. The first due item
  for each ref on a UTC day performs a complete current-tree reconciliation, even
  when its child starts later or the midnight trigger was missed. Each successful
  pass atomically activates an immutable, checksummed D1 tree manifest. A
  pre-state witness and immutable final-state receipt bind activation to the
  claimed repository configuration, cursor, active head, ref, and synchronization
  run. Safe text blobs no larger than 16 KiB become evidence-linked candidates;
  secret, PII, prompt-transcript, raw-log, sensitive-path, generated, and binary
  inputs never become model content. Failed or partial work never advances the
  active head or cursor. Retention runs in a separate Workflow and purges eligible
  failed manifests after 30 days in audited, bounded transactions; it cannot undo
  or block a repository synchronization.
- Session consolidation freezes deterministic batch indexes under an owner,
  claim ID, and monotonic lease epoch. Each model batch runs in a separately
  named Workflow step, renews its lease before receipt recovery or execution,
  applies the sensitive-input gate to both individual and aggregate input, and commits its
  candidate artifacts plus an immutable receipt in one fenced D1 batch. Empty
  result batches also receive a receipt. Exact receipt recovery is the only
  accepted replay after an ambiguous D1 response, and consolidation cannot
  finish until the exact receipt coordinates and their frozen post-state are
  validated from a compact D1 summary. A 9,000-batch application cap reserves
  space below the pinned
  10,000-step Workflow limit and fails closed before AI without truncation.
  Frozen inputs permit at most one summary per consolidation, and the gateway
  writes it at order zero when present. The orchestrator reserves 1,500,000
  subrequests against a retry-aware minimum of 1,152,068 for the full admitted
  boundary.
- `claude-runner` is present as a disabled boundary only. It is not part of the
  default deployment path.

See [Architecture](docs/architecture.md), [MCP API](docs/mcp-api.md), and
[Security](docs/security.md).

The default model contract uses `@cf/zai-org/glm-5.2` for structured candidate
analysis and consolidation, `@cf/qwen/qwen3-embedding-0.6b` for 1,024-dimensional
embeddings, and `@cf/baai/bge-reranker-base` for reranking. Structured analysis
uses one forced GLM function call and has no silent model fallback. The model
receives server-generated opaque scope options instead of raw project or
repository IDs or refs and must cite evidence bound to the selected option. The
complete canonical candidate payload is scanned for sensitive content before
Workers AI is called. A
single-repository claim may be proposed as reusable project memory, but that
proposal always requires maintainer review. Model output never grants access or
writes formal memory. It must pass local schema, scope, evidence, provenance, and
temporal checks before it can create a review candidate. Cloudflare publishes a
262,144-token context window for GLM-5.2. EdgeMneme uses that context window as
the total request budget and assigns the largest safe completion allowance after
subtracting UTF-8 upper bounds for messages and the function contract plus fixed
chat-template overhead; it adds no smaller generation-token cap. Independently,
non-streaming function arguments have a 1 MiB transport and parse-safety limit.
After schema parsing, serialized UTF-8 JSON is limited to 256 KiB for candidate
analysis and 1 MiB for consolidation suggestions. These are byte limits, not
character estimates. Consolidation batch steps persist accepted results and
return no model payload to Workflow storage; even the maximum 9,000-entry batch
index result remains below Workflow's 1 MiB step-result limit.

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
- A Cloudflare Workers Paid account with D1, R2, Queues, Workflows, Vectorize,
  and Workers AI. The production contract requires Paid-plan GLM-5.2 access,
  10,000 Workflow steps, 1,500,000 orchestrator subrequests, and the configured
  CPU limit.
- A separately approved, expiring GitHub PAT (classic) if private-repository
  sync is enabled

The production `edgemneme-memory` Vectorize index uses exactly eight metadata
indexes. `model_generation`, `status`, `repository_partition`, `kind`,
`memory_class`, and `scope_key` are String indexes;
`valid_from_epoch_ms` and `valid_until_epoch_ms` are Number indexes. Project
isolation uses the Vectorize namespace, so `project_id` must not be a metadata
index. The fixed-width `scope_key` is a SHA-256 digest of the memory scope tuple,
which preserves exact filtering for public scope IDs up to 2,048 characters.
Unbounded validity is indexed with the JavaScript safe-integer minimum or
maximum so every semantic query can apply inclusive-start, exclusive-end time
filters before `topK`.

Create the metadata indexes before the first vector is inserted. When adding
them to an index that already contains vectors, rebuild every projection from
D1 and verify the backfill before serving the filtered semantic query path.
Project namespace names, active generation IDs, and internal repository IDs
must each fit within 64 UTF-8 bytes; runtime publication, query planning, and
rebuild preflight reject wider values. Each project consumes one Vectorize
namespace, so account plan namespace limits are a capacity boundary. The deploy
workflow creates only missing required indexes, fails closed on incompatible or
unexpected index drift, and completes the D1-authoritative rebuild before
deploying the public gateway.

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

Create a separate `production-rollback` environment for unattended recovery.
Restrict it to `main`, configure no required reviewers or wait timer, copy the
five `CF_*` identifiers plus `ENABLE_GITHUB_SYNC`, the conditional
`SYNC_CREDENTIAL_VERSION`, and both optional gateway routing values exactly.
Set `CF_ROLLBACK_ACCOUNT_ID` to the production account and
`UNATTENDED_ROLLBACK_ENABLED=true`. Store a separately issued,
account-scoped `CLOUDFLARE_ROLLBACK_API_TOKEN` as an environment-level secret;
do not inherit the normal deployment token into this environment. Production
capture emits only a SHA-256 configuration fingerprint. The rollback preflight
must match that fingerprint and read the captured Worker state with the
dedicated credential before deployment can continue.

The public URL and expected host must identify the same endpoint. The expected
host remains required when `MEMORY_GATEWAY_CUSTOM_DOMAIN` is empty and the
gateway uses its `workers.dev` hostname. It is passed only to deployment
validation and the canary; the Wrangler renderer never treats it as a route.

Configure `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`TOKEN_DIGEST_PEPPER`, and `PAGE_TOKEN_HMAC_KEY` as protected environment
secrets. `GITHUB_CLASSIC_TOKEN` is required only for an approved GitHub sync
deployment. Never place secret values in tracked files, D1, R2, Queue messages,
logs, artifacts, or issue comments.

After rendering a deployment config locally, an operator can rotate the gateway
secrets interactively on the existing gateway Worker:

```bash
pnpm exec wrangler secret put TOKEN_DIGEST_PEPPER \
  --config wrangler/.wrangler/memory-gateway.generated.jsonc
pnpm exec wrangler secret put PAGE_TOKEN_HMAC_KEY \
  --config wrangler/.wrangler/memory-gateway.generated.jsonc
```

Do not rotate `GITHUB_CLASSIC_TOKEN` with `wrangler secret put`. GitHub sync
binds every dispatch and recovery receipt to `SYNC_CREDENTIAL_VERSION`, so the
token and its new version must be promoted together through the drained
deployment procedure in the operations runbook.

The deploy workflow validates source templates, renders ignored configuration,
deploys `memory-orchestrator` before `memory-gateway`, and reconciles
`github-sync` to the explicit lifecycle gate. Enabling sync installs exactly one
six-hour Cron Trigger, three private Workflow definitions, and its Worker secret.
Disabling sync leaves an absent Worker absent. An existing Worker is first
redeployed inert with no Cron while retaining its secret. The workflow then
exhaustively drains Cloudflare Workflow instances. After proving the exact
disabled Worker, empty schedule, and no nonterminal GitHub Workflow, the
protected Action may reconcile only the GitHub synchronization ledgers through
bounded, receipt-verified D1 transactions. It rechecks the control plane after
every pass and requires two all-zero observations 60 seconds apart before
deleting the Worker secret. This operational writer cannot change formal memory.
Unknown, malformed, rate-limited, or drifting control-plane state fails closed.
Production D1 migrations use the separate manual workflow and require the exact
confirmation value `APPLY`.

The deployment and migration workflows share the workflow-level
`production-cloudflare` concurrency group with `queue: max`, so queued
production changes are retained up to the platform queue limit and run
serially. Queue order is not an ordering guarantee, so both workflows reject a
run whose source is no longer the current `main` commit before any production
mutation. Deployment first captures Worker state in an independent read-only
job, then revalidates that baseline immediately before each Worker lifecycle
mutation. The deploy job has a 240-minute ceiling with explicit bounds on its
long-running steps. An ordinary deployment failure or cancellation starts
rollback from the independent capture through the unattended
`production-rollback` environment. A GitHub force-cancel can bypass `always()`
rollback jobs; follow the manual roll-forward or recovery procedure in the
operations runbook in that case.

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
workers/github-sync/         Private Workflow-backed GitHub reader
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
