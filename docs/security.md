# Security

## Credential boundaries

- `memory-gateway` receives only its token-digest pepper and page-token HMAC
  key.
- `github-sync` is the only Worker that receives `GITHUB_CLASSIC_TOKEN`.
- `memory-orchestrator` receives D1, R2, Vectorize, Workers AI, Queue, Workflow,
  and Durable Object bindings, but no GitHub or MCP credential.
- `claude-runner` is disabled and receives no D1 write, GitHub, or MCP
  credential.

Secrets are configured through Worker secrets or protected GitHub environment
secrets. Cloudflare resource identifiers and rate-limit namespace identifiers
are protected deployment variables and are rendered only into ignored runtime
configuration. Secret values must never enter the repository, Wrangler vars,
D1, R2, Queue messages, Workflow payloads, logs, exceptions, tests, or model
input.

The tracked `github-sync` configuration is inert: its runtime gate is false, its
Cron Trigger list is empty, and it declares no required credential secret. An
enabled deployment renders all three values explicitly and verifies the remote
schedule plus an exact one-item secret allowlist containing only
`GITHUB_CLASSIC_TOKEN`. A disabled transition deploys the runtime guard
before deleting the Cloudflare secret, then verifies that both the Cron list and
the complete Worker secret list are empty. The scheduled handler checks the runtime gate
before any D1, GitHub, or token access. GitHub environment-secret deletion and
PAT revocation remain explicit operator actions after reconciliation.

The protected `MEMORY_GATEWAY_EXPECTED_HOST` deployment variable contains only
the exact public hostname. Before any deployment write, the workflow requires
the public URL to be an HTTPS `/mcp` endpoint on that host. The same pin is
passed to the bearer-bearing canary but not to the Wrangler renderer or custom
route configuration, including when the gateway uses `workers.dev`.

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
- accepts only allowlisted repository metadata, ref, commit, tree, and blob
  paths;
- uses `redirect: "manual"` and rejects every redirect;
- verifies both repository and owner numeric IDs before accessing refs or
  content; owner/name are routing labels only;
- synchronizes the configured default branch in addition to explicit tracked
  refs and fails closed on an unreviewed default-branch rename;
- requires a successful `/user` response to include a strictly formatted
  `GitHub-Authentication-Token-Expiration` header and fails closed before
  repository enumeration when it is missing, malformed, or expired;
- enforces per-blob, file-count, and total-byte limits; and
- enforces a shared 900-request invocation budget before issuing each request,
  with exhaustion reported as `GITHUB_PARTIAL_SYNC`.

A PAT (classic) with `repo` scope is not truly read-only. If stolen, it can
exercise the full scope outside EdgeMneme. The accepted design therefore
requires a short expiration, explicit repository-ID baseline approval, alerts
for access expansion, and immediate revocation during rotation.

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
