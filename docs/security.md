# Security

## MCP authorization decision

EdgeMneme deliberately uses a revocable per-principal project bearer token
(HMAC digest at rest) instead of the OAuth 2.1 flow described by the MCP
authorization specification. The service targets Codex, Claude Code, and
other coding agents that are configured with a static token; there is no
human consent screen and no third-party client ecosystem to discover.
Consequence: generic MCP clients that require OAuth discovery
(`/.well-known/oauth-protected-resource`, RFC 9728) cannot connect. If
EdgeMneme ever serves such clients, add an OAuth 2.1 resource-server layer in
front of the gateway rather than weakening the token contract.

## Pagination cursors

Pagination tokens are unsigned opaque continuation markers. A cursor only
contains the project, query digest, snapshot version, and sort key; the
gateway revalidates every field against the authenticated principal, the
current query, and the live project version on each page. Temporal validity
filtering always uses the server's current time, so a client cannot select a
validity window. A replayed cursor can therefore only re-read data the
principal is already authorized to see, and only while the project version
remains unchanged.

## Credential boundaries

- `memory-gateway` receives only its token-digest pepper and page-token HMAC
  key.
- `github-sync` is the only Worker that receives `GITHUB_CLASSIC_TOKEN`.
- `memory-orchestrator` receives D1, R2, Vectorize, Workers AI, Queue, Workflow,
  and Durable Object bindings, but no GitHub or MCP credential.

Secrets are configured through Worker secrets or protected GitHub environment
secrets. Cloudflare resource identifiers and rate-limit namespace identifiers
are protected deployment variables and are rendered only into ignored runtime
configuration. Secret values must never enter the repository, Wrangler vars,
D1, R2, Queue messages, Workflow payloads, logs, exceptions, tests, or model
input.

The tracked `github-sync` configuration is inert: its runtime gate is false, its
Cron Trigger list is empty, and it declares no required credential secret. It
still declares the exact three private Workflow entrypoints required by an
enabled deployment. Enabling renders the runtime gate, one six-hour Cron, and
one required secret, then verifies the exact Workflow set, schedule, and
one-item secret allowlist containing only `GITHUB_CLASSIC_TOKEN`.

A disabled transition is five-stage and fail-closed. It deploys the runtime
guard with no Cron while retaining the secret, exhaustively proves that the
exact three GitHub Workflows have no nonterminal instances, reconciles only the
GitHub synchronization ledgers, requires two clear observations 60 seconds
apart, and only then deletes and verifies the Worker secret. The scheduled
handler checks the runtime gate before any D1, GitHub, or token access.

The ledger helper is available only to the protected deployment and migration
Actions. Every pass is bounded to 20 candidates per phase, 18 Cloudflare HTTP
requests, and 288 D1 statements. It uses a fixed D1 REST origin, parameterized
queries, 1 MiB encoded request and response body limits, primary-service
attestation, a native number/null parameter preflight, immutable receipts, and
exact CAS verification. The exact
disabled Worker, empty schedule, and empty Workflow control plane are checked
before and after every pass, including a pass that returns `pending`. This proof
allows the helper to settle a matching unexpired operational lease without
racing a live Workflow. It cannot write formal memories, revisions, project
versions, or audit chains; D1 remains authoritative and the project coordinator
remains the only formal-memory commit path.

The 60-second cadence leaves headroom under Cloudflare's shared
[Client API limit](https://developers.cloudflare.com/fundamentals/api/reference/limits/).
HTTP 429, unknown or malformed responses, repeated cursors, partial schema,
version drift, or new work fails closed without secret deletion and without a
silent API retry. Receipt verification makes a later reviewed rerun resumable.
The initial migration drain may reconcile before backup; the final post-backup
gate is read-only. GitHub environment-secret deletion and PAT revocation remain
explicit operator actions after reconciliation.

Before the bearer-bearing production canary, the workflow derives the exact
HTTPS `/mcp` endpoint and hostname from the gateway's verified Cloudflare
workers.dev or custom-domain trigger. It also binds that target to this run's
tagged 100-percent active version and rechecks both version and trigger after
cleanup. A separately configured URL or hostname is not deployment authority.

## MCP ingress boundary

The public Worker serves only `/mcp`. It validates browser origins, applies edge
and client rate limits, authenticates the project bearer token, and applies the
principal rate limit before handing a POST body to the MCP transport. The whole
POST body is then bounded to 2 MiB of request-body bytes visible to the Worker.
This excludes HTTP chunk and frame overhead. `Content-Length` enables an early
rejection but is never trusted as the authoritative count of a delivered stream.

The gateway accepts only an absent or identity `Content-Encoding`; it does not
decompress client bodies. It reads an accepted stream in bounded chunks, cancels
the reader after detecting the first byte over the limit, reconstructs an exact
bounded request, and only then invokes the MCP parser. Malformed declared
lengths, unsupported encodings, and oversized bodies return HTTP 400, 415, and
413 respectively in a non-cacheable JSON-RPC error envelope when the request
reaches the Worker. Cloudflare can reject malformed HTTP framing or headers
before Worker execution with its own platform response. This boundary limits
parser memory exposure and avoids compressed-body expansion inside the Worker.

## Project and repository isolation

EdgeMneme uses one physical Cloudflare deployment with logical isolation. The
project ID is the hard tenant boundary across D1 predicates, Durable Object
names, Vectorize namespaces, R2 prefixes, Queue payloads, Workflows, and audit
events. No project memory is global across projects.

Within a project, project memory is visible to every authorized repository. A
repository grant can see only that shared project memory and memory with the
same `memory_repository_contexts.repository_id`. Session-scoped reads and writes
are further limited by immutable `sessions.repository_id`. Project manifests
and classification indexes cover the complete project and require a
project-wide reader grant.

Authorization uses normalized `project_grant_repository_contexts` and
`memory_repository_contexts` rows. It never infers repository ownership from an
untrusted locator, model response, or arbitrary worktree JSON. Database
constraints prevent one provider repository identity from being assigned to
multiple projects and reject contexts that point outside their project.

Formal corrections, invalidations, and rollbacks derive their context from the
target memory rather than caller evidence. The gateway loads the canonical
target context and overwrites any caller-selected internal value; the project
coordinator independently reloads it and rejects a mismatch before the
idempotency check or D1 batch. Non-project change evidence is server-namespaced
to the target repository and exact scope, persists the canonical repository and
trusted ref, and uses `agent_supplied` authority. Project-memory change evidence
keeps all repository provenance fields null. A `first-primary` preflight checks
existing evidence identity and context. The guarded UPSERT preserves an atomic
compare-and-abort for races; an exact immutable-provenance trigger failure is
mapped to `VALIDATION_FAILED`, and the entire formal-change batch rolls back.

## GitHub boundary

The GitHub client:

- constructs URLs internally;
- fixes the origin to `https://api.github.com`;
- sets API version `2026-03-10`;
- accepts only allowlisted repository metadata, ref, annotated-tag object,
  commit, tree, and blob paths;
- uses `redirect: "manual"` and rejects every redirect;
- verifies both repository and owner numeric IDs before accessing refs or
  content; owner/name are routing labels only;
- synchronizes the configured default branch in addition to explicit tracked
  refs, prevents enabling a GitHub repository without that configured branch,
  and fails closed on an unreviewed default-branch rename;
- requires a successful `/user` response to include a strictly formatted
  `GitHub-Authentication-Token-Expiration` header and fails closed before
  repository enumeration when it is missing, malformed, or expired;
- enforces per-blob, file-count, and total-byte limits;
- streams every successful GitHub JSON response through an endpoint-specific
  byte limit, cancels an oversized body, and reports a partial sync without
  advancing the cursor or selected head;
- gives access-baseline discovery its own 900-request internal budget;
- gives every ref Workflow a new 2,013-request client, including at most eight
  cycle-checked annotated-tag peel requests, a 2,000-text-file limit, a 16 MiB
  retrieval limit, per-fetch cancellation, and an absolute run deadline;
- materializes every due ref as a durable item instead of imposing a per-Cron
  two-ref rotation; and
- routes dispatcher and ref access through one D1 credential lane that fences
  the credential version, holder, unique claim, lease epoch, and expiration,
  with deterministic jitter and backoff between contenders.

These internal budgets are fail-closed application bounds, not reservations of
GitHub or Cloudflare capacity. GitHub may reject a request earlier under its
[primary or secondary REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
and the Worker remains subject to its configured
[Cloudflare platform limits](https://developers.cloudflare.com/workers/platform/limits/).
The GitHub sync Worker explicitly configures a 10,000-subrequest platform limit.
Each of its three Workflow definitions also pins a 10,000-step limit. Prior
dispatch reconciliation reserves a shared 7,200-subrequest maximum before
writes, including configured retries, so at least 2,800 subrequests remain for
the dispatcher's baseline, materialization, and fan-out path.
That is a per-invocation Cloudflare ceiling, not an aggregate reservation for a
Cron fan-out. Every due ref can be durably scheduled, but EdgeMneme does not
promise that an arbitrary number of maximum-cost refs will finish in the same
six-hour slot. Budget or deadline exhaustion is reported as
`GITHUB_PARTIAL_SYNC` before another fetch is issued and never advances the
active head or cursor.

Each dispatch item freezes the selected ref, scheduled slot, reconciliation
mode, active manifest and head version, repository configuration version, and
cursor version. A per-ref run claim includes that identity. Manifest
activation starts by inserting an immutable witness that validates that exact
pre-state and an unexpired run lease. The same D1 batch writes the deltas,
candidate artifacts, outbox event, active head, cursor, and terminal run state,
then inserts an immutable receipt whose trigger validates the complete final
state. A response-loss retry succeeds only when its activation token and request
digest match that committed receipt. Stale configuration, cursor, head, or run
claims fail closed instead of being accepted after an ABA state transition.
An item rejected before a run is claimed writes an immutable rejection receipt;
a claimed child writes an immutable finish receipt bound to the exact dispatch
item and terminal run state. Production dispatch ledgers, materialization
receipts, credential lanes,
synchronization cursors, run claims, witnesses, and receipts cannot be deleted;
the bounded synthetic-project cleanup path is the only exception.

Session consolidation uses the same fail-closed transaction posture. Every
deterministic model batch is fenced by the current owner, unique claim ID,
monotonic lease epoch, and operation witness. Candidate, evidence, review, and
output rows commit with one immutable batch receipt, including for an empty
result. An ambiguous response can recover only an exact receipt through a fresh
primary read; a same-hash race loser rolls back instead of manufacturing a
candidate or receipt. Consolidation cannot finish until all expected receipts
have been validated. Receipt insertion verifies each bounded manifest in full;
indexed D1 guards then freeze the stable input, candidate, output, evidence-link,
and review identity it proved. Completion reads only compact receipt coordinates and
metadata, so the 9,000-batch boundary cannot materialize manifest bodies in a
Worker isolate.
The same frozen-input boundary permits at most one summary per consolidation;
the gateway writes it at order zero when present. The loader rejects an
overfull batch before model work, while migration `0020` enforces the stronger
global limit in D1. The orchestrator reserves 1,500,000 subrequests against the
conservative 1,152,068 full-boundary requirement, including two total batch
attempts and ambiguous-commit recovery.

A PAT (classic) with `repo` scope is not truly read-only. If stolen, it can
exercise the full scope outside EdgeMneme. The accepted design therefore
requires a short expiration, explicit repository-ID baseline approval, alerts
for access expansion, and immediate revocation during rotation.
Authenticated-repository pages are projected immediately to numeric repository
and owner IDs plus permission booleans. The connector retains no raw repository
objects across pages and fails with `GITHUB_PARTIAL_SYNC` before exceeding
10,000 repositories or 100 pages; it never accepts a truncated access baseline.

D1 records only the credential version, observed expiration time, public status,
and idempotent 14-, 7-, and 1-day warning events. It never records the token,
scope header, or Worker secret binding name. Public synchronization state exposes
only `credential_status` and synchronization times. An expired credential is
blocked before `/user/repos`, repository metadata, refs, or content are read.

## Candidate boundary

Candidate content is scanned before persistence, Queue delivery, or model use.
Secret-shaped values, private keys, bearer tokens, email addresses, US Social
Security numbers, prompt transcripts, and raw log dumps are rejected from model
input. This scanner is defense in depth; operators must still avoid submitting
credentials, customer data, full prompts, raw logs, or large diffs.
Before a candidate reaches Workers AI, the complete canonical model payload is
also inspected under the aggregate memory-model byte limit. Raw repository refs
are excluded from model evidence metadata; opaque evidence IDs, source type,
repository authority, and a repository-context boolean are sufficient for the
model's constrained scope choice.

GitHub ingestion uses a 16 KiB memory-model input limit. Text no larger than
16 KiB becomes `clear` evidence linked to a deterministic queued candidate only
after it passes the secret, PII, prompt-transcript, raw-log, and sensitive-path
gates. The structured PII checks cover email addresses, U.S. Social Security
numbers, Luhn-valid payment card numbers, plus-prefixed international and North
American formatted phone numbers, Chinese mobile 3-4-4 groupings, common U.K.
local groupings, labeled 7-to-15-digit phone numbers, and Chinese resident
identity numbers with a calendar-valid birth date and valid checksum. Sensitive
content creates only a bodyless tombstone, and a sensitive path
is replaced by a stable path hash.

The immutable GitHub tree manifest sets `safe_path` to null for every sensitive
tombstone; only its path digest, blob SHA, byte size, and disposition remain.
Binary and generated blobs keep explicit excluded dispositions so the complete
tree can be reconciled without sending their bodies to a model.

A text source that becomes binary, generated, or sensitive is recorded as a
`withdrawn` delta rather than being disguised as a deletion or ordinary change.
The withdrawal evidence has an independent deterministic identity, a null
`repository_path`, no content, and a locator containing only repository,
commit, manifest, and path digests. The old clear evidence is never converted to
a tombstone or overwritten. Only active or contested memories whose current
revision still cites that clear source receive a bodyless pending maintainer
review. A same-SHA recovery to text reuses the stable clear identity; sensitive
tombstones use a separate classification identity, so both records remain
immutable.

Size rejection is not a tombstone path. Text from 16 KiB plus one byte through
64 KiB fails the run with `GITHUB_PARTIAL_SYNC` after retrieval. A text tree
entry larger than 64 KiB fails with the same code before the blob is fetched.
Neither case advances the cursor or partially publishes candidates.

Failure state and immutable lifecycle events never store exception text,
repository content, or a path. They contain only a fixed GitHub synchronization
error code, database-generated timestamps, the original entry count/checksum,
and aggregate chunk count/digest. Each scheduled invocation examines at most 25
staging and 25 failed manifests with stable project/manifest keyset ordering, a
two-manifest per-project quota, and separate durable lane rotation cursors. It
does not fail staging work covered by a live repository-sync lease. After 30
days, a versioned purge token and expiring lease authorize guarded 500-entry
deletion chunks. The chunk event and exact deletion commit in one D1 batch;
terminal state and its event do the same. Every chunk
rechecks the project, token, retention attempt/version, database clock, head, and
both delta directions. Failed claims persist a 12-hour-to-seven-day exponential
retry time. The bodyless `purged` tombstone is written only after no entries
remain. Schema triggers reject this transition for complete manifests, active
heads, synthetic projects, and any manifest referenced by a delta.

Path deletion is not treated as proof that a formal memory is false. The
connector creates bodyless `repository_path_absent` evidence and a pending
maintainer review whose structured analysis lists any affected memory IDs. The
atomic manifest activation batch never changes a formal memory revision or
status directly.

The post-sync `pending_review` cursor transition is also fenced by the exact
active manifest ID in addition to project, repository, ref, and observed commit.
An older event for a different manifest at the same commit is therefore a
no-op and cannot regress a completed newer cursor.

GitHub provenance records the verified repository ID, ref, normalized path, and
one authority value: `default_branch` for the configured default branch or
`tracked_ref` for another explicitly tracked ref. Evidence from a
repository-bound agent session inherits its verified session context and uses
`agent_supplied`; a project-context session does not invent repository
provenance. MCP callers cannot create `github_blob` evidence or override these
provenance fields.

## Model boundary

The model receives opaque, server-generated scope option IDs and evidence
source IDs, not raw project or repository IDs. Options are derived from trusted
normalized provenance. The model must select one offered option and cite only
evidence bound to it; invented options, cross-repository citations, and
unregistered provenance fail closed. A single-repository claim may receive an
advisory project option, but every project-scope proposal requires explicit
maintainer review. The model never grants access, approves a candidate, or
writes formal memory.

## Known release blockers

Do not expose the remote MCP endpoint until:

1. project tokens have been generated, hashed with the production pepper, and
   tested for revocation and cross-project isolation;
2. the initial GitHub subject/repository access baseline has been manually
   approved;
3. remote Workers AI embedding dimension and schema have been verified;
4. force-push, truncated-tree, ETag, rate-limit, and partial-sync behavior have
   passed the remote synthetic canary;
5. synthetic canary cleanup, alerting, and the quality gates pass;
6. the current deployment diff has completed an independent security review;
7. multi-repository tests confirm zero cross-project and cross-repository
   leakage for search, pagination, resources, sessions, and promotion.
