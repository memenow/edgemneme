# Architecture

## Invariants

1. D1 is the only authority. R2 projections, FTS rows, and Vectorize entries can
   be deleted and rebuilt without losing formal memory.
2. A formal change creates an immutable revision. Rollback copies historical
   content into a new revision; it never rewrites history.
3. Every formal project change consumes one monotonically increasing
   `project_version` and appends one audit event.
4. Queue and Workflow delivery can repeat or stop independently. Every boundary
   uses a stable event or idempotency key, and dispatched Workflow-backed outbox
   rows remain recoverable from D1.
5. A project Durable Object reduces contention but is not the transaction
   authority. D1 guards stale project and memory heads inside one atomic batch.
6. Queries never trust Vectorize or FTS metadata. Every hit must be reloaded from
   the authoritative project, ACL, head, and status rows, and its recalled chunk
   must be recomputed from the current D1 content before it can enter reranking
   or a context pack.
7. A project is a hard authorization boundary and may contain multiple
   repositories. Project memory is shared inside that project; non-project
   memory belongs to exactly one normalized repository context.
8. Repository evidence cannot be promoted into another repository. Cross-project
   reads, writes, promotion, search, and projection reuse are forbidden.
9. Session consolidation is complete only after every deterministic model batch
   has an immutable, fenced D1 receipt, including batches with no suggestions.
10. A GitHub Cron invocation only schedules durable work. Per-ref Workflow items,
    the credential lane, activation receipts, and terminal receipts remain the
    authoritative execution record across retries and control-plane ambiguity.
11. The protected deployment and migration Actions may reconcile only GitHub
    synchronization ledgers, and only after proving an exact disabled Worker,
    an empty schedule, and no nonterminal GitHub Workflow. This operational D1
    writer cannot create or change formal memory.

## Project and repository isolation

EdgeMneme uses one physical Cloudflare deployment with logical tenant and
repository isolation. A project-wide grant can see every registered repository
in its project. A repository grant can see project memory and memory owned by
that repository, but it cannot see another repository's memory. A session
further intersects search and mutation access with its immutable repository
context.

The authority database stores normalized repository relationships rather than
deriving access from client-provided strings:

| Relationship | Authoritative representation |
| --- | --- |
| Session ownership | `sessions.repository_id`, `repository_ref`, and `worktree_id` |
| Evidence provenance | `evidence.repository_id`, `repository_ref`, `repository_path`, and `repository_authority` |
| Scoped grant ownership | `project_grant_repository_contexts` |
| Formal memory ownership | `memory_repository_contexts` |

The same provider repository identity cannot be registered in more than one
project. Database constraints verify that normalized contexts reference a
repository in the same project and make session, evidence, grant, and memory
ownership immutable. Formal promotion writes the memory head and its normalized
repository context in the same guarded batch.

A correction, invalidation, or rollback cannot select new repository ownership.
The gateway resolves the target memory's canonical scope and repository context
from a `first-primary` D1 session, then sends that server-derived attestation to
the project coordinator. The coordinator independently resolves the same target
and rejects a mismatch before idempotency or batch writes. Evidence for a
non-project target is namespaced by its canonical repository and exact
scope/scope ID, and persists the target repository and trusted ref with
`agent_supplied` authority. Evidence for project memory uses a project/scope
namespace and keeps every repository provenance field null. Existing evidence
is checked through a `first-primary` identity and context preflight. The guarded
batch retains an atomic compare-and-abort UPSERT, so a concurrent incompatible
reuse still rolls back the entire formal change and returns
`VALIDATION_FAILED`.

## Request flow

```text
MCP client
  -> memory-gateway /mcp
     -> Origin and bearer authentication
     -> project grant and optional repository/session intersection
     -> authorized D1 read
     -> Queue candidate event
     -> project-scoped ProjectCoordinator mutation
        -> guarded D1 batch
        -> MemoryWorkflow
           -> immutable R2 snapshot
           -> current-generation FTS and Vectorize projection

Cloudflare Cron (*/5 * * * * UTC)
  -> reconcile dispatched ordinary outbox events from D1
     -> recover Queue/DLQ deliveries that produced no Workflow run
     -> reuse the stable base Workflow or one of three repair IDs
     -> defer active or unknown control-plane states for five minutes
  -> reconcile projection rebuilds through their specialized execution protocol

Cloudflare Cron (0 */6 * * * UTC)
  -> github-sync
     -> create or recover one stable dispatch Workflow and one retention Workflow

GitHubDispatchWorkflow
  -> account repository-access and credential-expiry gate through the D1 PAT lane
  -> materialize every due ref as an identity-frozen D1 dispatch item
  -> seal the exact item count with an immutable materialization receipt
  -> create GitHubRefSyncWorkflow children in batches of at most 100

GitHubRefSyncWorkflow (one bounded ref attempt)
  -> acquire the fenced D1 credential lane
  -> fixed-origin GitHub REST GET client
  -> repository and owner numeric-identity gate
  -> daily or ancestry-gap current-tree reconciliation
  -> staged checksummed D1 tree manifest covering every blob entry
  -> 16 KiB per-blob, 2,000-text-file, 16 MiB, and request/deadline gates
  -> secret, PII, prompt, log, and path gate
  -> evidence-linked candidate or bodyless sensitive-content tombstone
  -> atomic manifest-head/cursor CAS and stable path delta
     -> deletion or withdrawal evidence plus pending maintainer review,
        never a formal-memory write
  -> immutable terminal receipt and durable D1 review outbox event
     -> later memory-orchestrator Queue dispatch

GitHubRetentionWorkflow
  -> independently purge eligible failed manifests in bounded D1 transactions

Protected deployment or migration Action (GitHub sync disabled)
  -> prove exact disabled Worker, empty Cron schedule, and no nonterminal Workflow
  -> reconcile only GitHub synchronization ledgers through receipt-fenced D1 writes
  -> revalidate the control plane and require two fenced zero-work observations
     60 seconds apart
  -> keep the post-backup migration gate read-only
```

Complete GitHub tree manifests, their entries, and deltas are immutable. A
manifest is inserted as `staging`, populated in bounded JSON batches, checksummed
against its complete entry set, and only then marked `complete`. A failed build
moves from `staging` to `failed` in the same D1 transaction that appends its
bodyless immutable lifecycle event. A bounded scheduled retention pass ignores
work protected by a live repository lease and, after 30 days, claims failed work
with a monotonic attempt/version, purge token, and lease. Per-project quotas,
separate persistent staging/failed rotation cursors, and exponential retry times
prevent poisoned project prefixes from starving another project. Each deletion
transaction appends a count/digest-only chunk event and removes exactly that
chunk of at most 500 entries. The final D1
transaction writes the `purged` manifest tombstone and terminal event only after
every entry is gone. The active ref head, synchronization cursor,
added/changed/deleted/withdrawn deltas, deletion or withdrawal evidence and
observations, review requests, and synchronization outbox event commit in one D1
batch. A `withdrawn` delta records a text source becoming binary, generated,
or sensitive without retaining a safe path. Its independent evidence and
observation are bodyless and path-digest-only; the previously linked clear
evidence remains immutable. A review is opened only when an active or contested
current revision still cites the withdrawn source. Restoring the same blob to
text uses the explicit clear-evidence identity, while the independent tombstone
identity keeps both records immutable. A truncated tree, content-policy partial
result, request-budget failure, checksum mismatch, stale head, or failed batch
leaves the previous head and cursor intact.
The normalized scheduled slot and each ref's last successful synchronization
freeze `full_reconciliation` on the dispatch item. The first due item for a ref
in each UTC day performs a complete current-tree comparison even when its child
starts later. If the midnight trigger is missed, the next dispatcher backfills
the requirement. Force-pushes and ancestry gaps also require full
reconciliation and preserve `history_gap_possible`.

## Formal write protocol

The coordinator reads the current project and memory heads from a
`first-primary` D1 session. It calculates the next revision and audit hash, then
submits audit, revision, head, idempotency, outbox, and project-head statements
in one D1 batch.

Two database triggers make a stale command abort rather than become a harmless
zero-row update:

- `audit_sequence_guard` requires the stored project head to match the new
  event's predecessor.
- `memory_version_guard` requires the stored memory head to be exactly one
  revision behind the inserted revision.

D1 rolls back the entire batch if either trigger aborts. The caller receives
`VERSION_CONFLICT` and must reread before retrying.

## Consolidation batch protocol

Session consolidation claims one row with an owner, unique claim ID, monotonic
lease epoch, and operation witness. The Workflow freezes the input buckets and
runs every bucket in a separately named, deterministic step. Before each batch
it renews a 20-minute lease; the batch itself has a 15-minute execution timeout.
The frozen set contains at most one summary; the gateway writes it at input
order zero when present. D1 enforces the consolidation-wide limit, and the
runtime loader revalidates the per-batch limit before model work so the
conservative 128-subrequest per-batch bound remains authoritative.

A model batch is applied through one fenced D1 transaction. The transaction
validates the current owner, claim, epoch, and operation; rejects an active
content-hash duplicate inside the insert; writes only the winning candidate,
evidence, review, and consolidation-output rows; and appends an immutable batch
receipt. The receipt binds the frozen input digest, model-result digest, exact
output manifest, and completion time. A valid zero-output batch still writes a
receipt. An ambiguous response can be recovered only by reloading an exact
receipt through `first-primary`. A later claim may reuse that durable receipt,
but cannot rewrite it. Once a receipt exists, D1 freezes the consolidation input
set and digest plus its candidate content, analysis, taxonomy, scope, output
slot, evidence-link set, and review identity
while permitting normal candidate and review status transitions. The final step
validates the exact expected receipt coordinates and compact receipt metadata,
without loading manifest bodies, before it releases the lease and marks
consolidation complete.

## Workflow recovery

The Queue, Workflow control plane, and D1 dispatch marker are separate failure
domains. The five-minute orchestrator schedule therefore selects at most 20
eligible dispatched ordinary events from the D1 outbox. The covered events are
`candidate.submitted`, `candidate.reviewed`,
`session.consolidation.requested`, `github.sync.requested`, and
`memory.changed`. A row with no Workflow run creates its stable base Workflow,
including a row whose Queue delivery exhausted retries and reached the DLQ.

Known active states and control-plane uncertainty remain nonterminal and are
deferred for five minutes. An unknown or future status never advances to a
repair ID. Only an explicit `errored` or `terminated` state permits the next
deterministic identity: the base ID followed by `repair-1` through `repair-3`.
After all four identities explicitly fail, the outbox row becomes terminal with
`WORKFLOW_REPAIR_EXHAUSTED`. A control-plane completion can safely backfill a
missing D1 `workflow_runs` row before the outbox row records
`WORKFLOW_COMPLETE`.

`projection.rebuild.requested` is intentionally excluded. Projection rebuilds
retain their dedicated reconciliation index, bounded unknown-status episode,
capacity rules, and immutable resume execution model.

## Projection layout

Each project version has a private immutable prefix:

```text
projects/{project_id}/projections/{snapshot_id}/
├── manifest.json
├── README.md
├── objects/{hash-prefix}/{memory_id}.md
├── revisions/{hash-prefix}/{memory_id}/{revision_id}.md
└── indexes/
    ├── by-kind/{kind}/index.{json,md}
    ├── by-class/{memory_class}/index.{json,md}
    ├── by-scope/{scope_id}/index.json
    └── by-status/{status}/index.json
```

The projection writer emits the manifest, README, canonical head objects, and
exactly the authoritative current revision with its current evidence for every
active or contested memory. D1 retains the immutable full revision history;
historical revision objects may remain under older immutable prefixes, but they
are never referenced by the active manifest. The writer emits JSON/Markdown
classification indexes from the same authoritative read, verifies D1 content
checksums, and rejects an immutable R2 key collision. Activation is conditional
on the project still having the Workflow's `project_version`, so a late Workflow
cannot replace a newer snapshot.

The search projection uses a separately versioned index generation. Formal
memory changes write Unicode FTS chunks and 1,024-dimensional Qwen embeddings;
each projected head and vector carries `repository_partition`. Project memory
uses `*`; all other memory uses its normalized repository ID. Vectorize applies
the project namespace and repository partition filter before recall, while FTS
joins the matching projection head. Query results are then fused, reloaded from
current D1 heads with hierarchical ACL checks, and mapped back to the exact
chunk through the same deterministic chunker used by projection publication. A
missing, malformed, or out-of-range recalled chunk ID fails closed. Only that
authoritative chunk is diversified and reranked. The response exposes a
budgeted `excerpt` plus `excerptTruncated`; context packing truncates only on
Unicode code-point boundaries and retains memory, revision, chunk, and evidence
citations. The authorized individual-memory resource remains the path for full
content. Search abstains when it cannot produce an authorized context pack.

R2 snapshots, manifests, and classification indexes describe the complete
project. They therefore require a project-wide reader grant. Repository-scoped
clients can read only individual memory resources allowed by the hierarchical
ACL and cannot browse the project manifest or project indexes.

## Consistency boundaries

D1 Sessions provide sequential consistency, not snapshot isolation. Operations
that must start from the newest state use `first-primary`. Pagination tokens
are opaque, unsigned continuation markers binding the project, query digest,
snapshot version, and sort cursor. Every field is revalidated server-side:
the project must match the authenticated principal, the query digest must
match the current query, and the snapshot version must match the live project
version, so the gateway rejects a token when the project changes. Temporal
validity filtering always uses the server's current time, never a
client-supplied timestamp.

Durable Object input gates do not keep requests serialized while arbitrary
external I/O is awaited. Correctness therefore remains in D1 constraints and
atomic batches rather than an in-memory lock or `blockConcurrencyWhile()`.

## Model boundary

Candidate analysis and session consolidation use one non-streaming, forced
Workers AI function call from `@cf/zai-org/glm-5.2`. The user payload is canonical
JSON, and the function parameters define the machine-readable output contract.
Cloudflare's model page publishes a 262,144-token context window for GLM-5.2.
EdgeMneme uses that context window as the total request budget and assigns the
largest safe completion allowance by subtracting UTF-8 upper bounds for the
messages and serialized tool contract plus a fixed chat-template reserve. It
does not add a smaller generation-token cap. The non-streaming function argument
transport is independently limited to 1 MiB before JSON parsing. After schema
parsing, local semantic validation measures the serialized UTF-8 JSON and allows
at most 256 KiB for candidate analysis and 1 MiB for consolidation suggestions;
the tool contract exposes the same bounds. This check counts bytes rather than
assuming one byte per character. A consolidation batch persists the accepted
result and returns no model payload from its Workflow step. The only large
durable step result is the batch-index array, whose 9,000-entry maximum remains
below Workflow's 1 MiB step-result limit. There is no silent model fallback.

The model receives server-created opaque scope option IDs, the semantic scope
type, selection guidance, and evidence source IDs. It does not receive the raw
project or repository ID behind an option. Repository options are built only
from trusted normalized provenance. A single repository also receives an
advisory project-generalization option so the model can recognize a genuinely
repository-independent rule, but every project option requires maintainer
review. A multi-repository project option must cite evidence from at least two
registered repositories.

Every response is parsed with a strict local schema. The selected option and
cited evidence must match the server's frozen option set, and a proposed
validity timestamp is accepted only when the exact timestamp appears verbatim
in the candidate or a cited consolidation input. The model is advisory: it does
not authorize access, approve a candidate, or write formal memory. Invalid model
output leaves the candidate in review state and never changes formal memory.
