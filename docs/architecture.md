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
   the authoritative project, ACL, head, and status rows before it can enter a
   context pack.
7. A project is a hard authorization boundary and may contain multiple
   repositories. Project memory is shared inside that project; non-project
   memory belongs to exactly one normalized repository context.
8. Repository evidence cannot be promoted into another repository. Cross-project
   reads, writes, promotion, search, and projection reuse are forbidden.

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

Cloudflare Cron (* * * * * UTC)
  -> reconcile dispatched ordinary outbox events from D1
     -> recover Queue/DLQ deliveries that produced no Workflow run
     -> reuse the stable base Workflow or one of three repair IDs
     -> defer active or unknown control-plane states for five minutes
  -> reconcile projection rebuilds through their specialized execution protocol

Cloudflare Cron (0 */6 * * * UTC)
  -> github-sync
     -> fixed-origin GitHub REST GET client
     -> account repository-access and credential-expiry gate
     -> repository and owner numeric-identity gate
     -> per-repository lease and daily current-tree reconciliation
     -> staged checksummed D1 tree manifest covering every blob entry
     -> 16 KiB size gate or GITHUB_PARTIAL_SYNC
     -> secret, PII, prompt, log, and path gate
     -> evidence-linked candidate or bodyless sensitive-content tombstone
     -> atomic manifest-head/cursor CAS and stable path delta
        -> deletion evidence plus pending maintainer review, never a formal-memory write
     -> Queue event and MemoryWorkflow review state
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
added/changed/deleted deltas, deletion evidence, deletion observations, review
requests, and synchronization outbox event commit in one D1 batch. A truncated
tree, content-policy partial result, request-budget failure, checksum mismatch,
stale head, or failed batch leaves the previous head and cursor intact.
The daily collection key includes the scheduled time, so a 00:00 UTC pass can
detect path deletion even when the commit SHA did not change.

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

## Workflow recovery

The Queue, Workflow control plane, and D1 dispatch marker are separate failure
domains. The one-minute orchestrator schedule therefore selects at most 20
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

The projection writer emits the manifest, README, canonical head objects, every
immutable revision, and JSON/Markdown classification indexes from one
authoritative read. It verifies D1 content checksums and rejects an immutable R2
key collision. Activation is conditional on the project still having the
Workflow's `project_version`, so a late Workflow cannot replace a newer
snapshot.

The search projection uses a separately versioned index generation. Formal
memory changes write Unicode FTS chunks and 1,024-dimensional Qwen embeddings;
each projected head and vector carries `repository_partition`. Project memory
uses `*`; all other memory uses its normalized repository ID. Vectorize applies
the project namespace and repository partition filter before recall, while FTS
joins the matching projection head. Query results are then fused, reloaded from
current D1 heads with hierarchical ACL checks, diversified, reranked, and
returned only with evidence. Search abstains when it cannot produce an
authorized context pack.

R2 snapshots, manifests, and classification indexes describe the complete
project. They therefore require a project-wide reader grant. Repository-scoped
clients can read only individual memory resources allowed by the hierarchical
ACL and cannot browse the project manifest or project indexes.

## Consistency boundaries

D1 Sessions provide sequential consistency, not snapshot isolation. Operations
that must start from the newest state use `first-primary`. Pagination tokens
bind the project, principal, optional session, resolved repository ceiling,
normalized query digest, snapshot version, cursor, and expiry with HMAC-SHA-256.
The gateway rejects a token when the principal or session changes or after the
project version changes.

Durable Object input gates do not keep requests serialized while arbitrary
external I/O is awaited. Correctness therefore remains in D1 constraints and
atomic batches rather than an in-memory lock or `blockConcurrencyWhile()`.

## Model boundary

Candidate analysis and session consolidation use one non-streaming, forced
Workers AI function call from `@cf/zai-org/glm-5.2`. The user payload is canonical
JSON, and the function parameters define the machine-readable output contract.
Cloudflare's model page advertises a 262,144-token context window, while the
Workers AI request path currently enforces a 256,000-token combined input and
requested-completion ceiling. EdgeMneme assigns the largest safe completion
allowance from that service ceiling by subtracting UTF-8 upper bounds for the
messages and serialized tool contract plus a fixed chat-template reserve. It
does not add a smaller application output cap. There is no silent model
fallback.

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
