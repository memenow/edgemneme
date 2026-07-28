# MCP API

The public endpoint is `/mcp` over Streamable HTTP. A new `McpServer` and
transport are created for every request.

## Authentication

Send one revocable project token:

```http
Authorization: Bearer <project-token>
```

Tokens are not accepted in URLs, query strings, tool arguments, or cookies.
Browser-origin requests must match the configured `ALLOWED_ORIGINS` list.

The token identifies one principal and project. Active D1 grants determine
whether that principal is project-wide or limited to a repository. A project is
a hard boundary: no tool or resource resolves data from another project.

## Tools

| Tool | Required role | Purpose |
| --- | --- | --- |
| `project_resolve` | reader | Resolve an authorized locator |
| `session_open` | project or repository writer | Open an agent/worktree session in an authorized context |
| `memory_search` | project or repository reader | Search or browse authorized current memory heads |
| `candidate_submit` | writer in the session context | Submit evidence-linked candidate content |
| `memory_change_submit` | project maintainer | Correct, invalidate, or roll back with CAS and target-bound evidence |
| `candidate_review` | project maintainer | Record a candidate review decision with CAS |
| `session_close` | writer in the session context | Close a session and optionally request consolidation |
| `workflow_get` | project reader | Read durable workflow status |

Query mode defaults to five results and is capped at ten. Browse mode is capped
at fifty. Pagination is keyset-based and uses an opaque HMAC token; offset
pagination and server-side cursor sessions are not supported.

### Repository-bound sessions

`session_open.worktree_meta` accepts only normalized repository context:

```json
{
  "repository_id": "00000000-0000-4000-8000-000000000000",
  "repository_ref": "refs/heads/main",
  "worktree_id": "worktree-name"
}
```

`ref` is accepted as an alias for `repository_ref`; if both are present, they
must be identical. A ref or worktree ID requires `repository_id`. A
repository-scoped writer must identify a repository covered by its grant. The
session's normalized repository context is immutable after creation.

`candidate_submit` does not accept caller-selected repository provenance.
For a repository-bound session, manual evidence inherits the verified session
repository, is marked `agent_supplied`, and has a repository-namespaced locator.
A project-context session does not invent repository provenance. GitHub evidence
can be created only by `github-sync`.

Without `session_id`, a project reader searches every registered repository,
while a repository reader receives project memory plus its authorized
repository memory. With `session_id`, both query and browse modes intersect the
grant with the session repository. Page tokens are bound to the principal,
session, and resolved repository ceiling and cannot be replayed in a wider
context.

### Formal memory scope IDs

`project`, `repository`, and `session` scopes use the corresponding D1 entity ID
directly. `ref` and `worktree` scopes use canonical compound IDs:

```text
repository:{encoded_repository_id}:ref:{encoded_ref}
session:{encoded_session_id}:worktree:{encoded_worktree_id}
```

Each component uses UTF-8 URI-component encoding equivalent to JavaScript
`encodeURIComponent`, including uppercase hexadecimal escapes. Components must
be nonempty, have no leading or trailing whitespace, and contain no NUL bytes.
The submitted value must round-trip to the exact same canonical string.

A `ref` scope is accepted only when its project, repository, and ref match an
existing `sync_cursors` row. A `worktree` scope is accepted only when its project
and session match an existing session whose `worktree_meta` object contains the
same string `worktree_id`. Callers should therefore include `worktree_id` when
opening a session that will own worktree-scoped memory.

### Formal memory changes

`memory_change_submit` accepts `correct`, `invalidate`, or `rollback` for one
target memory and requires both the expected memory version and expected project
version. The caller does not select repository provenance for the change. The
gateway resolves the target's canonical scope and repository context from D1,
and the project coordinator independently reloads and verifies the same context
before checking idempotency or executing the guarded batch.

For a non-project target, each submitted evidence locator is server-namespaced
with the canonical target repository and exact scope/scope ID. The evidence row
receives the target repository, any trusted exact ref, a null repository path,
and `agent_supplied` authority. For a project target, the locator is namespaced
to the project and scope while repository ID, ref, path, and authority remain
null. Caller-supplied repository fields cannot replace these values. Existing
evidence is reused only when its immutable identity and repository context match
the derived values. Missing or inconsistent target ownership, or an incompatible
evidence collision, fails without creating a revision or evidence row; a raced
immutable-evidence conflict is returned as `VALIDATION_FAILED`.

## Resources

The server exposes read-only templates under the custom `memory:` URI scheme:

```text
memory://projects/{project_ref}/manifest
memory://projects/{project_ref}/indexes/by-kind/{kind}
memory://projects/{project_ref}/indexes/by-class/{memory_class}
memory://projects/{project_ref}/memories/{memory_id}
memory://projects/{project_ref}/memories/{memory_id}/versions/{version}
memory://projects/{project_ref}/candidates/{candidate_id}
memory://projects/{project_ref}/evidence/{evidence_id}
memory://projects/{project_ref}/workflows/{workflow_id}
memory://projects/{project_ref}/audit/{audit_id}
```

Every resource read rechecks the authenticated project before loading content.
Project manifests, classification indexes, candidates, evidence, workflows,
and audit records require a project-wide reader grant. Current and historical
memory resources use the hierarchical ACL: a repository reader can read project
memory and memory owned by its repository, but receives
`RESOURCE_UNAVAILABLE` for memory owned by another repository. This preserves
resource non-disclosure while keeping the project snapshot a project-only view.

Candidate approval validates structured edits and evidence, then performs the
formal revision, head, audit, idempotency, outbox, and project-version changes in
one guarded D1 batch. A non-project scope must resolve to one normalized
repository, and evidence or session provenance from another repository rejects
the approval. Only a project maintainer may generalize evidence into project
memory. Rejection and request-changes decisions are immutable and audited.
Session consolidation freezes its input set, accepts only schema-validated model
suggestions that select a server-generated opaque scope option and cite its
frozen evidence subset, and creates `pending_review` candidates. A model never
authorizes access, approves a candidate, or writes formal memory directly.

## Errors

Tool failures return a JSON text body with:

```json
{
  "code": "VERSION_CONFLICT",
  "message": "The expected version is stale.",
  "retryable": false,
  "request_id": "..."
}
```

Public codes are `UNAUTHENTICATED`, `PROJECT_UNAVAILABLE`,
`RESOURCE_UNAVAILABLE`, `VALIDATION_FAILED`, `VERSION_CONFLICT`,
`IDEMPOTENCY_CONFLICT`, `PAGE_TOKEN_INVALID`, `RATE_LIMITED`,
`WORKFLOW_FAILED`, and `INTERNAL`.
