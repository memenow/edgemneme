# Operations

## Provisioning order

Resource creation, migrations, and the first deployment are explicit operator
gates. Normal source deployment can then run from the protected GitHub
`production` environment.

1. Create `MEMORY_DB` and `SEARCH_DB`; store their UUIDs as protected GitHub
   environment variables. Never edit the tracked Wrangler placeholders.
2. Create the private projection R2 bucket.
3. Create the Vectorize index with 1,024 dimensions and cosine distance. Before
   inserting any vector, create a string metadata index for
   `repository_partition`, wait for it to appear in the metadata-index list,
   and verify the selected embedding model returns exactly 1,024 values.

   ```bash
   pnpm exec wrangler vectorize create edgemneme-memory \
     --dimensions=1024 --metric=cosine
   pnpm exec wrangler vectorize create-metadata-index edgemneme-memory \
     --property-name=repository_partition --type=string
   pnpm exec wrangler vectorize list-metadata-index edgemneme-memory
   ```
4. Create the main Queue and dead-letter Queue.
5. Allocate three distinct positive rate-limit namespace IDs and store them as
   protected environment variables.
6. Configure the Cloudflare CI credential, account ID, gateway runtime secrets,
   and an explicit `ENABLE_GITHUB_SYNC=false` in the `production` environment.
7. Apply D1 migrations after creating a Time Travel bookmark and private export.
   Use the manual `Apply D1 Migrations` workflow and type `APPLY` exactly.
8. Deploy `memory-orchestrator`, then `memory-gateway`. Deploy `github-sync`
   only after its credential and access baseline are separately approved.
9. Insert an approved project, principals, grants, repositories, and GitHub
   access baseline.
10. Run one isolated `system.synthetic.<uuid>` canary before enabling real
    traffic.

The `repository_partition` metadata index is an authorization prefilter, not an
authority. Project memory is written with partition `*`; other memory is written
with its normalized repository ID. Every hit is still revalidated against D1.
Cloudflare does not retroactively add metadata to an index for vectors inserted
before a metadata index exists. If the Vectorize index already contains vectors,
create the metadata index and rebuild or re-upsert every vector from D1 before
serving search. See
[Cloudflare Vectorize metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/).

## Deployment and rollback

The deploy workflow runs `scripts/run-synthetic-canary.mjs`. The runner creates
an exact `system.synthetic.<uuid>` project and one-time principal, invokes
`scripts/synthetic-canary-client.mjs`, and removes the registered synthetic
records in a `finally` cleanup path. The canary separately verifies a
schema-valid GLM-5.2 Workers AI analysis and a deterministic maintainer-approved
formal revision. It then waits for projection completion, exercises FTS and
Vectorize through query-mode hybrid search, reads the checksummed R2 manifest,
and closes the session with CAS. Cleanup first claims a durable D1 admission
fence, derives exact Vectorize IDs and the exact R2 snapshot object set, removes
the FTS and per-memory projection head rows, and deletes authoritative D1 rows
child-first.
It fails if authoritative or search rows remain. Never persist or log the
one-time token.

Before any Worker deployment, the workflow queries both remote D1 bindings with
`wrangler d1 migrations list`. Deployment continues only when Wrangler confirms
that `MEMORY_DB` and `SEARCH_DB` each have no migrations to apply. A command
failure, pending migration, or unrecognized result blocks deployment. The gate
never applies a migration; use the separately confirmed migration workflow.
The workflow also requires exactly one `repository_partition` string metadata
index on Vectorize before it deploys the orchestrator. It also runs a read-only
projection rebuild plan with `--resume` and rejects work whose estimated
completion time exceeds 3,600 seconds. After the orchestrator deploys, the
workflow creates a fresh immutable rebuild execution with `--resume` and verifies
it with the same 3,600-second budget before it deploys the gateway. This deliberate
release gate reconstructs projections even when an unchanged target's previous
execution completed successfully.

A normal push to `main`, or a manual run with `bootstrap_expected_empty=false`,
requires both dedicated core Workers to exist. The workflow captures the current
single-version, 100-percent deployment for `memory-orchestrator` and
`memory-gateway` before changing either Worker. If either Worker is absent, the
run stops instead of inferring that this is a first deployment.

Use `bootstrap_expected_empty=true` only in a manual `workflow_dispatch` run and
only when both dedicated core Workers are expected to be absent. The workflow
confirms both absences through the Cloudflare API before deploying. The flag does
not authorize replacement or deletion of an existing Worker, and it is rejected
if either Worker exists. When GitHub synchronization is enabled for the same
bootstrap, the workflow also requires `github-sync` to be absent.

Every core deployment is tagged with the GitHub run and attempt; orchestrator
tags also carry the `edgemneme-ledger-` capability prefix. After a failed normal
deployment, the rollback job mutates a Worker only when its active version is
still exactly this run's tagged version and remains unchanged across a second
check. It handles the gateway before the orchestrator. Before rolling back the
orchestrator, it requires the latest run for every dispatched rebuild event to
be terminal, rejects any nonterminal projection rebuild run, and verifies that
the captured prior orchestrator has the ledger-capability tag. If either proof
fails, the job retains the current orchestrator and requires roll-forward rather
than exposing the Search database to an incompatible publisher.

Wrangler's version-list command exposes only the ten most recent versions, so
rollback does not use it. The workflow reads the single active version from the
current deployment and uses `wrangler versions view <version-id> --json` to
verify that exact version ID and this run's expected tag. It reads the captured
prior version by exact ID with the same command before checking its capability
tag. If either exact metadata proof is unavailable, automatic rollback fails
closed and requires reviewed manual roll-forward. Bootstrap has no prior version,
but it still proves the exact active version and run tag before deleting the
gateway or retaining the orchestrator.

Cloudflare rollback does not expose a conditional compare-and-swap operation.
The workflow performs a final active-version check immediately before rollback,
but repository concurrency cannot exclude an unrelated dashboard or API deploy
in the remaining control-plane window. Production change control must prohibit
external Worker deployments while this workflow is active; treat automatic
rollback as best effort and inspect any version mismatch before manual recovery.

A failed bootstrap has no prior core version to restore. When the newly created
gateway is still exactly this run's tagged version, the rollback job deletes it
and verifies that it is absent. It retains the bootstrap orchestrator and its
Durable Object state and requires a reviewed manual roll-forward. Do not rerun
bootstrap against this mixed state: either complete the missing gateway through
the reviewed deployment path or reconcile the retained orchestrator before
starting another automated deployment.

GitHub synchronization has its own captured deployment state. Before an enabled
release, the workflow records whether `github-sync` is absent, its exact active
version when present, and whether its Cron Trigger is enabled or disabled. The
enabled deployment carries a run-specific tag and must finish with exactly one
`0 */6 * * *` Cron Trigger and no secret binding other than exactly one
`GITHUB_CLASSIC_TOKEN`. If a
later release gate fails, rollback first verifies the active run tag. It restores
an existing Worker's exact prior version and Cron state, or deletes and verifies
the absence of a Worker that this run created from an absent state.

Setting `ENABLE_GITHUB_SYNC=false` is a one-way safety reconciliation for that
run. If `github-sync` is absent, the workflow leaves it absent. If it is present,
the workflow first deploys a runtime-disabled version with no Cron Triggers,
then deletes `GITHUB_CLASSIC_TOKEN` from Cloudflare through a JSON-null bulk
operation. It verifies both the empty schedule list and an empty Worker secret
list. A deletion or verification failure leaves the inert deployment
in place, fails the workflow, and never rolls back to an enabled version.

The cleanup plan derives the complete deterministic snapshot key set from D1 in
addition to reading the manifest. This permits exact-prefix cleanup if a
projection upload failed before manifest activation; it never lists or deletes
outside the registered synthetic project and project version.

Vectorize mutations are asynchronous. A projection Workflow does not write the
corresponding FTS rows or report completion until every exact vector ID is
readable through the bound Vectorize API. The check is bounded to five minutes;
failure leaves the authoritative revision unchanged and causes the Workflow
step to retry. The production canary allows seven minutes for the Workflow and
uses a wider bounded window when confirming both vector creation and deletion.

The seed operation also writes a durable cleanup registration with an expiry
exactly 23 hours after project creation. The orchestrator checks one expired
registration at the start of every one-minute scheduled invocation, before
dispatching outbox events. The janitor atomically claims a 30-minute cleanup
lease and sets an irreversible admission fence before it terminates and drains
nonterminal project Workflows. The coordinator, Queue consumer, outbox
dispatcher, Workflow entry and execution steps, and projection Workflow
creation all reject or no-op work for a fenced synthetic project. D1 triggers
also reject a raced formal project update, nonterminal Workflow row, or new
outbox event.

The janitor reads exact Vectorize IDs from `memory_fts_chunk_ledger` and durable
vector-cleanup receipts, validates each against its deterministic coordinates,
and derives bounded IDs from exact projection-deletion receipt coordinates. It
never scans FTS or authoritative content to reconstruct ownership. It verifies
asynchronous vector deletion before deleting projection heads; the ledger
cascade removes the owned FTS rows. It then verifies that FTS, heads, ledgers,
write leases, and both receipt tables are empty for the synthetic project.
Finally, it lists and deletes only the encoded project projection prefix in R2,
following every pagination cursor.
Synthetic GitHub credential-expiry warnings, credential state, and rate
observations are deleted before their exact access baseline, and authoritative
D1 rows and the registration are deleted child-first in one batch only after
every external projection is verified absent. A failed attempt releases only
its cleanup lease, retains the durable fence and registration, and records only
`SYNTHETIC_CLEANUP_FAILED`; the next scheduled invocation retries it without
admitting new work.

Never deploy `claude-runner` as part of a wildcard command.

The renderer reads these `production` environment variables:

```text
CF_D1_MEMORY_DATABASE_ID
CF_D1_SEARCH_DATABASE_ID
CF_RATE_LIMIT_NAMESPACE_EDGE
CF_RATE_LIMIT_NAMESPACE_CLIENT
CF_RATE_LIMIT_NAMESPACE_PRINCIPAL
ENABLE_GITHUB_SYNC
MEMORY_GATEWAY_ALLOWED_ORIGINS
MEMORY_GATEWAY_CUSTOM_DOMAIN
MEMORY_GATEWAY_EXPECTED_HOST
MEMORY_GATEWAY_PUBLIC_URL
SYNC_CREDENTIAL_VERSION
```

`MEMORY_GATEWAY_PUBLIC_URL` and the hostname-only
`MEMORY_GATEWAY_EXPECTED_HOST` are required for the isolated production canary
and must identify the same endpoint. The host pin remains required for a
`workers.dev` deployment; it is used only by pre-deployment validation and the
canary and is never rendered as a Worker route.

`SYNC_CREDENTIAL_VERSION` is required only when GitHub synchronization is
enabled. The origin list and custom domain are optional: an empty custom domain
uses `workers.dev`, while an empty origin list accepts non-browser MCP clients
but no browser origin. The deploy workflow masks resource identifiers, renders
only ignored files, performs a dry run, and removes temporary config and secret
files even after failure.

The protected environment secrets are:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
TOKEN_DIGEST_PEPPER
PAGE_TOKEN_HMAC_KEY
GITHUB_CLASSIC_TOKEN
```

After a successful disabled-state reconciliation, `GITHUB_CLASSIC_TOKEN` is
absent from the Cloudflare Worker. The workflow deliberately does not delete the
protected GitHub environment secret or revoke the credential at GitHub. After
the disabled deployment succeeds, an operator must delete that environment
secret and revoke the PAT through GitHub. Grant the
Cloudflare CI token only the permissions required by these Workers and
resources. The current `workers.dev` deployment requires an
[account-owned token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
limited to the target account with Workers Scripts Edit, D1 Edit, Workers R2
Storage Edit, Vectorize Edit, and Queues Edit. It requires no zone permission
and no Workers AI permission because model inference runs through a Worker
binding. The official
[GitHub Actions deployment path](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
does not currently provide a Cloudflare OIDC token exchange, and an exported
interactive Wrangler OAuth access token is not a renewable CI credential.
Create the CI token in the Cloudflare dashboard, give it an explicit expiration,
and store it only as the protected production environment secret.

Cloudflare's D1 SQL export rejects databases containing FTS5 virtual tables.
Before a `SEARCH_DB` migration, retain its Time Travel bookmark and create a
private R2 logical snapshot of `search_generations`, `memory_fts`, and
`memory_projection_heads`. When present, include `memory_fts_chunk_ledger`,
`memory_search_projection_write_leases`, `memory_search_projection_deletions`,
`memory_search_vector_cleanup_receipts`, and
`memory_search_vector_cleanup_janitor_state`. Validate each downloaded object
byte-for-byte. The search database remains a projection and must be rebuilt
from `MEMORY_DB` if a logical restore is insufficient.

For a fresh or partially migrated `SEARCH_DB`, presence-probe each of those
eight fixed table names before querying it. An absent table is represented by
an empty checksummed JSONL object and an authoritative row count of zero; never
issue a snapshot or count query against an absent table.

## Local validation

```bash
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:workers
pnpm wrangler:check
```

The top-level Wrangler CLI and the Workers Vitest pool are intentionally pinned
independently. Before changing either version, require both the local D1
migration command to exit cleanly and the Worker suite to accept every declared
compatibility date; a passing migration handler is not sufficient if the CLI
process remains alive after completion.

Validate D1 after every migration:

```sql
PRAGMA foreign_key_check;
PRAGMA quick_check;
```

## Repository-context migrations

Migration `0006_repository_scope_context.sql` establishes normalized repository
ownership. Apply it to `MEMORY_DB` before deploying code that reads the new
columns or context tables. Its preflight aborts instead of guessing when it
finds any of these conditions:

- one provider/external repository identity registered in multiple projects;
- a malformed project, repository, or session grant;
- session repository metadata that is malformed or references another project;
- existing repository-tagged evidence whose authority cannot be inferred;
- a project, repository, or session memory with invalid ownership; or
- an existing ref/worktree grant or memory that cannot be normalized from the
  earlier schema.

For supported existing rows, the migration copies session context and creates
normalized grant and memory context rows. If preflight fails, inspect the rows
and use a reviewed forward reconciliation migration. Do not disable the
preflight, invent provenance, or map an unknown row to project scope.

Apply the remaining authority migrations in this exact order:

1. `0007_repository_scope_hardening.sql` creates the persisted-session metadata
   validation view. Its preflight rejects ref or worktree metadata without a
   repository, malformed legacy JSON types, mismatches between normalized
   columns and legacy JSON, and conflicting `repository_ref`/`ref` aliases. It
   then guards session inserts and relevant updates against the same invalid
   states.
2. `0008_canonical_repository_scope_ownership.sql` materializes canonical,
   URI-component-encoded `ref_scope_id` and `worktree_scope_id` values on their
   source rows, backfills them, and adds project-scoped indexes. The stable
   ownership view reads those indexed values. Its preflight requires both valid
   session metadata and an exact match between every non-project grant or memory
   and its normalized repository context. This migration defines and validates
   canonical ownership; it does not install the mutation guards described next.
3. `0009_repository_scope_runtime_guards.sql` repeats both canonical preflight
   checks immediately before installing runtime protection. Its row-level
   maintenance triggers materialize canonical IDs only for the inserted or
   updated source row. Other guards create canonical context rows for new
   non-project grants and memories, reject noncanonical mutations, make formal
   memory scope identity immutable, prevent referenced ref sources from being
   updated, and prevent referenced ref or session sources from being deleted
   outside the bounded synthetic-cleanup path.

4. `0010_github_credential_expiry_and_repository_identity.sql` requires every
   enabled GitHub repository to have an expected positive numeric owner ID. It
   adds normalized credential-expiration state, immutable idempotent warning
   events, and per-repository synchronization leases. A missing legacy owner ID
   must be repaired from separately verified GitHub metadata before sync is
   enabled; never infer it from owner/name text.

5. `0011_github_tree_manifests.sql` adds staged and immutable complete tree
   manifests, per-path entries, stable deltas, the active ref head, and bodyless
   immutable failed/purge lifecycle events. Its triggers require staging-first
   construction, reject partial manifests at completion, and allow entry
   deletion only for bounded synthetic cleanup or the guarded 30-day
   failed-manifest retention transition.
   Deploy the compatible GitHub sync Worker only after this migration succeeds.
6. `0012_projection_rebuild_outbox_index.sql` adds the partial expression index
   used to find the first and latest immutable projection rebuild executions by
   target. Apply it before running the fan-out rebuild CLI or deploying the
   dispatcher that consumes `projection.rebuild.requested` events.
7. `0013_projection_rebuild_unknown_status.sql` adds the bounded control-plane
   unknown observation fields and extends the dispatched-rebuild reconciliation
   index to keep the nonterminal unknown sentinel eligible. Apply it before
   deploying an orchestrator that reads or writes those fields.
8. `0014_ordinary_workflow_reconciliation_index.sql` adds the partial expression
   index for dispatched, nonfailed ordinary Workflow-backed outbox events. It
   covers candidate submission and review, session consolidation, GitHub sync,
   and ordinary memory projection events, while explicitly excluding projection
   rebuilds. Apply it before deploying the ordinary Workflow reconciler.

Apply `0006` through `0014` before deploying the multi-repository Workers. If
any preflight fails, stop and reconcile the authoritative rows with a reviewed
forward migration before retrying; later migrations must not be applied out of
order or used to bypass an earlier failure.

Migration `migrations/search/0004_repository_partition.sql` adds the Search D1
partition column and requires it on new or updated projection heads. Existing
projection heads remain nullable after the expand step. Before enabling the new
search code, rebuild the search projection from authoritative D1 and require:

```sql
SELECT COUNT(*) AS missing_repository_partition
FROM memory_projection_heads
WHERE repository_partition IS NULL OR trim(repository_partition) = '';
```

The result must be zero. Do not manually derive partitions from FTS content.
Create and verify the Vectorize `repository_partition` metadata index before
re-upserting vectors.

Migration `migrations/search/0005_memory_fts_chunk_ledger.sql` requires an empty
legacy search projection and aborts if either `memory_fts` or
`memory_projection_heads` contains a row. Before applying it, pause formal
writes, inventory and delete the exact existing Vectorize IDs, verify their
absence, and then clear the rebuildable FTS and projection-head rows. Do not
bypass the guard or leave untracked vectors behind. The migration adds a
per-chunk ledger, an indexed `chunk_count` on each projection head, and durable
deletion and vector-cleanup receipts. It also requires every projection-head
insert or update to hold an exact, ephemeral write lease for the same atomic D1
batch. Ledger triggers bind every FTS row to its exact generation, project,
memory, revision, chunk, and Vectorize ID.

Retain the Time Travel bookmarks and logical snapshots, apply both search
migrations in order, run both database integrity checks, deploy compatible
Workers, rebuild projections, and then run the isolated synthetic canary before
restoring traffic. Once this migration is applied, a pre-ledger Worker fails
closed on projection writes. A Worker rollback is not a Search D1 schema
rollback; do not restore writes by deploying an older projection publisher.

## Projection rebuild

The rebuild utility emits independent `projection.rebuild.requested` outbox
events; it does not reuse the ordinary `memory.changed` event identity or
dispatch path. For each admitted project it derives these stable logical targets:

- one `snapshot` target for the project version, active memory count, total
  revision count, distinct active scope count, total UTF-8 revision bytes,
  ordered head digest, and active search generation;
- one `search` target for every current authoritative memory head; and
- one `delete` target for every active-generation search head whose memory ID no
  longer has an authoritative current head.

The utility loads projects, per-project capacity authority, authoritative memory
heads, and active-generation search ledger heads with stable keyset pagination.
Global reads use 500-row pages; `--project-id` uses an exact project predicate.
It does not use offsets or impose a fixed logical target cap. `MEMORY_DB` remains
the authority; the Search D1 read exists only to identify current projection
state and exact orphan cleanup. The utility never infers authority from R2,
Vectorize, or FTS5, and it does not apply migrations.

Render the private orchestrator config, pause formal writes, inspect the
read-only plan, and then enqueue and verify the remote rebuild:

```bash
node scripts/render-wrangler-config.mjs memory-orchestrator
pnpm projection:rebuild:plan --max-wait-seconds 3600
pnpm projection:rebuild:enqueue --max-wait-seconds 3600
pnpm projection:rebuild:verify --wait-seconds 3600
```

Use `--project-id <project-id>` on all three commands to rebuild one project.
The planner reports snapshot, search, delete, total, and pending counts. Its ETA
uses the dispatch bound of 250 projection events per minute plus a fixed
600-second settlement allowance. It also reports the global D1 enumeration
query count and elapsed seconds and includes that elapsed time in the total ETA.
The deployment workflow imposes a separate five-minute hard limit on the
read-only enumeration step. Read-only history and snapshot queries batch up to
250 logical targets, reducing a 10,001-target history scan from 201 remote CLI
calls to 41 while keeping each generated statement below D1's 100 KB limit.
`--max-wait-seconds` fails before enqueue when the completed plan estimate
exceeds the deployment budget. The enqueue command writes events in batches of
50 and checks every inserted or existing row against its
content-bound event ID, payload digest, project version, and logical target.

Plan and enqueue also query both headless cleanup-debt tables before reading
rebuild history. Enqueue repeats that release gate after its final authority
reload and immediately before the first outbox mutation. Verify runs the same
gate at the start of every poll. Any nonzero debt aborts immediately; cleanup
debt is not rebuild fan-out work and never contributes to the pending count or
the 250-events-per-minute ETA.

Before it reads rebuild history or writes an outbox event, the planner and
enqueue command reject any project with more than 16 MiB of authoritative
revision content or an estimated workload above the 45,000-subrequest safety
budget. The snapshot event identity and enqueue CAS bind all four capacity
values. The Workflow rereads and compares them before and after publication and
applies the same capacity calculation again.

The shared calculation is
`writes = memories + revisions + scopes + 29` and
`subrequests = 14 + 3 * (14 + 2 * writes)`. The 29 fixed writes are the
manifest, README, and fixed kind, class, and status indexes. Each write reserves
both an R2 `put` and collision `head`. Each attempt reserves 14 application
subrequests: two four-request authority checks plus the six fixed publication
requests. The leading 14 is a conservative Workflow control-plane reserve, and
the retry limit is three total attempts, including the initial attempt. The
configured Workflow subrequest limit is 50,000. A 10,000-memory project
necessarily exceeds the budget even at its minimum revision count and is rejected
deterministically after bounded enumeration and before any history query or
enqueue mutation. Resolve an oversized project instead of bypassing either
bound.

Every target binds exactly one active Search D1 generation. The initial event
uses `executionOrdinal=0`. Repeating an ordinary enqueue is a no-op for an
unchanged logical target because its immutable event ID is unchanged. A changed
project version, active generation, capacity authority, memory revision,
snapshot head set, or orphan search head produces a different logical target.
An empty authority database succeeds with zero events after the
single-active-generation check.

If the dispatcher or a projection Workflow failed after the initial enqueue,
repair the underlying service and explicitly create a new execution for each
selected logical target:

```bash
pnpm projection:rebuild:plan --resume --max-wait-seconds 3600
pnpm projection:rebuild:enqueue --resume --max-wait-seconds 3600
pnpm projection:rebuild:verify --wait-seconds 3600
```

`--resume` is rejected while the latest execution is nonterminal. Otherwise it
increments `executionOrdinal` and inserts a new immutable outbox row with a new
event ID; it never resets or overwrites the previous row or its attempt counter.
Resume applies to every target selected by the command, including a target whose
latest execution completed; the CLI does not expose an individual-target flag.
The new event receives a new Workflow ID. By contrast, an automatic dispatcher
retry of the same event keeps the same event ID and reuses the same Workflow.
Stable target identities, authority guards, and exact payload validation make
both paths fail closed when the source state changes.

The reconciliation pass observes dispatched rebuilds at five-minute intervals.
Twelve consecutive `unknown` results, unrecognized status values, or status-read
failures therefore represent approximately one hour of control-plane
uncertainty. At that threshold it sets
`last_error_code = 'PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN'` together with the
episode count and first, last, and alert timestamps. This sentinel is
nonterminal: `failed_at` remains `NULL`, reconciliation stays eligible, and no
new execution or repair identity is created solely because status is unknown.
The CLI continues to reject `--resume`, and the deployment rollback guard
continues to retain the current orchestrator while the execution may still be
running.

A documented Cloudflare nonterminal status (`queued`, `running`, `waiting`,
`waitingForPause`, or `paused`) clears the sentinel and every current unknown
episode field, including `projection_unknown_alerted_at`. A later episode must
accumulate twelve new observations before alerting. `complete`, `errored`, and
`terminated` continue through normal completion or bounded repair convergence;
an unknown or future status never clears evidence. Inspect active alerts with:

```sql
SELECT event_id, project_id, projection_unknown_count,
       projection_unknown_first_observed_at,
       projection_unknown_last_observed_at,
       projection_unknown_alerted_at, next_attempt_at
FROM outbox_events
WHERE event_type = 'projection.rebuild.requested'
  AND failed_at IS NULL
  AND last_error_code = 'PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN'
ORDER BY projection_unknown_alerted_at, event_id;
```

For each result, inspect the stable Workflow instance and Cloudflare control
plane. Do not clear the fields manually, use `--resume`, or roll back the
orchestrator while the sentinel remains; reconciliation clears a recovered
episode or records terminal convergence.

The snapshot Workflow rebuilds only the immutable R2 project projection. Each
search Workflow publishes one current memory head. It records every FTS row ID
and Vectorize ID in `memory_fts_chunk_ledger`, and commits the projection head
with the exact chunk count only after the expected vectors are observable. The
head write requires an exact ephemeral lease. When replacing a head, one Search
D1 batch creates the lease, preserves the old ledger coordinates as cleanup
receipts, removes the old ledger-owned FTS row IDs, writes the new head, ledger,
and FTS rows, and removes the lease. The publisher revalidates the new vectors
before it drains the old receipts.

A delete Workflow first claims the exact generation, project, memory, revision,
project version, and chunk count. It drains any earlier vector-cleanup receipts,
deletes and verifies the claimed vectors, and only then deletes the exact head.
The ledger cascade removes only the FTS row IDs owned by that head. A stale CAS
does not delete a newer projection, and a failed Vectorize operation leaves the
head, ledger, and receipts available for retry. Neither path discovers cleanup
work through an unbounded FTS scan.

The orchestrator's one-minute maintenance pass also processes at most one
vector-cleanup receipt owner and 50 receipts. It reuses the same ledger ownership
guard, deletes only vectors that are no longer published, verifies Vectorize
absence, and removes receipts only after confirmation. This bounded janitor
eventually drains cleanup coordinates left after a Workflow exhausts its retries;
a failed or malformed receipt remains durable and fails closed for investigation.
Each external deletion holder uses a fixed two-hour receipt claim while every
production Workflow step that can hold the claim has an explicit 15-minute
timeout; the scheduled handler has the same 15-minute platform bound. The holder
revalidates its token, expiration, ledger, and matching projection head before
deletion and again before verification and receipt finalization. An expired claim
can be reclaimed only after that execution bound makes the previous holder
ineligible to resume. Do not shorten the claim or move cleanup outside a bounded
Workflow step.

Malformed owners use durable receipt-local exponential backoff: one minute for
the first failure, doubling to a maximum of one hour with the attempt capped at
eight. Inspect `cleanup_attempt`, `cleanup_next_attempt_at`, and
`cleanup_last_error_code`; correct the underlying coordinate or Vectorize fault
instead of clearing those fields manually. A successful retry resets remaining
receipt backoff state, while deleting the receipts removes it naturally.

Verification requires all of the following for the latest execution of every
logical target:

- the exact immutable outbox event was dispatched and its Workflow is
  `complete`;
- the project's checksummed R2 snapshot is active at the target project
  version;
- the active search generation has the current revision, project version, and
  exact authoritative repository partition (`*` only for project-wide memory;
  otherwise the trusted `memory_repository_contexts.repository_id`), with a
  positive indexed `chunk_count`; and
- every `delete` target is absent from the active-generation search ledger; and
- the active generation has no headless rows in either
  `memory_search_vector_cleanup_receipts` or
  `memory_search_projection_deletions`.

Verification reads both cleanup tables through one fixed-result aggregate query
and never scans FTS5. A cleanup row is headless only when the same generation,
project, and memory owner has no `memory_projection_heads` row. Receipts that
still belong to an active head are excluded because that head's rebuild Workflow
drains them. Global verification includes headless debt for project IDs no
longer present in `MEMORY_DB`; `--project-id` limits this check to the admitted
project selected by that command. Any nonzero debt count keeps the release gate
closed immediately. Headless vector-cleanup receipts are owned by the scheduled
vector cleanup janitor; inspect their receipt-local backoff and underlying
Vectorize failure before rerunning if they do not drain. A headless
projection-deletion receipt has no automated owner. Keep formal writes paused,
inspect its exact generation, project, memory, revision, project version, and
chunk count, verify that no matching head, ledger row, FTS row, or vector
remains, and use a reviewed exact-owner recovery before rerunning. Never
bulk-delete either receipt table. Neither debt class has a rebuild ETA.
Global target enumeration also fails closed if an active-generation search head
belongs to a project outside the admitted `MEMORY_DB` authority set. A
project-scoped command remains isolated to the exact `--project-id` filter.

The verifier also reloads the active search generation and authoritative target
set before success. If a generation, memory head, or project version changes
during the run, enqueue a new rebuild instead of treating the stale projection
as complete. Keep formal writes paused until verification and the isolated
production canary both pass.

## Release gates

- promotion precision at least 0.95
- Precision@5 at least 0.90
- Recall@10 at least 0.95
- nDCG@10 at least 0.90
- abstention precision at least 0.95
- Chinese/English metric gap no more than 0.05
- evidence, revision, and checksum completeness exactly 1.00
- cross-project, invalidated, stale, or contested default leakage exactly zero
- metric degradation after 10x unrelated noise no more than 0.05

Local fakes do not validate remote AI, Vectorize, Queue concurrency, Workflow
restart behavior, D1 read replication, Cron delivery, or control-plane
permissions. Those checks belong to the isolated synthetic project.

## PAT rotation

1. Create a replacement PAT (classic) with the approved expiry and no scopes
   beyond the accepted baseline. EdgeMneme requires GitHub's successful `/user`
   response to include `GitHub-Authentication-Token-Expiration` in the exact
   `YYYY-MM-DD HH:mm:ss UTC` format.
2. Store it temporarily as `GITHUB_CLASSIC_TOKEN_NEXT`.
3. Run `/user`, full `/user/repos` pagination, numeric repository-ID, numeric
   owner-ID, expiration-header, and read-only metadata checks without ingesting
   content.
4. Pause synchronization if subject, scope, permission, or repository access
   expands.
5. Replace the active secret, update the credential version, and run one
   scheduled canary.
6. Revoke the old token immediately.

To retire GitHub synchronization instead of rotating it, set
`ENABLE_GITHUB_SYNC=false` and complete a deployment. Confirm that the workflow
verified an empty Cron schedule and no Cloudflare `GITHUB_CLASSIC_TOKEN`
binding. Then delete the protected GitHub environment secret and revoke the PAT
in GitHub. Do not remove or revoke the credential before the disabled-state
reconciliation has completed unless emergency revocation takes priority over a
clean control-plane transition.

The active credential version emits each 14-, 7-, and 1-day warning once. At or
after expiration, synchronization stops before repository enumeration. Missing
or malformed expiration headers also fail closed. Rotation must use a new
credential version; `GITHUB_CLASSIC_TOKEN_NEXT` does not change the read-only
endpoint allowlist or authorize broader scopes.

## Partial sync

`GITHUB_PARTIAL_SYNC` is fail-closed. Do not advance the completed cursor when a
tree is truncated, a blob or run limit is exceeded, rate limiting prevents a
complete pass, or repository identity changes. Resolve the condition, perform a
full tree reconciliation, and only then mark the cursor complete.

The GitHub client has a shared hard budget of 900 REST requests per scheduled
invocation and checks that budget before each network request. A tree may contain
at most 2,000 inspected text candidates and at most 16 MiB of retrieved content
per ref; generated and binary entries are recorded without blob retrieval.
Manifest entries are written with at most 500 rows and 256 KiB per JSON batch. Candidate evidence,
observations, links, and outbox events use at most 100 rows and 256 KiB per JSON
batch, avoiding per-file D1 statements. Budget exhaustion is explicit
`GITHUB_PARTIAL_SYNC`, not a successful prefix: the staged manifest becomes a
failed audit tombstone, no cursor advances, and the failure state contains no
repository body, path, or external error text.

After repository synchronization finishes, the manifest janitor uses the
scheduled UTC cutoff and stable `(project_id, manifest_id)` keyset ordering.
Separate D1 cursors for staging and failed lanes persist the last inspected
tuple. Each lane reads at most 100 raw rows across its forward and optional wrap
page, selects at most 25 eligible manifests, and applies a two-manifest
per-project quota. The cursor advances before processing, so even pre-claim
failures cannot pin the next Cron at the same lexical prefix. This bounded
keyset traversal provides eventual fairness over a finite static backlog, not
equal work for every project in each invocation. If maintenance deliberately
uses a smaller candidate limit, a leading project's backlog can delay a later
project by `O(backlog)` invocations, but the persisted cursor still reaches it.
A staging manifest remains untouched while its matching repository
synchronization run has a valid lease; an abandoned staging manifest becomes
`failed` with `GITHUB_RECONCILIATION_REQUIRED`. Synthetic projects remain owned
by the exact synthetic-cleanup workflow and are never selected here.

Failed entries remain available for diagnosis for 30 days. The janitor claims
eligible work with a monotonic retention attempt/version, a digest-only purge
token, and an expiring lease. A failed attempt stores its next eligible time
with exponential backoff from 12 hours through a seven-day ceiling. Each D1
transaction appends an immutable lifecycle event containing only the original
count/checksum plus the chunk count/digest, then deletes exactly that chunk of at
most 500 entries. Both statements recheck the project, token, attempt/version,
database clock, active head, and both delta directions. A later invocation can
take over an expired and due claim. Only an empty manifest atomically becomes a
bodyless `purged` row with its terminal event. One manifest's cleanup failure is
isolated from other manifests and cannot undo repository synchronization that
already completed. Repeated runs are idempotent. Complete manifests, active
heads, and delta-referenced manifests are excluded by both the query and D1
triggers; failed manifests cannot acquire deltas.

The memory-model input ceiling is 16 KiB per GitHub text blob. A safe blob at or
below that ceiling may become `clear` evidence. Text from 16 KiB plus one byte
through 64 KiB is retrieved but fails the run with `GITHUB_PARTIAL_SYNC`; text
larger than 64 KiB is rejected before blob retrieval. Size failures never create
tombstones. Bodyless tombstones are reserved for secret, PII, prompt-transcript,
raw-log, or sensitive-path findings that pass the size boundary.

The poller provides eventual repository snapshot consistency. With no webhook or
clone, worst-case freshness is six hours plus processing time, and a commit
created and made unreachable between polls may never be observed.
Every poll includes the verified configured default branch plus every explicit
tracked branch or tag; tracked refs never replace the default branch. If GitHub
reports a default branch different from `repositories.default_branch`, the
connector stops with `GITHUB_RECONCILIATION_REQUIRED`. A maintainer must review
the authority change, reconcile memories supported by the old default ref, and
update the configured branch before synchronization resumes.
Every 00:00 UTC invocation bypasses the ref ETag/SHA fast path and reconciles the
complete current tree. Force-pushes and ancestry gaps do the same immediately
and retain `history_gap_possible = 1`. Other six-hour polls may use conditional
requests. A repository lease rejects overlapping scheduled executions, including
different scheduled times; an abandoned lease becomes retryable after one hour
and its stale run is retained as failed audit state.

On a successful reconciliation, inspect `github_tree_manifest_deltas` for the
new manifest. Every deleted path has deterministic `repository_path_absent`
evidence, a bodyless `pending_review` observation, and a pending maintainer
review request. `analysis_json.affected_memory_ids` is the machine-readable list
of current formal memories whose evidence cited the absent path. Review those
memories through the normal correction or invalidation command; never update a
memory head from the synchronization connector.

To recover a partial run, first resolve the reported cause. Reduce configured
tracked refs or repository size when the bounded single-invocation reader cannot
complete, or exclude generated/binary artifacts through the checked-in content
policy. Retry a full reconciliation and verify that the replacement manifest is
`complete`, its checksum and entry count match, and `github_tree_ref_heads` plus
`sync_cursors.observed_sha` point to it. A failed staging manifest is immutable
audit state until its entry-retention window expires and must not be manually
promoted or used to patch the cursor. After retention, use the bodyless `purged`
row and synchronization-run audit for diagnosis; never reconstruct paths from
logs or external error text.

## Recovery

- D1 schema changes use expand, compatible code, backfill, and delayed contract.
  Never rely on a down migration after production data changes.
- Restore D1 using the pre-migration Time Travel bookmark or roll forward with a
  corrective migration.
- Migration `0004_synthetic_cleanup_registry_and_validity_preflight.sql` fails
  closed if existing observation or memory-revision validity intervals are
  non-ISO or chronologically reversed. Inspect and correct the invalid rows
  through an approved forward migration before retrying; do not bypass the
  preflight.
- Migration `0005_synthetic_cleanup_fence.sql` makes a claimed synthetic cleanup
  fence irreversible. If cleanup fails, repair the projection or control-plane
  dependency and let the janitor retry; never clear the fence to restore
  traffic to an expired synthetic project.
- Migration `0006_repository_scope_context.sql` creates normalized repository
  columns and context tables and backfills supported legacy rows.
- Migration `0007_repository_scope_hardening.sql` validates and guards the
  agreement between normalized session columns and persisted session metadata.
- Migration `0008_canonical_repository_scope_ownership.sql` materializes and
  indexes canonical ref/worktree scope IDs, exposes stable repository, session,
  ref, and worktree ownership, and fails closed on invalid existing grants or
  memories.
- Migration `0009_repository_scope_runtime_guards.sql` installs canonical
  creation, immutability, and referenced-source guards for runtime mutations.
  Repair invalid legacy provenance with an approved forward migration; never
  move a repository context across projects or bypass the migration order.
- Migration `0010_github_credential_expiry_and_repository_identity.sql` adds
  repository-owner identity checks, normalized PAT expiration observations,
  immutable warning events, and synchronization-run leases. Repair missing owner
  IDs through a reviewed forward migration and rotate to a new credential
  version if its observed expiration changes.
- Migration `0011_github_tree_manifests.sql` makes complete manifests, entries,
  deltas, active-head transitions, and bodyless retention lifecycle events
  authoritative. It retains a bodyless row and terminal event after the guarded
  30-day cleanup of failed entries. Never edit or delete a real manifest to
  recover a run; reconcile the current GitHub tree into a new manifest and
  activate it through the normal CAS path.
- Migration `0012_projection_rebuild_outbox_index.sql` indexes immutable rebuild
  execution history, deterministic ready-event dispatch, and bounded dispatched
  rebuild reconciliation. Do not rewrite old rebuild rows to recover an execution.
- Migration `0013_projection_rebuild_unknown_status.sql` adds the bounded
  control-plane unknown episode fields and keeps its nonterminal sentinel in the
  reconciliation index. Apply it before the compatible orchestrator; do not
  clear an alert manually or treat it as authorization to resume or roll back.
- Migration `0014_ordinary_workflow_reconciliation_index.sql` adds the bounded
  partial index used to recover dispatched ordinary events whose Queue delivery
  or Workflow execution did not converge. Projection rebuild events remain on
  their specialized indexes and recovery protocol.
- Search migration `0005_memory_fts_chunk_ledger.sql` fails closed while legacy
  FTS or projection-head rows remain. Clear only the rebuildable search
  projection through a controlled, exact-vector cleanup; never delete
  authoritative `MEMORY_DB` rows to satisfy this preflight. After migration,
  pre-ledger projection writers remain intentionally incompatible.
- Rebuild FTS, Vectorize, and R2 projections only from authoritative D1 rows.
- A normal rollback creates a new memory revision. Only an approved
  secret/compliance purge may remove sensitive body content, and it must leave a
  non-sensitive tombstone.

## Outbox recovery

The dispatcher retries with exponential backoff. After ten failed attempts it
sets `failed_at` and `last_error_code = 'OUTBOX_DISPATCH_FAILED'`; the event is
not silently discarded. Investigate the binding or downstream Workflow first.
After the cause is fixed, an operator may requeue one reviewed event by clearing
`failed_at`, `last_error_code`, and `next_attempt_at` and resetting `attempt` to
zero in an approved D1 write. This manual procedure does not apply to
`projection-rebuild:` events. Use `projection:rebuild:enqueue --resume` only
after the latest execution is terminal; it creates a new immutable row with the
next `executionOrdinal` and a new Workflow ID while preserving every prior row
and attempt counter. Never bulk-reset the outbox or change an existing payload.

Dispatching an ordinary event, Queue delivery, Workflow creation, and the D1
Workflow-run record are separate operations. A Queue message may therefore
reach the DLQ without creating a run even though its outbox row is already
marked dispatched. On each one-minute orchestrator invocation, the ordinary
reconciler reads at most 20 eligible rows through
`outbox_ordinary_workflow_reconcile`, ordered by next attempt, creation time, and
event ID. It covers `candidate.submitted`, `candidate.reviewed`,
`session.consolidation.requested`, `github.sync.requested`, and
`memory.changed`; it never selects `projection.rebuild.requested`.

A missing run starts the stable base Workflow. Known active status records
`WORKFLOW_RECONCILIATION_PENDING`; a status-read failure or unknown/future value
records `WORKFLOW_CONTROL_PLANE_UNKNOWN`. Both remain nonterminal and defer the
row for five minutes. Never advance a repair identity or mark an event failed
while the control-plane result is unknown. A `complete` control-plane result
guardedly creates or updates the matching `workflow_runs` completion before the
outbox records `WORKFLOW_COMPLETE`.

Only explicit `errored` or `terminated` status permits the next deterministic
repair identity. The sequence is the base ID followed by `repair-1`, `repair-2`,
and `repair-3`. If all four identities explicitly terminate unsuccessfully, the
row receives `failed_at` and `WORKFLOW_REPAIR_EXHAUSTED`. An invalid immutable
payload instead terminates with `WORKFLOW_RECONCILIATION_INVALID`; a synthetic
cleanup fence terminates the lane with `SYNTHETIC_CLEANUP_FENCED`. Repair the
root cause and preserve the row for audit rather than clearing these terminal
states in bulk.

Projection rebuild recovery remains independent. Its control-plane unknown
episode, specialized indexes, immutable execution ordinals, capacity checks,
and explicit `--resume` procedure are documented under
[Projection rebuild](#projection-rebuild).
