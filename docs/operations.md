# Operations

## Provisioning order

Resource creation, migrations, and the first deployment are explicit operator
gates. Normal source deployment then runs from Cloudflare Workers Builds on
every `main` push, with D1 migrations and recovery staying explicit local
operator commands. GitHub holds no Cloudflare credential or resource identifier.

1. Create `MEMORY_DB` and `SEARCH_DB`; store their UUIDs as Cloudflare build
   variables (and, for local runs, in the operator shell). Never edit the
   tracked Wrangler placeholders.
2. Create the private projection R2 bucket used by the runtime Workers.
3. Create a separate default-jurisdiction, backup-only R2 bucket for production
   D1 migration exports. Do not bind it to any Worker. Give it no custom domain,
   keep `r2.dev` disabled, and configure the exact lifecycle contract below.
   Store its name as `D1_MIGRATION_BACKUP_R2_BUCKET`; store an integer retention
   from 30 through 365 days as `D1_MIGRATION_BACKUP_RETENTION_DAYS`.
4. Create the Vectorize index with 1,024 dimensions and cosine distance. Before
   inserting any vector, create String metadata indexes for `model_generation`,
   `status`, `repository_partition`, `kind`, `memory_class`, and `scope_key`,
   plus Number metadata indexes for `valid_from_epoch_ms` and
   `valid_until_epoch_ms`. Do not create a `project_id` metadata index; the
   project boundary uses the Vectorize namespace. After each create command,
   wait for that index to appear in the metadata-index list before continuing.
   Verify the selected embedding model returns exactly 1,024 values.

   ```bash
   pnpm exec wrangler vectorize create edgemneme-memory \
     --dimensions=1024 --metric=cosine
   pnpm exec wrangler vectorize create-metadata-index edgemneme-memory \
     --property-name=model_generation --type=string
   pnpm exec wrangler vectorize list-metadata-index edgemneme-memory
   pnpm exec wrangler vectorize create-metadata-index edgemneme-memory \
     --property-name=status --type=string
   pnpm exec wrangler vectorize list-metadata-index edgemneme-memory
   pnpm exec wrangler vectorize create-metadata-index edgemneme-memory \
     --property-name=repository_partition --type=string
   pnpm exec wrangler vectorize create-metadata-index edgemneme-memory \
     --property-name=kind --type=string
   pnpm exec wrangler vectorize create-metadata-index edgemneme-memory \
     --property-name=memory_class --type=string
   pnpm exec wrangler vectorize create-metadata-index edgemneme-memory \
     --property-name=scope_key --type=string
   pnpm exec wrangler vectorize create-metadata-index edgemneme-memory \
     --property-name=valid_from_epoch_ms --type=number
   pnpm exec wrangler vectorize create-metadata-index edgemneme-memory \
     --property-name=valid_until_epoch_ms --type=number
   pnpm exec wrangler vectorize list-metadata-index edgemneme-memory
   ```
5. Create the main Queue and dead-letter Queue.
6. Allocate three distinct positive rate-limit namespace IDs and store them as
   Cloudflare build variables.
7. Connect each Worker to the repository in Workers Builds, configure the
   build-only variables, and set the gateway runtime secrets plus an explicit
   `ENABLE_GITHUB_SYNC=false` through the Cloudflare dashboard. See
   `Deployment and rollback` for the per-Worker build commands.
8. Apply D1 migrations from a local operator shell after creating a Time Travel
   bookmark and private export. Migrations never run from a push; follow the
   explicit local runbook in `Production D1 migration admission`.
9. Deploy `memory-orchestrator`, then `memory-gateway`. Keep `github-sync`
   disabled and without a Cron until its three Workflow entrypoints, credential,
   and repository-access baseline are separately verified.
10. Insert an approved project, principals, grants, repositories, and GitHub
   access baseline.
11. Run one isolated `system.synthetic.<uuid>` canary before enabling real
    traffic.

For a 90-day policy, set the bucket lifecycle from a reviewed temporary JSON
file with this exact deletion rule. For another admitted value, replace
`7776000` with `D1_MIGRATION_BACKUP_RETENTION_DAYS * 86400` before applying it.

```json
{
  "rules": [
    {
      "id": "edgemneme-d1-migration-backups-retention",
      "enabled": true,
      "conditions": {
        "prefix": "system/backups/d1-migrations/"
      },
      "deleteObjectsTransition": {
        "condition": {
          "type": "Age",
          "maxAge": 7776000
        }
      }
    }
  ]
}
```

Apply the complete lifecycle file with `wrangler r2 bucket lifecycle set` and
then inspect it with `wrangler r2 bucket lifecycle list`. The admission gate
allows non-deletion rules such as multipart-upload cleanup, but requires exactly
one enabled object-deletion rule and requires it to match the protected prefix,
ID, and retention exactly. It also queries the bucket, custom-domain list,
managed `r2.dev` state, and lifecycle through the Cloudflare API. Unknown,
malformed, inaccessible, public, missing, or drifting state blocks the migration
before the D1 export, and the same gate runs again immediately before the first
R2 upload. The gate scans every tracked Wrangler runtime template plus generated
runtime configs and rejects the backup bucket if any `r2_buckets` binding
references it. The maintenance admission separately enumerates every live
Worker script in the account, resolves the exact single 100% active deployment,
and reads that immutable version's `resources.bindings`. Any live R2 binding to
the backup bucket also blocks admission, including a renamed or otherwise
unrelated Worker that is not represented by the checked-out Wrangler files.
The migration run does not create the bucket, change public access, or repair
lifecycle state.

## Production D1 migration admission

The current production migration path is intentionally greenfield-only. This
revision has no durable maintenance epoch that every previously deployed
gateway request, Durable Object call, Queue delivery, Cron invocation, and
Workflow step reads and enforces before writing D1. Control-plane trigger removal
and two zero observations cannot close that gap: an old invocation can outlive
the observation window, and Queue metrics are documented as best-effort and
approximate. An account with any core Worker, core Workflow definition, or
production D1 rows therefore fails with
`MISSING_DURABLE_MAINTENANCE_FENCE`. Do not bypass that error by deleting a
trigger, terminating a Workflow, purging a Queue, or clearing a ledger.

The read-only admission CLI permits initial migration only when all three core
Workers are absent and exhaustive control-plane enumeration proves no gateway
workers.dev/preview URL, custom domain, zone route, or immutable active-version
service binding; no live Worker binding to the generated `MEMORY_DB` or
`SEARCH_DB` UUID; no live Worker binding to the protected backup R2 bucket; no
orchestrator or GitHub Cron; no Queue consumer or producer for the memory Queues;
no nonterminal core Workflow; zero approximate main/DLQ backlog; and no
MEMORY_DB or SEARCH_DB in-flight state. It validates paginated inventories,
cursor termination, unique identities, exact active versions, immutable version
resource shapes, primary D1 results, response-size bounds, and complete
consecutive `d1_migrations` prefixes. Worker settings are not binding authority:
the gate reads `result.resources.bindings` from the active immutable version and
revalidates the complete Worker inventory and active-version map after the
scan. For every application table, view, trigger, and named index, it also
compares canonical `sqlite_master.sql` against a local database built from the
checked-out migration prefix. Table columns, foreign keys, explicit index
columns, and structurally normalized SQLite automatic indexes must match that
reference exactly. A same-name object with changed DDL is not accepted. A 404
is accepted as absence only when the authoritative inventories also prove the
resource absent. Unknown, malformed, inaccessible, redirected, rate-limited,
duplicated, partially paginated, unresolved inherited, or drifting state fails
closed.

Each gate takes two identical observations 60 seconds apart. The pre-backup
gate records a canonical SHA-256 fingerprint; the post-backup gate repeats both
observations and requires the same fingerprint immediately before the first D1
write. The fingerprint includes every observed live Worker, its active version,
and the normalized binding inventory, including non-target bindings. SEARCH_DB
must be exact fresh or have the exact `0001` through `0004` schema and migration
records. If `0005_memory_fts_chunk_ledger.sql` is not yet installed, both
`memory_fts` and `memory_projection_heads` must be empty. The admission script
reports the required controlled projection cleanup and the operator stops; the
run never deletes those rebuildable rows.

Run the migration from a local operator shell on the current `main` commit.
Export the deployment variables plus backup provenance for the manifest:

```bash
export CF_D1_MEMORY_DATABASE_ID="..." CF_D1_SEARCH_DATABASE_ID="..."
export D1_MIGRATION_BACKUP_R2_BUCKET="..." D1_MIGRATION_BACKUP_RETENTION_DAYS="..."
export CLOUDFLARE_ACCOUNT_ID="..."
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
export GITHUB_SHA="$(git rev-parse HEAD)" GITHUB_RUN_ID="local-$(date -u +%Y%m%dT%H%M%SZ)"
export GITHUB_RUN_ATTEMPT="1"
node scripts/render-wrangler-config.mjs memory-orchestrator
node scripts/verify-d1-backup-bucket.mjs
```

Raw `wrangler` commands authenticate with `wrangler login`, but every helper
script that queries Cloudflare directly (`verify-d1-backup-bucket`,
`d1-maintenance-*`, `delete-worker-script`, `github-sync-quiescence`,
`gateway-deployment-target`) requires `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` in the environment. Read the token with `read -rs` so
it never lands in shell history.

Then capture the maintenance fingerprint, retain the Time Travel bookmarks and
the byte-verified private R2 export set, re-verify the fingerprint, and apply
SEARCH_DB first. Verify no pending Search migration, `PRAGMA quick_check`,
foreign keys, and the exact checked-out schema, then run two fresh stable
maintenance observations before applying MEMORY_DB. The run finally validates
both databases. If Search succeeds and Memory fails, or any later validation
fails, keep every ingress and producer disabled and roll forward; never reopen
an old writer or attempt an automatic paired Time Travel restore. Supporting an
in-place production upgrade requires a separate reviewed design for a durable
cross-version write fence and Queue generation or drain receipts. The migration
run never creates that fence or changes Cloudflare triggers.

The eight metadata indexes are query prefilters, not authority. The namespace
provides the project filter. `repository_partition` narrows authorization;
project memory is written with partition `*`, while other memory uses its
normalized repository ID. `model_generation`, `status`, `kind`, and
`memory_class` select the active semantic projection. `scope_key` is the
lowercase SHA-256 digest of the canonical scope tuple
`["edgemneme.vector.scope", scope, scope_id]`, so long scope IDs never rely on
Vectorize String truncation. Null `valid_from` and `valid_until` values map to
`Number.MIN_SAFE_INTEGER` and `Number.MAX_SAFE_INTEGER`; bounded values use
epoch milliseconds. Queries therefore apply `valid_from <= validAt` and
`valid_until > validAt` before `topK`.

Because Vectorize String indexes cover only the first 64 UTF-8 bytes, project
namespace names, active generation IDs, and internal repository IDs must each
fit within that bound. Runtime publication, query planning, and rebuild
enumeration fail closed on wider values. Each project consumes one namespace;
monitor the account's namespace capacity. Every hit is still revalidated
against D1 for ACL, current revision, taxonomy, scope, status, and validity.

Cloudflare does not retroactively add metadata to an index for vectors inserted
before a metadata index exists. If any required metadata index is added to a
Vectorize index that already contains vectors, keep the new filtered query path
disabled, create all eight indexes, and rebuild or re-upsert every vector from
D1. Verify the rebuild before allowing filtered queries. See
[Cloudflare Vectorize metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/).

## Deployment and rollback

Production deployment runs through Cloudflare Workers Builds: each Worker is
connected to this repository and builds on every `main` push. There is no
shared build queue across Workers and no automatic rollback. The operator is
the serializer: never start a second production change while one is in flight,
never merge code that depends on a not-yet-applied migration, and revalidate
that the checkout is the current `main` commit before any production mutation.
The databases cannot share an atomic transaction: after the first apply begins,
any failure leaves the system in maintenance and permits only the documented
roll-forward sequence.

Connect the repository to `edgemneme-memory-orchestrator`,
`edgemneme-memory-gateway`, and `edgemneme-github-sync` (disabled) with one
build configuration per Worker. Every Worker uses the repository root as its
root directory and the pinned Wrangler from `package.json`:

| Worker | Build command | Deploy command |
|---|---|---|
| `memory-orchestrator` | `pnpm install --frozen-lockfile --ignore-scripts && node scripts/render-wrangler-config.mjs memory-orchestrator` | `pnpm exec wrangler deploy --config wrangler/.wrangler/memory-orchestrator.generated.jsonc` |
| `memory-gateway` | `pnpm install --frozen-lockfile --ignore-scripts && node scripts/render-wrangler-config.mjs memory-gateway` | `pnpm exec wrangler deploy --config wrangler/.wrangler/memory-gateway.generated.jsonc` |
| `github-sync` | `pnpm install --frozen-lockfile --ignore-scripts && node scripts/render-wrangler-config.mjs github-sync` | `pnpm exec wrangler deploy --config wrangler/.wrangler/github-sync.generated.jsonc` |

Set the per-Worker build-only variables listed below, configure build watch
paths so each Worker rebuilds only for its own paths plus the shared
directories (`src/`, `workers/`, `wrangler/`, `scripts/`, `migrations/`,
`package.json`, `pnpm-lock.yaml`), and keep non-production branch builds
disabled. The dashboard Worker name must match the `name` in the rendered
configuration or the build fails. A failed build never mutates the live Worker;
fix forward with a new commit and inspect Build History before retrying.

For a local release instead of a push, export the same variables in an operator
shell, render with `node scripts/render-wrangler-config.mjs
memory-orchestrator memory-gateway github-sync`, and run the same
`wrangler deploy --config ...` commands in dependency order: orchestrator,
then gateway, then github-sync. Local `wrangler` commands authenticate with
`wrangler login`. Never deploy `claude-runner`; it is a disabled boundary and
is not connected to Builds.

Verify every release with the isolated synthetic canary. The operator derives
the HTTPS `/mcp` endpoint from the verified workers.dev hostname or custom
domain of the exact deployed 100-percent active gateway version, never from a
separately configured URL, and runs:

```bash
export EDGEMNEME_GATEWAY_URL="https://<verified-gateway-host>/mcp"
read -rs TOKEN_DIGEST_PEPPER && export TOKEN_DIGEST_PEPPER
node scripts/run-synthetic-canary.mjs
```

`GITHUB_OUTPUT=/tmp/edgemneme-canary-target node
scripts/gateway-deployment-target.mjs capture-canary-target <rendered-config>`
can derive the verified target into that file for scripting; it needs the
`CLOUDFLARE_*` environment above. The runner
creates an exact `system.synthetic.<uuid>` project and one-time principal,
invokes `scripts/synthetic-canary-client.mjs`, and removes the registered
synthetic records in a `finally` cleanup path. Its recoverable cleanup ledger
is refreshed from the project-scoped chunk ledger, projection-deletion
receipts, and vector-cleanup receipts before every retry. The runner verifies
every recorded Vectorize ID is absent before deleting the exact project's
Search D1 rows, then verifies FTS, projection heads, chunk ledgers, write
leases, both receipt tables, and any janitor cursor contain no reference to
that project. The canary separately verifies a schema-valid GLM-5.2 Workers AI
analysis and a deterministic maintainer-approved formal revision. It then waits
for projection completion, exercises FTS and Vectorize through query-mode
hybrid search, reads the checksummed R2 manifest, and closes the session with
CAS. Cleanup first claims a durable D1 admission fence, derives exact Vectorize
IDs and the exact R2 snapshot object set, removes and verifies the external
projections, and only then deletes authoritative D1 rows child-first. After
complete cross-store verification, it atomically renames the exact
identity-scoped cleanup ledger into a completion receipt. An interrupted
recovery can replay the retained ledger even after authority has already been
removed, while a missing ledger and receipt still fails closed. It fails if
authoritative or search rows remain. Never persist or log the one-time token.

Every canary request carries Cloudflare's
[version-override header](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/)
for that exact active version, and the gateway's
[version-metadata binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)
returns the actual executing version in a response header that the client
verifies. The initial readiness gate requires a stable consecutive-success
window because a recent deployment can take several seconds to become globally
available. A self-consistent URL and host variable therefore cannot redirect
the canary to another Worker or let an older deployment satisfy the release
gate. Recheck the active version and trigger after canary cleanup.

An ordinary code deployment must not change gateway routing. The rendered
`workers_dev`/custom-domain contract must exactly match the live remote trigger
state: no zone route, preview URL, additional custom domain, or wrong Worker
service. Perform an intentional routing change as a separate reviewed
control-plane operation with its own captured recovery plan, finish in exactly
one supported state, and verify the production endpoint before starting a code
deployment. Do not use a code deployment as an implicit trigger migration.

Before any release, the operator runs the pre-deploy checklist that Builds
cannot enforce. Query both remote D1 bindings with
`wrangler d1 migrations list` and continue only when Wrangler confirms that
`MEMORY_DB` and `SEARCH_DB` each have no migrations to apply. A command
failure, pending migration, or unrecognized result blocks the release; apply
migrations with the local migration runbook first. Verify Vectorize contains
exactly the six String and two Number metadata indexes listed above; create
only missing required indexes and poll their asynchronous creation. A wrong
type, duplicate, unexpected extra index, malformed control-plane response, or
readiness timeout blocks the release; never delete or replace an index. Run a
read-only projection rebuild plan with `--resume` and reject work whose
estimated completion time exceeds 3,600 seconds. After the orchestrator
deploys, create a fresh immutable rebuild execution with `--resume` and verify
it with the same 3,600-second budget before deploying the gateway. This
ordering creates the indexes first, re-upserts every current vector with
complete hard-filter metadata, and exposes the filtered query implementation
only after rebuild verification.

A normal release requires both dedicated core Workers to exist. Before
changing either Worker, record the current single-version, 100-percent
deployment ID for `memory-orchestrator` and `memory-gateway` with
`wrangler versions view <version-id> --json`; wrangler's version list exposes
only the ten most recent versions, so always pin exact version IDs. If either
Worker is absent, stop instead of inferring a first deployment, and follow the
bootstrap path below.

For a first deployment, create the Workers in dependency order and prove each
step. Deploy `memory-orchestrator` first and confirm its active version;
then deploy `memory-gateway` and confirm the exact workers.dev setting,
custom-domain ownership, and absence of zone routes before running the canary.
Keep `github-sync` disabled and absent until its entrypoints, credential, and
repository-access baseline are separately verified. A bootstrap has no prior
version to restore: if the gateway deploy fails, prove the exact active version
before deleting the Worker script with
`node scripts/delete-worker-script.mjs edgemneme-memory-gateway` (with the
`CLOUDFLARE_*` environment exported), and retain the orchestrator for a
reviewed roll-forward. Never rerun a bootstrap against a mixed state.

Tag local releases for traceability, for example
`wrangler deploy --tag "operator-<date>-<short-sha>-gateway"`. Rollback is an
explicit operator action per Worker: roll the gateway back before the
orchestrator from the Cloudflare dashboard, or redeploy the pinned prior
commit. Before rolling back the orchestrator, require the latest run for every
dispatched rebuild event to be terminal and reject any nonterminal projection
rebuild run. Cloudflare rollback does not expose a conditional compare-and-swap
operation, so re-read the exact active version immediately before the rollback
and prohibit any concurrent dashboard or API deploy while recovery is active.
Worker version rollback does not restore routes, custom domains, or
workers.dev settings; re-verify the complete gateway trigger after any
rollback and restore drifted trigger state as its own reviewed control-plane
operation.

Use the kept trigger tooling for gateway routing verification and recovery.
`node scripts/gateway-deployment-target.mjs verify-predeploy <config>`
validates the rendered trigger contract before a deploy;
`capture-canary-target` derives the verified canary endpoint;
`verify-canary-target` rechecks version and trigger after the canary; and
`capture-rollback-current` plus `restore` capture and restore a trigger
snapshot through the Cloudflare APIs. Restoration mutates only resources whose
service or route script is exactly `edgemneme-memory-gateway`; resources owned
by other scripts are retained. Any unknown ownership, unsupported response,
incomplete enumeration, or failed post-restore comparison fails closed.
Discovery exhaustively paginates the account-filtered zone list and reads the
route list for every zone; duplicate domain IDs or hostnames and duplicate
route IDs or patterns within a zone fail closed. This is a guarded
read-before-write protocol, not an atomic Cloudflare API CAS; prohibit
concurrent control-plane changes throughout recovery.

GitHub synchronization has its own deployment lifecycle. Before an enabled
release, record whether `github-sync` is absent, its exact active version when
present, and whether its Cron Trigger is enabled or disabled. The enabled
deployment must finish with exactly three approved Workflow definitions, one
`0 */6 * * *` Cron Trigger, no Queue binding, and no secret binding other than
exactly one `GITHUB_CLASSIC_TOKEN`. If a later release gate fails, first
quiesce scheduling, drain Workflow and D1 work, then restore the exact
Workflow-capable prior version and Cron state, or delete and verify the absence
of a Worker created from an absent state. A pre-Workflow direct-Cron version is
never a valid rollback target after migration `0019`.

Setting `ENABLE_GITHUB_SYNC=false` starts a fail-closed operator-run
reconciliation. If `github-sync` is absent, leave it absent. If present, first
deploy a runtime-disabled version with no Cron while retaining the PAT, then
exhaustively verify all six nonterminal states are empty for each of the exact
three Workflows. Only after that control plane is clear may the ledgers be
reconciled with the kept quiescence helper:

```bash
node scripts/github-sync-quiescence.mjs reconcile --config <rendered-config> \
  --disabled-version <exact-version-id> \
  --schedule-state clear --workflow-state clear
```

The helper needs the same `CLOUDFLARE_*` environment as the migration scripts.

It processes, in order, unbound dispatch items, bound repository runs and
items, unbound repository runs, closable dispatches, and credential lanes. It
finally requires two all-zero observations before the operator deletes the
Worker secret. Rerun the helper to resume from immutable receipts; never raise
its limits or claim an early clear.

The helper uses a fixed Cloudflare D1 REST origin, parameterized statements,
and 1 MiB encoded request and response body limits. Before any write, it
attests the complete receipt and transition-trigger schema, requires every D1
statement result to report primary service, and probes native numeric and null
parameter semantics. A pass handles at most 20 candidates in each phase, uses
at most 18 Cloudflare HTTP requests and 288 D1 statements, and keeps its
largest 60-statement mutation batch below the runtime's 64-statement bound.
Every transition is receipt-first or exact-CAS verified. Because the operator
has already proved that no GitHub Workflow is active, it may safely
terminalize an otherwise unexpired matching run or lane. It never reads or
writes formal memory revisions, heads, project versions, or audit chains; it is
a tightly scoped operational D1 writer, not another formal-memory authority.

Runtime-disabled state, the empty Cron list, and the exact active version are
rechecked after every helper result, including `pending`. A mutating pass
always reports `pending`; only an exact `clear` pass may count toward the two
consecutive all-zero observations. Observations are 60 seconds apart. The
helper's 18-request bound and this cadence leave headroom under Cloudflare's
[1,200 requests per five minutes Client API limit](https://developers.cloudflare.com/fundamentals/api/reference/limits/),
but they do not reserve that shared capacity. HTTP 429, any other unsuccessful
response, an unknown status, cursor cycle, version drift, or new work fails the
gate immediately; the lifecycle code does not silently retry a failed API
request. The D1 migration run is a separate read-only admission path and never
invokes this reconciliation writer.

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

The deployment renderer reads build-only variables. Set them per Worker in
the Cloudflare build settings (and export the same names for local runs):

```text
CF_D1_MEMORY_DATABASE_ID          # all three Workers
CF_D1_SEARCH_DATABASE_ID          # orchestrator and gateway
CF_RATE_LIMIT_NAMESPACE_EDGE      # gateway
CF_RATE_LIMIT_NAMESPACE_CLIENT    # gateway
CF_RATE_LIMIT_NAMESPACE_PRINCIPAL # gateway
MEMORY_GATEWAY_ALLOWED_ORIGINS    # gateway, optional
MEMORY_GATEWAY_CUSTOM_DOMAIN      # gateway, optional
ENABLE_GITHUB_SYNC                # github-sync, exactly true or false
SYNC_CREDENTIAL_VERSION           # github-sync, required only when enabled
```

`D1_MIGRATION_BACKUP_R2_BUCKET` and `D1_MIGRATION_BACKUP_RETENTION_DAYS` are
local-only migration variables; Builds never reads them. A gateway URL or host
variable is neither read nor accepted as canary authority; the operator derives
both values from the verified Cloudflare trigger state.

`SYNC_CREDENTIAL_VERSION` is required only when GitHub synchronization is
enabled. The origin list and custom domain are optional: an empty custom domain
uses `workers.dev`, while an empty origin list accepts non-browser MCP clients
but no browser origin. The renderer writes only ignored files; builds and local
runs must remove temporary config and secret files even after failure.

The gateway accepts at most 2,097,152 request-body bytes visible to the Worker in
one authenticated `POST /mcp` body. For requests that reach the Worker, it counts
the delivered stream even when `Content-Length` is absent or inconsistent and
accepts only an absent or identity `Content-Encoding`. Worker-level malformed
length, unsupported encoding, and oversized-body rejections use HTTP 400, 415,
and 413 respectively as non-cacheable JSON-RPC transport errors. Cloudflare may
reject malformed framing or headers earlier with a platform 4xx response. A
Worker-generated 413 has no `Retry-After`; reduce or split the request instead of
retrying the same payload. Include live-ingress exact-limit and over-limit
requests in gateway validation after changing the Worker runtime or MCP
transport dependency; direct `Request` unit tests do not validate edge framing.

The dashboard Worker secrets are:

```text
TOKEN_DIGEST_PEPPER   # memory-gateway
PAGE_TOKEN_HMAC_KEY   # memory-gateway
GITHUB_CLASSIC_TOKEN  # github-sync, only when sync is enabled
```

After a successful disabled-state reconciliation, `GITHUB_CLASSIC_TOKEN` is
absent from the Cloudflare Worker. The operator must then delete the dashboard
Worker secret and revoke the PAT through GitHub. Grant the Cloudflare API token
used by Builds and local runs only the permissions required by these Workers
and resources: an
[account-owned token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
limited to the target account with Workers Scripts Write, D1 Write, Workers R2
Storage Write, Vectorize Write, Queues Write, Zone Read, and Workers Routes Read.
Workers Routes Edit is required only for the operator performing gateway
trigger changes. The expected-absent Worker cleanup uses the direct
[Workers Scripts delete API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/)
after the version and detached-trigger checks; it does not enumerate
or mutate unrelated KV namespaces, and it does not set Cloudflare's `force`
option, so an unexpected incoming Worker, Durable Object, or tail reference
blocks deletion. The trigger tooling uses the official
[Workers domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/),
[Workers routes](https://developers.cloudflare.com/api/resources/workers/subresources/routes/),
and [per-script workers.dev](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/)
APIs. The token requires no Workers AI permission because model inference runs
through a Worker binding. Prefer `wrangler login` for local runs; when a stored
token is needed, create it in the Cloudflare dashboard, give it an explicit
expiration, and keep it outside the repository.

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
   manifests, per-path entries, stable added/changed/deleted/withdrawn deltas,
   the active ref head, and bodyless immutable failed/purge lifecycle events.
   Its triggers require staging-first construction, prove every delta against
   its old and new entries, reject partial manifests at completion, and allow
   entry deletion only for bounded synthetic cleanup or the guarded 30-day
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
9. `0015_github_sync_default_branch.sql` fails closed when an enabled GitHub
   repository lacks a runtime-valid default branch. It rejects null, empty,
   malformed, whitespace-padded, or control-character-containing values and
   installs equivalent insert and update guards. Reconcile the reviewed default
   branch before enabling synchronization or deploying the scheduled connector.
10. `0016_consolidation_lease.sql` adds exclusive owner and expiration fields for
    session-consolidation leases, an operation-witness field, a
    safe-integer lease epoch, and an index for running lease expiration. This is
    a pure expand migration: it does not backfill rows or install lease-state
    contract triggers. Apply it before deploying the compatible orchestrator.
11. `0017_github_sync_activation_receipts.sql` preflights active-head versions,
    adds monotonic repository-configuration and cursor versions, snapshots the
    selected ref, head, configuration, and cursor in new synchronization-run
    claims, and adds immutable activation witnesses and receipts. Its guards
    preserve legacy run rows under claim contract `0`, require complete claims
    for new contract `1` runs, and prevent production cursor, run, witness, or
    receipt deletion. Apply it before deploying the receipt-aware GitHub sync
    Worker.
12. `0018_consolidation_batch_receipts.sql` is the delayed consolidation
    contract migration. It refuses cutover while any legacy consolidation is
    running or retains lease state, adds the Workflow-generated claim ID,
    installs the lease-state contract guards, and creates immutable per-batch
    receipts. Apply it only after every pre-`0018` consolidation Workflow has
    drained and before deploying the receipt-aware orchestrator.
13. `0019_github_sync_workflows.sql` establishes the Workflow execution
    contract. It freezes every due ref in a dispatch item, persists dispatcher
    and per-ref GitHub request counts, adds immutable materialization receipts,
    adds the credential lane and immutable release receipts, and adds immutable
    no-run rejection and claimed-run finish receipts. Its final
    synthetic cleanup guard preserves every earlier child table. This is a
    prelaunch contract cutover, not a dual-write migration: quiesce the old
    connector, drain every Workflow and D1 run, apply the migration, and deploy
    the exact three-Workflow runtime before installing the Cron.
14. `0020_consolidation_input_shape.sql` preflights every frozen consolidation
    input and requires at most one summary per consolidation. It installs the
    equivalent D1 insert guard and partial unique index. Apply it before relying
    on the bounded consolidation subrequest calculation.
15. `0021_github_annotated_tag_request_budget.sql` adds a persisted overflow
    counter that may advance only while a dispatch item remains `running`, only
    after its base request counter reaches exactly `2,005`, and by at most eight.
    Apply it before deploying the runtime that performs bounded annotated-tag
    peeling and enforces the final `2,013` per-ref request ceiling.

Apply `0006` through `0021` before deploying the multi-repository Workers. If
any preflight fails, stop and reconcile the authoritative rows with a reviewed
forward migration before retrying; later migrations must not be applied out of
order or used to bypass an earlier failure.

Migration `0016` is intentionally migration-first and compatible with the
earlier schema contract. Before deploying the lease-aware orchestrator, stop old
writers from starting consolidations and drain their running Workflows. A legacy
row left in `running` with a null owner or expiration fails closed under the new
worker and cannot be reclaimed as an expired lease. Reconcile any such row with
a reviewed forward operation; do not invent an owner, epoch, or expiration. The
compatible runtime claims queued, failed, or expired lease-bearing rows with an
owner-and-epoch fence. Migration `0018` completes this contract after all old
Workflows and legacy rows have been drained or reconciled; do not deploy the
receipt-aware runtime between its code and schema halves.

The receipt-aware consolidation Workflow creates its claim ID in a durable
Workflow step and claims a 20-minute owner, claim, and epoch lease. It derives
batch indexes from the frozen raw `input_order` values in groups of 50. Each
batch has its own 15-minute Workflow step and renews the 20-minute lease before
it checks or reuses a historical receipt and before any unfinished model work.
Renewal is an exact old-expiration-to-new-expiration CAS; ambiguous recovery
accepts only the exact new absolute expiration. A single D1 batch acquires a
fresh operation witness, writes at most ten exact output slots and their
evidence and review rows, inserts one immutable receipt, and releases the
witness. Even a batch with no eligible input or no accepted model output writes
a zero-output receipt.

The application admits at most 9,000 distinct consolidation batches. Both the
authoritative list callback and the value returned by the durable Workflow step
validate the same sorted, unique boundary, so a cached step result cannot bypass
the guard. The orchestrator Wrangler contract pins
`workflows[0].limits.steps` to 10,000 and keeps the remaining steps as
control-plane and failure-handling reserve. A
9,001st batch fails with `WORKFLOW_FAILED` before any batch AI call; it is never
truncated. A batch step returns no model payload after persisting its receipt,
and the serialized 9,000-entry batch-index array remains below the 1 MiB
Workflow step-result limit. See the Cloudflare
[Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/).

The frozen input contract permits at most one summary per consolidation; the
gateway writes it at `input_order = 0` when present. The loader revalidates at
most one summary per model batch before model or persistence work, and migration
`0020` enforces the stronger consolidation-wide invariant in D1. A maximally
expensive callback reserves 23 fixed requests, ten summary
lookups, and 31 ambiguous-commit recovery requests. Two total step attempts
therefore reserve 128 subrequests per batch. The complete boundary reserves
`9,000 * 128 + 68 = 1,152,068` subrequests, including fixed Workflow and failure
handling. `wrangler/memory-orchestrator.jsonc` pins 1,500,000 subrequests, which
stays below Cloudflare's configurable 10,000,000 maximum and leaves explicit
operational headroom. The same maximum callback accounts for 123 D1 queries,
including every transaction statement and ambiguous-receipt verification, below
the Paid-plan 1,000-query invocation limit. Any change to batch size, output
count, model attempts, step attempts, or receipt recovery must update the
exported budget constants and the config-parsing contract test before deployment.

Before a compact consolidation input reaches AI, the shared memory-model gate
checks both every source value and the aggregate structured value. Prompt roles
or raw-log lines split across otherwise safe frozen inputs therefore produce a
zero-output receipt without a model call. The canonical aggregate remains
subject to the 16 KiB model-input boundary.

The requested GLM completion allowance continues to use the largest safe token
remainder of the model context window. Response handling applies a separate,
non-streaming 1 MiB function-argument transport limit before parsing. After
schema parsing, serialized UTF-8 JSON is explicitly limited to 256 KiB for
candidate analysis and 1 MiB for consolidation suggestions. The function
contract advertises these byte limits, and the implementation measures encoded
bytes so multibyte content cannot consume an ASCII-derived allowance.

Each receipt binds the raw input digest, model-result digest, canonical output
manifest, and manifest digest to the committed candidate IDs, content hashes,
and evidence IDs. A response-loss retry may skip the model only after a
`first-primary` read verifies that exact receipt and post-state. A later repair
claim may reuse an exact historical receipt, so completion validates the exact
batch-index set without requiring every receipt to carry the current claim.
Receipt insertion validates its complete canonical manifest and exact candidate,
maintainer-review, and clear-evidence post-state while the batch is bounded to
ten outputs. After insertion, indexed D1 guards freeze the consolidation input
set and digest plus the candidate content, hash, analysis, taxonomy, scope,
output slot, evidence-link set, and review
identity and required role. Candidate and review status, candidate version,
review audit ID, and `updated_at` remain mutable for normal maintainer review.
A later evidence sensitivity change is allowed for security response but
permanently invalidates the nonterminal consolidation receipt post-state.

Completion never reloads or expands receipt manifest bodies. One scalar D1
query checks exact expected and actual batch coordinates with anti-joins, basic
receipt digest, UUID, and timestamp validity, distinct receipt count, output
count, summed suggestion count, and the post-state validity marker. This keeps
the 9,000-batch boundary memory-bounded and remains below D1's per-invocation
query limit instead of issuing one query per batch or output. The terminal-status
trigger repeats the same compact checks in the status update, closing the race
between application verification and lease release. It still fences that update
with the current live owner, claim, epoch, and an empty operation witness. A
missing, invalidated, or divergent receipt fails closed; never substitute another
same-content candidate, infer success from partial rows, or use newest-wins
recovery. See the Cloudflare
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Production consolidation receipts are immutable and cannot be deleted. The
bounded synthetic janitor is the sole deletion path: it must delete
`consolidation_batch_receipts` before consolidation outputs, inputs, lease rows,
and the synthetic cleanup registration. If the `0018` preflight finds a running
or lease-bearing legacy row, keep the new runtime undeployed, inspect the old
Workflow, and reconcile through a reviewed forward operation. Do not clear or
fabricate a claim, lease, operation, or receipt to force cutover.

Migration `0017` is also expand-compatible at the schema level: existing runs
retain null claim fields and claim contract `0`, while repository and cursor
versions start at `1`. Do not run legacy and receipt-aware GitHub writers
concurrently. Pause the Cron, drain or reconcile every legacy running claim,
apply the migration, deploy the new Worker, and verify that newly selected runs
use claim contract `1` before restoring the schedule. The new activation batch
inserts its pre-state witness first and its final-state receipt last. The receipt
binds the request digest and activation token to the exact head, cursor,
repository configuration, run, manifest, and outbox state. An exact retry after
response loss reads that receipt; any divergent collision or stale version
requires reconciliation instead of replaying side effects.

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
Create and verify all eight required Vectorize metadata indexes before
re-upserting vectors. The rebuild must replace every current vector so the five
new taxonomy, scope, and validity fields are indexed; creating metadata indexes
does not retroactively index existing vectors.

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

- one `snapshot` target for the project version, active memory count, matching
  current-revision count, distinct active scope count, total UTF-8 bytes of
  those current revisions,
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
The release procedure imposes a separate five-minute hard limit on the
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
current-revision content or an estimated workload above the 45,000-subrequest safety
budget. The snapshot event identity and enqueue CAS bind all four capacity
values. The Workflow rereads and compares them before and after publication and
applies the same capacity calculation again.

The authority requires `revisions = memories`: the active snapshot contains
exactly one current revision per active or contested memory. The shared calculation is
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
2. Keep the replacement in an operator-controlled secret manager. If the label
   `GITHUB_CLASSIC_TOKEN_NEXT` is used there, it is only an out-of-band staging
   label; no Worker, renderer, or release step consumes that name.
3. Inject the staged token as `GH_TOKEN` only in an isolated operator shell and
   use `gh api --method GET` for `/user`, full `/user/repos` pagination, numeric
   repository-ID, numeric owner-ID, expiration-header, and read-only metadata
   checks. Do not ingest content, persist the token, or allow redirects.
4. Stop if subject, scope, permission, or repository access differs from the
   reviewed baseline.
5. Set `ENABLE_GITHUB_SYNC=false`, deploy, and confirm the exact
   disabled-version, Workflow-drain, D1-zero, Cron-empty, and Worker-secret
   gates completed. This creates a fail-closed rotation window.
6. While synchronization remains disabled and no production deployment is
   running, replace the `GITHUB_CLASSIC_TOKEN` Worker secret and set
   `SYNC_CREDENTIAL_VERSION` to a new unique value. These two settings are one
   credential identity and must never be promoted independently.
7. Set `ENABLE_GITHUB_SYNC=true`, deploy, and verify its exact version, secret
   binding, six-hour Cron, three Workflow definitions, credential identity,
   access baseline, and isolated canary before accepting repository
   synchronization.
8. Revoke the old token immediately after the new deployment succeeds. If the
   new deployment fails, keep synchronization disabled; do not restore a mixed
   token/version pair.

To retire GitHub synchronization instead of rotating it, set
`ENABLE_GITHUB_SYNC=false` and complete a deployment. Confirm the exact disabled
version, exhaustively found no nonterminal instance for any of the exact three
Workflows, observed D1 dispatch/item/run/lane zero twice, and only then created
and verified a secretless version with an empty Cron schedule. Then delete the
dashboard Worker secret and revoke the PAT in GitHub. Do not remove or revoke
the credential before this disabled-state reconciliation has completed unless
emergency revocation takes priority over a clean control-plane transition.

The active credential version emits each 14-, 7-, and 1-day warning once. At or
after expiration, synchronization stops before repository enumeration. Missing
or malformed expiration headers also fail closed. Rotation must use a new
credential version. An out-of-band staging label does not change the read-only
endpoint allowlist or authorize broader scopes.

## Partial sync

`GITHUB_PARTIAL_SYNC` is fail-closed. Do not advance the completed cursor when a
tree is truncated, a blob or run limit is exceeded, rate limiting prevents a
complete pass, or repository identity changes. Resolve the condition, perform a
full tree reconciliation, and only then mark the cursor complete.

Successful GitHub JSON responses are read as bounded streams with
endpoint-specific limits. A missing `Content-Length` does not bypass the bound:
an oversized body is canceled and becomes `GITHUB_PARTIAL_SYNC`, with no cursor
or selected-head advance. Response bodies are never included in the error or
audit record.

The dispatch Workflow has a persistent 900-request access-baseline budget.
Each `/user/repos` page is immediately reduced to numeric repository and owner
IDs plus the three permission booleans; raw repository objects are not retained
between pages. Enumeration supports at most 10,000 distinct accessible
repositories and 100 pages. A next page beyond that bound becomes
`GITHUB_PARTIAL_SYNC` before another request, fails every selected ref closed,
and requires operator review rather than truncating the authorization-risk
baseline.
Every ref Workflow has its own persistent 2,013-request budget and re-runs
repository ID, owner ID, and default-branch verification before reading that
ref. The counter is incremented in D1 before each fetch, so a Workflow retry or
response-loss recovery cannot reset it. The ref budget covers the fixed
metadata, ref, compare, commit, and tree path, up to eight annotated-tag peel
requests, at most 2,000 eligible text blob reads, and 16 MiB of retrieved
content. Generated and binary entries are represented without blob retrieval.

There is no fixed aggregate request ceiling per Cron. The Cron performs no
GitHub fetches; it only creates stable Workflow instances. Dispatcher and ref
instances acquire the same D1 credential lane before using the PAT. The lane
fences holder identity, claim ID, epoch, and lease expiration, carries the
cross-isolate request-start interval, and writes an immutable release receipt.
Contention uses deterministic jitter and durable Workflow sleep. A lost release
response is accepted only when an exact receipt verifies the lane CAS. The
deployed Worker permits 10,000 Cloudflare subrequests per invocation, but that
limit is not a reservation of GitHub capacity for the Workflow fleet.

Prior-state reconciliation shares one fail-closed budget across pending items,
unbound runs, running items, and closable dispatches: at most 64 list pages and
7,200 conservatively accounted D1 subrequests. Each list attempt reserves all
three configured tries, and each row reserves its worst-case exact-recovery
cost before any write. Running settlement reads at most 40 rows per callback;
its maximum 21 D1 statements per row is 840, below the Paid-plan limit of
[1,000 queries per Worker invocation](https://developers.cloudflare.com/d1/platform/limits/).
Reconciliation now returns its conservative actual page, mutation-page,
subrequest, and Workflow-step usage to the dispatcher. The absolute worst-case
remainder is 2,800 subrequests and 9,871 steps; admission uses the larger actual
remainder only after reconciliation has completed.

Before a current dispatch writes a sync cursor, dispatch item, or materialization
receipt, it performs two read-only keyset passes. The first pass reads 16 rows per
step and counts every enabled row, every successfully parsed ref, every invalid
row, each 100-ref materialization chunk, and unique external repository IDs. The
second pass returns one compact row snapshot per step: project and repository
identity occur once and the snapshot carries only the parsed ref strings. Every
summary and snapshot result is measured as UTF-8 JSON before it crosses the
durable step boundary and must retain 8 KiB below Cloudflare's 1 MiB non-stream
step-result limit; current and prior dispatch list pages enforce the same bound.
The pass rechecks a SHA-256 fingerprint over every configuration field. Any row,
ref, ordering, or configuration drift fails
closed. Immediately before each materialization batch, the dispatcher snapshots
the complete cursor/head and active-item state. The cursor insert, due-ref
selection, and a repository-configuration plus state fence then execute in one
transactional D1 batch. A disable, pause, configuration, tracked-ref, cursor,
head, or active-item change before that batch therefore writes no current-batch
cursor from the materialization transaction. Before a pending
dispatch item is inserted, a second transactional fence compares the frozen
repository, cursor, head, active-item, and dispatch state. Its compact guarded
insert has one aggregate admission guard for the complete ref batch, so one ref
drifting prevents every row in that batch from being inserted. Full-batch
verification fails with zero new items after any intervening drift; an exact
committed insert is recoverable after response loss. Because a
failed item fence prevents the following materialization-receipt step, it also
writes no current-dispatch receipt. Duplicate external IDs share one
access-baseline membership entry but retain the full per-project row and ref cost.
The summary scan itself rejects before requesting page 885, so even an
unbounded inventory cannot consume the reserved terminalization margin.

The retry-aware admission formula uses `R` enabled rows, `V` valid rows, `I`
invalid rows, `F` parsed refs, `C = sum(ceil(refs_per_row / 100))`,
`B = ceil(F / 100)`, `S = floor(R / 16) + 1` summary pages, and `N = R + 1`
snapshot pages. With prior-reconciliation reservation `P`, the conservative D1
common cost is `6 + P + 3 + 3S + 3N`; when `V > 0`, it also reserves 480 D1
subrequests for at most 32 lane attempts, 42 for baseline state and request-
counter work, and 9 for lane release. It then adds the larger of:

- successful materialization/fan-out followed by worst-case cleanup:
  `3(7C + V + 2I) + 3 + 9 + 3(B + 1) + 6 + [9F + 3(B + 1) + 6]`; or
- baseline failure, per-ref cursor failure, and empty-item cleanup:
  `3(4C + V + F + 2I) + 3 + 3 + 6`.

The `V` term explicitly reserves the retryable repository-identity reread that
occurs before any valid repository is materialized. The seventh successful-path
operation per chunk is the exact item-fence recovery read that can follow a lost
transaction response.

`V > 0` additionally reserves all 900 GitHub access-baseline requests. This does
not reduce the supported access inventory: `/user/repos` can still enumerate
10,000 repositories in 100 pages. Child-Workflow binding recovery independently
reserves `3(1 + 5n_k)` calls for every fan-out page `k` and sums those page
costs, because every page is its own retryable step and can recover after its
full per-item binding path. A syntactically valid 513-ref repository is not
promised admission when its complete retry and recovery topology exceeds the
hard dispatcher budget. Logical Workflow steps are counted from the same row,
page, lane, baseline, fan-out, and cleanup shape. Both dimensions retain an
additional 128-unit control/failure reserve below their pinned 10,000 limits. A
workload that does not fit is
`GITHUB_PARTIAL_SYNC`: only its failed dispatch ledger remains; current-batch
cursors, items, and materialization receipts remain at zero. Exhaustion never
becomes a successful prefix.

The internal budgets do not promise that all requests will be available. A
personal classic PAT normally has a 5,000-request-per-hour primary REST limit
shared with the authenticated user, and GitHub also applies a 900-point-per-minute
secondary limit. GitHub response headers and errors remain authoritative. The
scheduled Worker is also bounded by the deployed Cloudflare plan's subrequest
and execution-time limits. See GitHub's
[REST rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
Every admitted due ref is durably scheduled, but large multi-ref or multi-repository
backlogs can still wait under an external limit. EdgeMneme does not promise that
an arbitrary number of maximum-cost refs will complete in the same six-hour
slot, does not claim unbounded progress, and does not introduce a mid-ref
checkpoint.

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

The connector provides eventual repository snapshot consistency. Configured
refs are materialized as durable `sync_cursors`; each dispatch excludes paused
and not-yet-due cursors and freezes every remaining ref as an identity-bound D1
item. Stable Workflow IDs include the project, numeric repository, ref,
scheduled slot, and reconciliation mode. Repeated Cron delivery or child
creation therefore recovers the same ledger entry instead of creating another
attempt. A ref rejected before claiming a run receives an immutable rejection
receipt; a claimed run receives an immutable finish receipt. Neither can
prevent another ref from being dispatched.

Fleet throughput is limited by the PAT's shared primary and secondary limits,
the D1 credential lane, and each ref's absolute deadline. Monitor oldest due
time, dispatch backlog, rate remaining/reset, retry time, and deadline misses;
do not increase concurrency to bypass GitHub limits. With no webhook or clone,
a commit created and made unreachable between successful snapshots may never be
observed.

The configured set always contains the verified default branch plus every
explicit tracked branch or tag; tracked refs never replace the default branch.
An enabled GitHub repository must have a `repositories.default_branch` accepted
by the connector's tracked-ref parser. Empty values, characters outside the
ASCII ref grammar, double-dot or double-slash segments, and leading or trailing
slashes are invalid; this also rejects every whitespace or control character.
D1 migration `0015` rejects an existing row that needs reconciliation and guards
subsequent inserts and updates. Configure and review the branch before setting
`sync_enabled = 1`.
If GitHub reports a default branch different from
`repositories.default_branch`, the connector stops with
`GITHUB_RECONCILIATION_REQUIRED`. A maintainer must review the authority change,
reconcile memories supported by the old default ref, and update the configured
branch before synchronization resumes. The first due dispatch item for each ref
after a UTC day boundary freezes a full reconciliation and bypasses the ref
ETag/SHA fast path. If the midnight Cron is missed, the next successful
dispatcher backfills that daily requirement; the child may start later without
changing its frozen mode. Force-pushes and ancestry gaps also force a complete
tree comparison and retain `history_gap_possible = 1`. Later same-day items may
use conditional requests. The D1 per-ref run identity rejects overlapping work
for the same scheduled slot. An expired running claim is retained as failed
audit state before a later attempt proceeds.

A newly claimed run records the selected ref, the current active manifest and
head version, the repository configuration version, and the exact cursor
version. Activation is one D1 batch. Its first statement inserts an immutable
pre-state witness under an activation token and request digest. Every manifest
delta, deletion-review artifact, safe candidate statement, outbox event, head
advance, cursor update, and run completion is guarded by that witness and the
same claim. The last statement inserts an immutable receipt whose trigger checks
the complete final state, including the incremented head and cursor versions.
If the client loses the successful response, only an exact matching receipt can
complete the retry. A changed configuration, paused or advanced cursor, moved
head, expired lease, or nonmatching token or digest fails with
`GITHUB_RECONCILIATION_REQUIRED`; never repair it by moving the head or cursor
manually.

Migration `0019` makes the old direct-Cron GitHub writer incompatible. After it
is applied, recovery is roll-forward only to a build that exports
`GitHubDispatchWorkflow`, `GitHubRefSyncWorkflow`, and
`GitHubRetentionWorkflow`. The scheduled handler itself performs no GitHub or
retention work; it only creates or recovers stable dispatch and retention
instances. Dispatcher and ref retries consume the persisted request counters,
so a Workflow retry cannot reset the 900-request access-discovery budget or the
2,013-request ref budget. A lane release commits the lane CAS and immutable
release receipt in one D1 batch, and response-loss recovery accepts only that
exact receipt. Never restore a pre-`0019` version, manually clear a lane, or
rewrite a dispatch, activation, release, or finish receipt.

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
  provenance-checked deltas, active-head transitions, and bodyless retention
  lifecycle events authoritative. A `withdrawn` delta represents a prior text
  entry becoming binary, generated, or sensitive and never carries a recoverable
  path. The migration retains a bodyless row and terminal event after the
  guarded 30-day cleanup of failed entries. Never edit or delete a real manifest
  to recover a run; reconcile the current GitHub tree into a new manifest and
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
- Migration `0015_github_sync_default_branch.sql` fails closed when an enabled
  GitHub repository has no runtime-valid default branch and then guards the same
  invariant. Verify the branch from GitHub repository metadata, update the
  authoritative row through a reviewed change, and retry the migration. Never
  bypass the preflight or enable synchronization with a padded, control-bearing,
  or malformed ref name.
- Migration `0016_consolidation_lease.sql` is a pure expand step. It adds nullable
  owner, expiration, and operation-witness fields plus a safe-integer epoch and
  running-expiry index; it neither backfills legacy rows nor installs contract
  triggers. Drain old running Workflows before cutover. A legacy `running` row
  with null lease fields fails closed and requires reviewed forward
  reconciliation. Let a valid live owner finish or let its lease expire for
  ordinary fenced takeover; never clear, transfer, or synthesize lease fields.
  Defer stricter constraints to a separate contract migration after every
  legacy row and old Workflow has been drained or reconciled.
- Migration `0017_github_sync_activation_receipts.sql` adds the versioned run
  claim, immutable pre-state witness, and immutable final-state receipt used by
  atomic GitHub manifest activation. Pause scheduling, drain or reconcile claim
  contract `0` runs, apply the migration, deploy the receipt-aware Worker, and
  verify new claims use contract `1` before restoring the Cron. Never delete or
  rewrite production cursors, runs, witnesses, or receipts to recover a stale
  activation. Reconcile the current tree through a new claim; only the bounded
  synthetic cleanup path may remove those rows.
- Migration `0018_consolidation_batch_receipts.sql` is a contract cutover and
  rejects every legacy `running` or lease-bearing consolidation row. Drain old
  Workflows before applying it. The compatible runtime then uses a durable
  claim ID, 20-minute renewable lease, raw 50-input batch coordinates, and one
  immutable receipt for every batch, including zero-output batches. On retry,
  reuse only an exact receipt whose input digest and complete post-state verify.
  Its guards require canonical ISO timestamps, exact manifest keys and types,
  stable v5-a candidate IDs, distinct ordered evidence IDs, pending maintainer
  review at receipt creation, and clear evidence. Receipt-bound stable fields and
  relations are then immutable, while legal review status transitions remain
  available. A terminal-status guard rechecks compact coordinate, count, digest,
  and post-state-validity invariants atomically without expanding manifests. A
  repair claim may finish with verified historical receipts. Never delete or
  rewrite a production receipt, attach a different same-hash candidate, or
  manually mark a partially persisted batch complete. Only child-first synthetic
  cleanup may delete receipt rows.
- Migration `0019_github_sync_workflows.sql` is the prelaunch cutover from a
  direct-Cron writer to the exact three-Workflow runtime. Quiesce the connector
  and drain both the Workflow control plane and authoritative D1 before
  applying it. Dispatch materialization, credential-lane release, manifest
  activation, and per-ref finish each have immutable receipts; dispatcher and
  ref request counters persist across retries. After this migration, automatic
  rollback may target only a tagged version with the exact Workflow bindings,
  no Queue, and compatible runtime/credential settings. Recovery to an older
  writer is forbidden; retain the disabled version and roll forward instead.
- Migration `0020_consolidation_input_shape.sql` is the fail-closed contract for
  the consolidation budget. It refuses legacy rows with duplicate summaries,
  then installs an insert guard and partial unique index. Reconcile invalid
  authority data through a reviewed forward migration; never delete or reorder
  frozen inputs to satisfy the preflight.
- Migration `0021_github_annotated_tag_request_budget.sql` adds a persisted
  overflow counter that may advance only while a dispatch item remains
  `running`, only after its base request counter reaches exactly `2,005`, and by
  at most eight. The compatible runtime uses those eight requests solely for
  bounded annotated-tag peeling, producing the documented `2,013` maximum.
  Apply the migration before deploying that runtime; never edit either counter
  to retry or extend a GitHub run.
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
