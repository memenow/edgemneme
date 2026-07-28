import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { errorBody, EdgeMnemeError } from "../../src/contracts/errors";
import {
  MEMORY_CLASSES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES
} from "../../src/contracts/taxonomy";
import { GatewayService, type GatewayEnv } from "../../src/gateway/service";
import {
  authenticateProjectBearer,
  validateOrigin,
  type AuthenticatedPrincipal
} from "../../src/security/auth";

interface Env extends GatewayEnv {
  TOKEN_DIGEST_PEPPER: string;
  ALLOWED_ORIGINS: string;
  MCP_EDGE_LIMITER: RateLimit;
  MCP_CLIENT_LIMITER: RateLimit;
  MCP_PRINCIPAL_LIMITER: RateLimit;
}

const projectRef = z.string().min(8).max(256);
const identifier = z.string().uuid();
const idempotencyKey = z.string().min(8).max(256);
const repositoryContextValue = z.string().min(1).max(2048).refine(
  (value) => value.trim() === value && !value.includes("\0"),
  "Repository context values must be normalized."
);
const worktreeMeta = z
  .object({
    repository_id: identifier.optional(),
    repository_ref: repositoryContextValue.optional(),
    ref: repositoryContextValue.optional(),
    worktree_id: repositoryContextValue.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.repository_ref !== undefined &&
      value.ref !== undefined &&
      value.repository_ref !== value.ref
    ) {
      context.addIssue({
        code: "custom",
        message: "repository_ref and ref must identify the same repository ref."
      });
    }
    if (
      value.repository_id === undefined &&
      (value.repository_ref !== undefined ||
        value.ref !== undefined ||
        value.worktree_id !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Repository ref and worktree metadata require repository_id."
      });
    }
  });
const evidence = z.array(
  z.object({
    source_type: z.string().min(1).max(64),
    locator: z.string().min(1).max(2048),
    commit_sha: z.string().regex(/^[A-Fa-f0-9]{40,64}$/u).optional(),
    excerpt_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/u).optional()
  })
).min(1).max(50);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const url = new URL(request.url);
      if (url.pathname !== "/mcp") {
        return new Response("Not Found", { status: 404 });
      }
      validateOrigin(request, env.ALLOWED_ORIGINS);
      const edgeLimit = await env.MCP_EDGE_LIMITER.limit({ key: "/mcp" });
      const clientLimit = await env.MCP_CLIENT_LIMITER.limit({
        key: request.headers.get("cf-connecting-ip") ?? "unidentified-client"
      });
      if (!edgeLimit.success || !clientLimit.success) {
        throw new EdgeMnemeError("RATE_LIMITED", "The request rate limit was exceeded.", {
          retryable: true,
          retryAfterMs: 60_000
        });
      }
      const principal = await authenticateProjectBearer(
        request,
        env.MEMORY_DB,
        env.TOKEN_DIGEST_PEPPER
      );
      const principalLimit = await env.MCP_PRINCIPAL_LIMITER.limit({
        key: `${principal.projectId}:${principal.principalId}`
      });
      if (!principalLimit.success) {
        throw new EdgeMnemeError("RATE_LIMITED", "The request rate limit was exceeded.", {
          retryable: true,
          retryAfterMs: 60_000
        });
      }
      const server = createServer(env, principal, requestId);
      return await createMcpHandler(server, {
        route: "/mcp",
        enableJsonResponse: true
      })(request, env, ctx);
    } catch (error) {
      const body = errorBody(error, requestId);
      const status =
        error instanceof EdgeMnemeError
          ? error.code === "UNAUTHENTICATED"
            ? 401
            : error.code === "RATE_LIMITED"
              ? 429
              : 500
          : 500;
      return Response.json(body, {
        status,
        headers: { "cache-control": "no-store" }
      });
    }
  }
} satisfies ExportedHandler<Env>;

function createServer(
  env: Env,
  principal: AuthenticatedPrincipal,
  requestId: string
): McpServer {
  const server = new McpServer({
    name: "EdgeMneme",
    version: "2026-07-25",
    description: "Shared project memory with evidence, versioning, and review controls."
  });
  const service = new GatewayService(env, principal);

  server.registerTool(
    "project_resolve",
    {
      description: "Resolve an authorized project locator.",
      inputSchema: { locator: z.string().min(1).max(2048) }
    },
    ({ locator }) => callTool(() => service.resolveProject(locator), requestId)
  );

  server.registerTool(
    "session_open",
    {
      description: "Open an agent session in an authorized project.",
      inputSchema: {
        project_ref: projectRef,
        agent_meta: z.record(z.string(), z.unknown()),
        worktree_meta: worktreeMeta.optional()
      }
    },
    ({ project_ref, agent_meta, worktree_meta }) =>
      callTool(
        () =>
          service.openSession({
            projectRef: project_ref,
            agentMeta: agent_meta,
            ...(worktree_meta === undefined ? {} : { worktreeMeta: worktree_meta })
          }),
        requestId
      )
  );

  server.registerTool(
    "memory_search",
    {
      description: "Search current authorized memory heads or browse by taxonomy.",
      inputSchema: {
        project_ref: projectRef,
        session_id: identifier.optional(),
        query: z.string().max(4096).optional(),
        filters: z
          .object({
            kind: z.enum(MEMORY_KINDS).optional(),
            memory_class: z.enum(MEMORY_CLASSES).optional(),
            scope: z.enum(MEMORY_SCOPES).optional(),
            scope_id: z.string().min(1).max(2048).optional(),
            status: z.enum(MEMORY_STATUSES).optional()
          })
          .default({}),
        limit: z.number().int().positive().max(50).optional(),
        page_token: z.string().max(4096).optional()
      }
    },
    ({ project_ref, session_id, query, filters, limit, page_token }) =>
      callTool(
        () => {
          const normalizedFilters = Object.fromEntries(
            Object.entries(filters).filter((entry): entry is [string, string] =>
              typeof entry[1] === "string"
            )
          );
          return service.search({
            projectRef: project_ref,
            filters: normalizedFilters,
            ...(query === undefined ? {} : { query }),
            ...(limit === undefined ? {} : { limit }),
            ...(page_token === undefined ? {} : { pageToken: page_token }),
            ...(session_id === undefined ? {} : { sessionId: session_id })
          });
        },
        requestId
      )
  );

  server.registerTool(
    "candidate_submit",
    {
      description: "Submit an evidence-linked candidate for asynchronous quality review.",
      inputSchema: {
        project_ref: projectRef,
        session_id: identifier,
        content: z.string().min(1).max(65_536),
        evidence,
        idempotency_key: idempotencyKey
      }
    },
    ({ project_ref, session_id, content, evidence: candidateEvidence, idempotency_key }) =>
      callTool(
        () =>
          service.submitCandidate({
            projectRef: project_ref,
            sessionId: session_id,
            content,
            evidence: candidateEvidence,
            idempotencyKey: idempotency_key
          }),
        requestId
      )
  );

  server.registerTool(
    "memory_change_submit",
    {
      description: "Submit a maintainer correction, invalidation, or rollback using CAS.",
      inputSchema: {
        operation: z.enum(["correct", "invalidate", "rollback"]),
        target_memory_id: identifier,
        expected_memory_version: z.number().int().positive(),
        expected_project_version: z.number().int().nonnegative(),
        payload: z.record(z.string(), z.unknown()),
        evidence,
        idempotency_key: idempotencyKey
      }
    },
    (input) => callTool(() => service.submitMemoryChange(input), requestId)
  );

  server.registerTool(
    "candidate_review",
    {
      description: "Review a candidate as a project maintainer using CAS.",
      inputSchema: {
        candidate_id: identifier,
        expected_candidate_version: z.number().int().positive(),
        decision: z.enum(["approve", "reject", "request_changes"]),
        reason: z.string().min(1).max(4096),
        edits: z
          .object({
            content: z.string().min(1).max(65_536).optional(),
            kind: z.enum(MEMORY_KINDS).optional(),
            memory_class: z.enum(MEMORY_CLASSES).optional(),
            scope: z.enum(MEMORY_SCOPES).optional(),
            scope_id: z.string().min(1).max(2048).optional(),
            valid_from: z.iso.datetime({ offset: true }).nullable().optional(),
            valid_until: z.iso.datetime({ offset: true }).nullable().optional()
          })
          .strict()
          .optional(),
        idempotency_key: idempotencyKey
      }
    },
    ({
      candidate_id,
      expected_candidate_version,
      decision,
      reason,
      edits,
      idempotency_key
    }) =>
      callTool(
        () =>
          service.reviewCandidate({
            candidateId: candidate_id,
            expectedCandidateVersion: expected_candidate_version,
            decision,
            reason,
            idempotencyKey: idempotency_key,
            ...(edits === undefined ? {} : { edits })
          }),
        requestId
      )
  );

  server.registerTool(
    "session_close",
    {
      description: "Close a session using CAS and optionally request consolidation.",
      inputSchema: {
        session_id: identifier,
        expected_session_version: z.number().int().positive(),
        summary: z.string().max(8192).optional(),
        trigger_consolidation: z.boolean(),
        idempotency_key: idempotencyKey
      }
    },
    ({
      session_id,
      expected_session_version,
      summary,
      trigger_consolidation,
      idempotency_key
    }) =>
      callTool(
        () =>
          service.closeSession({
            sessionId: session_id,
            expectedSessionVersion: expected_session_version,
            triggerConsolidation: trigger_consolidation,
            idempotencyKey: idempotency_key,
            ...(summary === undefined ? {} : { summary })
          }),
        requestId
      )
  );

  server.registerTool(
    "workflow_get",
    {
      description: "Read the durable status of a project workflow.",
      inputSchema: {
        project_ref: projectRef,
        workflow_id: z.string().min(8).max(256)
      }
    },
    ({ project_ref, workflow_id }) =>
      callTool(() => service.getWorkflow(project_ref, workflow_id), requestId)
  );

  registerResources(server, service, requestId);
  return server;
}

function registerResources(
  server: McpServer,
  service: GatewayService,
  requestId: string
): void {
  const templates = [
    ["project-manifest", "memory://projects/{project_ref}/manifest"],
    ["kind-index", "memory://projects/{project_ref}/indexes/by-kind/{kind}"],
    ["class-index", "memory://projects/{project_ref}/indexes/by-class/{memory_class}"],
    ["memory-head", "memory://projects/{project_ref}/memories/{memory_id}"],
    [
      "memory-version",
      "memory://projects/{project_ref}/memories/{memory_id}/versions/{version}"
    ],
    ["candidate", "memory://projects/{project_ref}/candidates/{candidate_id}"],
    ["evidence", "memory://projects/{project_ref}/evidence/{evidence_id}"],
    ["workflow", "memory://projects/{project_ref}/workflows/{workflow_id}"],
    ["audit", "memory://projects/{project_ref}/audit/{audit_id}"]
  ] as const;
  for (const [name, template] of templates) {
    server.registerResource(
      name,
      new ResourceTemplate(template, { list: undefined }),
      {
        description: `Read the ${name.replaceAll("-", " ")} for an authorized project.`,
        mimeType: "application/json"
      },
      async (uri, variables) => {
        try {
          const values = Object.fromEntries(
            Object.entries(variables).map(([key, value]) => [
              key,
              Array.isArray(value) ? String(value[0] ?? "") : String(value)
            ])
          );
          const text = await service.readResource(uri, values);
          return { contents: [{ uri: uri.toString(), mimeType: "application/json", text }] };
        } catch (error) {
          const body = errorBody(error, requestId);
          throw new Error(JSON.stringify(body));
        }
      }
    );
  }
}

async function callTool(
  callback: () => Promise<Record<string, unknown>>,
  requestId: string
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  try {
    const result = await callback();
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify(errorBody(error, requestId)) }],
      isError: true
    };
  }
}
